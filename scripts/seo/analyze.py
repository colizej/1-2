#!/usr/bin/env python
"""
Разбор выгрузок GSC / GA4 / Метрики / Bing: что у сайта сильного, что сломано
и где лежат быстрые победы.

Ничего никуда не ходит по сети, кроме sitemap.xml — работает по CSV, которые уже
сложили fetch_*.py. Поэтому порядок такой:

    python scripts/seo/fetch_gsc.py --days 28
    python scripts/seo/fetch_ga4.py --days 28
    python scripts/seo/fetch_metrika.py --days 28
    python scripts/seo/analyze.py

Отчёт печатается в консоль и сохраняется в docs/analytics/reports/<дата>.md,
чтобы через месяц было с чем сравнить. Отключить сохранение: --no-save.

Пороги намеренно завязаны на средние самого сайта, а не на «правильные» числа из
статей: CTR 2% — беда для запроса на первой позиции и норма для десятой.
"""

import argparse
import csv
import re
import subprocess
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA = REPO_ROOT / "docs" / "analytics" / "data"
REPORTS = REPO_ROOT / "docs" / "analytics" / "reports"
SITE = "https://odin-dva.ru"

# Сколько показов должно набраться, чтобы вывод про CTR или позицию что-то значил.
MIN_IMPRESSIONS = 200
# Насколько CTR должен отставать от ожидаемого для СВОЕЙ позиции, чтобы считать
# это проблемой. Сравнение с общим средним по сайту врёт: страница на девятой
# позиции всегда будет ниже среднего, и без поправки на позицию отчёт записывает
# в «сломанные заголовки» те страницы, которым просто не хватает позиций.
CTR_GAP = 0.6
# Позиции, с которых рост даёт максимум кликов: уже близко, но ещё не в топе.
STRIKING_RANGE = (4.0, 15.0)


def latest_dir(source, sub=None):
    """Самая свежая выгрузка источника. Папки названы по дате, сортировки хватает."""
    root = DATA / source
    if not root.exists():
        return None
    if sub:
        root = root / sub
    else:
        subs = [d for d in root.iterdir() if d.is_dir()]
        if not subs:
            return None
        root = sorted(subs)[-1]
    runs = [d for d in root.iterdir() if d.is_dir()]
    return sorted(runs)[-1] if runs else None


def read_csv(path):
    if not path or not path.exists():
        return []
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def num(row, key, default=0.0):
    try:
        return float(row.get(key, default) or 0)
    except (TypeError, ValueError):
        return default


def norm_url(url):
    """Без якоря и без хвостового слеша. GSC отдаёт `/page/#section` отдельной
    строкой — это ссылки-переходы к разделу, которые Google рисует в сниппете, а не
    самостоятельные страницы. Без склейки одна статья превращается в отчёте в три
    «страницы с нулевым CTR» и в фальшивую каннибализацию сама с собой."""
    return re.sub(r"#.*$", "", url).rstrip("/")


def agg_rows(rows, keys):
    """Суммирует строки GSC по ключу. Позиция — средняя, взвешенная по показам:
    простое среднее завысило бы вклад строк, которые почти не показывались."""
    acc = {}
    for r in rows:
        k = tuple(norm_url(r[x]) if x == "page" else r[x] for x in keys)
        a = acc.setdefault(k, {"clicks": 0.0, "impressions": 0.0, "_pos": 0.0})
        impr = num(r, "impressions")
        a["clicks"] += num(r, "clicks")
        a["impressions"] += impr
        a["_pos"] += num(r, "position") * impr
    out = []
    for k, a in acc.items():
        row = dict(zip(keys, k))
        row["clicks"] = a["clicks"]
        row["impressions"] = a["impressions"]
        row["ctr"] = a["clicks"] / a["impressions"] * 100 if a["impressions"] else 0.0
        row["position"] = a["_pos"] / a["impressions"] if a["impressions"] else 0.0
        out.append(row)
    return out


def ctr_curve(rows):
    """CTR по позициям на данных самого сайта: {бакет: CTR}. Это и есть честный
    бенчмарк — тематика, язык и вид выдачи у всех страниц одни и те же."""
    buckets = defaultdict(lambda: [0.0, 0.0])
    for r in rows:
        b = pos_bucket(num(r, "position"))
        buckets[b][0] += num(r, "clicks")
        buckets[b][1] += num(r, "impressions")
    return {b: (c / i * 100 if i else 0.0) for b, (c, i) in buckets.items()}


def pos_bucket(p):
    return int(p) if p < 11 else (15 if p < 16 else 20)


def short(url, width=58):
    """URL без домена — в отчёте важен путь, а не повторяющийся хост."""
    p = re.sub(r"^https?://[^/]+", "", url)
    return p if len(p) <= width else p[: width - 1] + "…"


def fetch(url, timeout=30):
    out = subprocess.run(["curl", "-sL", "--max-time", str(timeout), url],
                         capture_output=True, text=True)
    return out.stdout if out.returncode == 0 else ""


def sitemap_paths():
    xml = fetch(f"{SITE}/sitemap.xml")
    locs = re.findall(r"<loc>([^<]+)</loc>", xml)
    if locs and all(l.endswith(".xml") for l in locs[:3]):
        pages = []
        for child in locs:
            pages += re.findall(r"<loc>([^<]+)</loc>", fetch(child))
        locs = pages
    return {re.sub(r"^https?://[^/]+", "", u).rstrip("/") or "/" for u in locs}


class Report:
    """Собирает разделы, потом печатает и сохраняет одним куском."""

    def __init__(self):
        self.blocks = []

    def add(self, title, lines):
        if not lines:
            return
        # Таблица, у которой после разделителя нет ни строки, — это «ничего не
        # нашлось». Печатать пустую шапку хуже, чем не печатать раздел совсем:
        # пустая таблица читается как поломка отчёта.
        for i, line in enumerate(lines):
            if str(line).startswith("|---") and i == len(lines) - 1:
                return
        self.blocks.append((title, lines))

    def render(self):
        out = []
        for title, lines in self.blocks:
            out.append(f"\n## {title}\n")
            out += lines
        return "\n".join(out)


def analyze_gsc(rep):
    d = latest_dir("gsc")
    if not d:
        print("  GSC: выгрузки нет — сначала python scripts/seo/fetch_gsc.py")
        return None
    pages = agg_rows(read_csv(d / "pages.csv"), ["page"])
    queries = read_csv(d / "queries.csv")
    dates = read_csv(d / "dates.csv")
    devices = read_csv(d / "devices.csv")
    qp = agg_rows(read_csv(d / "query_page.csv"), ["query", "page"])

    clicks = sum(num(r, "clicks") for r in pages)
    impr = sum(num(r, "impressions") for r in pages)
    avg_ctr = clicks / impr * 100 if impr else 0
    curve = ctr_curve(qp)

    def expected_ctr(position):
        return curve.get(pos_bucket(position), 0.0)
    lines = [
        f"- Период выгрузки: `{d.name}`",
        f"- **{int(clicks)} кликов**, {int(impr)} показов, средний CTR **{avg_ctr:.2f}%**",
    ]
    # GSC не отдаёт разбивку, когда данных слишком мало: суммарные цифры за период
    # есть, а строк по страницам и запросам — ноль. Без этой оговорки отчёт читается
    # как «трафика нет вообще», хотя в TREND.md стоит ненулевой итог.
    daily_clicks = sum(num(r, "clicks") for r in dates)
    daily_impr = sum(num(r, "impressions") for r in dates)
    if not pages and (daily_clicks or daily_impr):
        lines.append(
            f"- ⚠ Постранично GSC не отдал ни строки, хотя по дням набирается"
            f" {int(daily_clicks)} кликов и {int(daily_impr)} показов. Это порог"
            " приватности: разбивку Google скрывает, пока цифры маленькие."
            " Итог за период смотреть в `TREND.md`, разделы ниже на таких данных"
            " не считаются."
        )
    rep.add("Поиск Google — общее", lines)

    # Ниже почти все пороги рассчитаны на сотни кликов. Честнее сказать это вслух,
    # чем печатать пустые таблицы, которые выглядят как «ничего не нашлось».
    if impr < MIN_IMPRESSIONS:
        rep.add("Данных мало", [
            f"- За период {int(impr)} показов при пороге в {MIN_IMPRESSIONS}."
            " Разделы про CTR, каннибализацию и запросы у порога топа ниже"
            " ничего не покажут — не потому что всё хорошо, а потому что считать"
            " не из чего.",
            "- Пока сайт на таких объёмах, единственные осмысленные цифры —"
            " индексация (`--inspect`) и доступность самих страниц.",
        ])

    # Тренд: первая половина периода против второй.
    if len(dates) >= 8:
        half = len(dates) // 2
        a = sum(num(r, "clicks") for r in dates[:half])
        b = sum(num(r, "clicks") for r in dates[half:])
        delta = (b - a) / a * 100 if a else 0
        verdict = "растёт" if delta > 10 else "падает" if delta < -10 else "ровно"
        rep.add("Динамика внутри периода", [
            f"- Первая половина {int(a)} кликов → вторая {int(b)} ({delta:+.0f}%), {verdict}.",
            "- Внутри одного месяца это ещё не тренд, но если знак повторится в следующем"
            " замере — уже сигнал." if abs(delta) > 10 else
            "- Резких провалов внутри периода нет.",
        ])

    # Сильные страницы: много кликов И CTR выше среднего.
    strong = [r for r in pages
              if num(r, "clicks") >= 20 and num(r, "ctr") > avg_ctr]
    strong.sort(key=lambda r: -num(r, "clicks"))
    rep.add("Что работает", [
        "Страницы, которые и трафик дают, и кликаются лучше среднего по сайту"
        f" (CTR > {avg_ctr:.2f}%). Это опоры — их логику стоит повторять, а сами"
        " страницы не трогать без причины.\n",
        "| Страница | Клики | Показы | CTR | Поз. |",
        "|---|---|---|---|---|",
    ] + [
        f"| `{short(r['page'])}` | {int(num(r,'clicks'))} | {int(num(r,'impressions'))} "
        f"| {num(r,'ctr'):.2f}% | {num(r,'position'):.1f} |"
        for r in strong[:8]
    ])

    # Кривая CTR сайта против общепринятых ориентиров.
    rep.add("CTR по позициям — бенчмарк сайта", [
        "Считается по парам «запрос × страница» и дальше служит эталоном: у страницы"
        " спрашивается не «выше ли она среднего по сайту», а «выбивает ли она свою"
        " позицию».\n",
        "| Позиция | CTR сайта |",
        "|---|---|",
    ] + [
        f"| {({15: '11-15', 20: '16+'}).get(b, b)} | {v:.2f}% |"
        for b, v in sorted(curve.items()) if v or b < 11
    ])

    # Проблема №1: страница недобирает клики относительно СВОЕЙ позиции.
    # Именно это, а не низкий CTR сам по себе, указывает на заголовок и описание.
    weak = []
    for r in pages:
        exp = expected_ctr(num(r, "position"))
        if num(r, "impressions") < MIN_IMPRESSIONS or exp <= 0:
            continue
        if num(r, "ctr") < exp * CTR_GAP:
            r["_exp"] = exp
            r["_lost"] = num(r, "impressions") * (exp - num(r, "ctr")) / 100
            weak.append(r)
    weak.sort(key=lambda r: -r["_lost"])
    if weak:
        rep.add("Проблема: показы есть, кликов нет", [
            f"Страницы с {MIN_IMPRESSIONS}+ показов, чей CTR ниже {int(CTR_GAP*100)}% от"
            " ожидаемого **для их собственной позиции**. Позиция у них не хуже, чем у"
            " остальных страниц сайта, — значит дело в том, как выглядит сниппет:"
            " заголовок, описание, совпадение с формулировкой запроса. Колонка «недобор»"
            " — сколько кликов дал бы обычный для этой позиции CTR.\n",
            "| Страница | Показы | CTR | Ожид. | Поз. | Недобор |",
            "|---|---|---|---|---|---|",
        ] + [
            f"| `{short(r['page'], 50)}` | {int(num(r,'impressions'))} | {num(r,'ctr'):.2f}% "
            f"| {r['_exp']:.2f}% | {num(r,'position'):.1f} | ~{int(r['_lost'])} |"
            for r in weak[:10]
        ])

    # Быстрые победы: запросы у порога топа.
    near = [r for r in queries
            if STRIKING_RANGE[0] <= num(r, "position") <= STRIKING_RANGE[1]
            and num(r, "impressions") >= 100]
    near.sort(key=lambda r: -num(r, "impressions"))
    if near:
        rep.add("Возможности: запросы у порога топа", [
            f"Позиция {STRIKING_RANGE[0]:.0f}–{STRIKING_RANGE[1]:.0f} при 100+ показов."
            " Тут дешевле всего расти: страница уже ранжируется, ей не хватает"
            " доработки текста и внутренних ссылок, а не нового материала.\n",
            "| Запрос | Показы | Клики | Поз. |",
            "|---|---|---|---|",
        ] + [
            f"| {r['query'][:52]} | {int(num(r,'impressions'))} | {int(num(r,'clicks'))} "
            f"| {num(r,'position'):.1f} |"
            for r in near[:12]
        ])

    # Каннибализация: один запрос тянут несколько страниц.
    by_query = defaultdict(list)
    for r in qp:
        if num(r, "impressions") >= 50:
            by_query[r["query"]].append(r)
    cannibal = []
    for q, rows in by_query.items():
        if len(rows) < 2:
            continue
        rows.sort(key=lambda r: -num(r, "impressions"))
        # Вторая страница должна быть заметной, иначе это шум.
        if (num(rows[1], "impressions") >= num(rows[0], "impressions") * 0.3
                and len({r["page"] for r in rows}) > 1):
            cannibal.append((q, rows))
    cannibal.sort(key=lambda x: -sum(num(r, "impressions") for r in x[1]))
    if cannibal:
        lines = [
            "По одному запросу Google показывает несколько твоих страниц. Они делят между"
            " собой сигналы и мешают друг другу подняться. Лечится склейкой: слабую"
            " страницу — 301 на сильную, либо развести их по разным темам.\n"
        ]
        for q, rows in cannibal[:6]:
            lines.append(f"- **{q}** ({int(sum(num(r,'impressions') for r in rows))} показов)")
            for r in rows[:3]:
                lines.append(
                    f"  - `{short(r['page'], 62)}` — {int(num(r,'impressions'))} показов,"
                    f" поз. {num(r,'position'):.1f}"
                )
        rep.add("Проблема: каннибализация запросов", lines)

    # Мобильные против десктопа: если позиции сильно расходятся — это техника.
    dev = {r["device"]: r for r in devices}
    if "MOBILE" in dev and "DESKTOP" in dev:
        m, p = dev["MOBILE"], dev["DESKTOP"]
        gap = num(p, "position") - num(m, "position")
        share = num(m, "clicks") / max(clicks, 1) * 100
        rep.add("Мобильные и десктоп", [
            f"- Мобильных кликов {int(num(m,'clicks'))} из {int(clicks)} — **{share:.0f}%**"
            f" всего трафика, CTR {num(m,'ctr'):.2f}% против {num(p,'ctr'):.2f}% на десктопе.",
            f"- Позиция: {num(m,'position'):.1f} мобильная, {num(p,'position'):.1f} десктопная"
            f" (разрыв {gap:+.1f}).",
            "- Разрыв больше двух позиций — повод проверить скорость и вёрстку на телефоне."
            if abs(gap) > 2 else
            "- Разрыв в пределах нормы, отдельной мобильной проблемы не видно.",
        ])
    return {"pages": pages, "avg_ctr": avg_ctr, "clicks": clicks, "impressions": impr}


def analyze_sitemap(rep, gsc):
    """Страницы из sitemap, которые за период не получили ни одного показа."""
    if not gsc:
        return
    paths = sitemap_paths()
    if not paths:
        return
    seen = {short(r["page"], 500).rstrip("/") or "/" for r in gsc["pages"]}
    dead = sorted(paths - seen)
    if dead:
        rep.add("Проблема: страницы без единого показа", [
            f"В sitemap {len(paths)} адресов, показы за период получили {len(paths) - len(dead)}."
            f" Оставшиеся **{len(dead)}** Google либо не проиндексировал, либо держит так низко,"
            " что они не попадают даже в показы. Проверять точечно:"
            " `python scripts/seo/fetch_gsc.py --inspect 100`.\n",
        ] + [f"- `{p}`" for p in dead[:15]]
        + ([f"- …и ещё {len(dead) - 15}"] if len(dead) > 15 else []))


def analyze_counters(rep, gsc):
    """Метрика и GA4: поведение плюс сверка с GSC."""
    lines = []
    md = latest_dir("metrika")
    gd = latest_dir("ga4")

    visits = users = bounce = 0
    if md:
        dates = read_csv(md / "dates.csv")
        visits = sum(num(r, "visits") for r in dates)
        users = sum(num(r, "users") for r in dates)
        entry = read_csv(md / "landing_pages.csv")
        srcs = read_csv(md / "sources.csv")
        internal = sum(num(r, "visits") for r in srcs
                       if "internal" in r["dimension"].lower())
        bounce = (sum(num(r, "bounce_rate") * num(r, "visits") for r in dates)
                  / visits) if visits else 0
        lines += [
            f"- Метрика: **{int(visits)} визитов**, {int(users)} посетителей,"
            f" отказы {bounce:.1f}%.",
        ]
        if internal:
            lines.append(
                f"- Из них **{int(internal)} визитов — internal traffic**, свои же заходы."
                " Их надо вычитать из любых выводов о трафике."
            )
        bad = [r for r in entry if num(r, "visits") >= 5 and num(r, "bounce_rate") > 45]
        bad.sort(key=lambda r: -num(r, "visits"))
        if bad:
            lines.append("- Страницы входа с отказами выше 45% — заходят и сразу уходят:")
            for r in bad[:6]:
                lines.append(
                    f"  - `{short(r['dimension'], 58)}` — {int(num(r,'visits'))} визитов,"
                    f" отказы {num(r,'bounce_rate'):.0f}%"
                )
    if gd:
        ch = read_csv(gd / "channels.csv")
        sess = sum(num(r, "sessions") for r in ch)
        lines.append(f"- GA4: {int(sess)} сеансов (для сверки со счётчиком Яндекса).")
        if visits and sess:
            diff = abs(sess - visits) / max(sess, visits) * 100
            lines.append(
                f"- Счётчики расходятся на {diff:.0f}% — это норма, разметка у них разная."
                if diff < 25 else
                f"- Счётчики расходятся на {diff:.0f}% — многовато, стоит посмотреть, не"
                " отваливается ли один из них на части страниц."
            )
    # При нулевых кликах «разрыв в 0.0 раза» — бессмысленная фраза; нулевой GSC
    # на фоне живых визитов означает другое: постраничной разбивки просто нет.
    if gsc and visits and gsc["clicks"]:
        ratio = gsc["clicks"] / visits
        lines.append(
            f"- **GSC {int(gsc['clicks'])} кликов против {int(visits)} визитов —"
            f" разрыв в {ratio:.1f} раза.** Часть съедают блокировщики, часть — клики,"
            " после которых страница так и не открылась. Держать в уме при чтении цифр:"
            " спрос считать по GSC, поведение — по счётчикам, складывать их нельзя."
        )
    rep.add("Счётчики: поведение и сверка", lines)

    if md:
        goals = read_csv(md / "goals.csv")
        if goals:
            totals = {k: sum(num(r, k) for r in goals)
                      for k in goals[0] if k != "date"}
            reached = {k: v for k, v in totals.items() if v > 0}
            rep.add("Цели", [
                "- За период сработало: "
                + (", ".join(f"**{k.split(' (')[0]}** — {int(v)}"
                             for k, v in sorted(reached.items(), key=lambda x: -x[1]))
                   if reached else "ни одной цели"),
                f"- Целей настроено {len(totals)}, срабатывали {len(reached)}."
                + (" При таком трафике это статистически ничто — по этим числам нельзя"
                   " судить, работает ли монетизация." if sum(reached.values()) < 20 else ""),
            ])


def analyze_bing(rep):
    d = latest_dir("bing")
    if not d:
        return
    daily = read_csv(d / "daily.csv")
    clicks = sum(num(r, "Clicks") for r in daily)
    impr = sum(num(r, "Impressions") for r in daily)
    if impr == 0:
        rep.add("Bing", [
            "- Данных пока нет. Сайт подтверждён недавно — Bing отдаёт статистику через"
            " несколько дней после верификации. Если через неделю по-прежнему нули,"
            " значит сайта нет в индексе Bing, и это уже проблема: на его выдаче сидят"
            " Ecosia, Yahoo и DuckDuckGo.",
        ])
    else:
        rep.add("Bing", [
            f"- {int(clicks)} кликов, {int(impr)} показов, CTR"
            f" {clicks / impr * 100:.2f}%.",
        ])


def main():
    p = argparse.ArgumentParser(description="Разбор выгрузок аналитики: проблемы и сильные стороны")
    p.add_argument("--no-save", action="store_true", help="не сохранять отчёт в docs/analytics/reports/")
    args = p.parse_args()

    if not DATA.exists():
        sys.exit("Нет ни одной выгрузки. Сначала: python scripts/seo/fetch_gsc.py")

    rep = Report()
    gsc = analyze_gsc(rep)
    analyze_sitemap(rep, gsc)
    analyze_counters(rep, gsc)
    analyze_bing(rep)

    body = (f"# Разбор аналитики odin-dva.ru — {date.today().isoformat()}\n\n"
            "Сгенерирован `scripts/seo/analyze.py` по последним выгрузкам в"
            " `docs/analytics/data/`. Это чтение цифр, а не список задач: решать,"
            " что из этого делать, всё равно тебе.\n"
            + rep.render() + "\n")
    print(body)

    if not args.no_save:
        REPORTS.mkdir(parents=True, exist_ok=True)
        path = REPORTS / f"{date.today().isoformat()}.md"
        path.write_text(body, encoding="utf-8")
        print(f"Сохранено: {path.relative_to(REPO_ROOT)}\n")


if __name__ == "__main__":
    main()
