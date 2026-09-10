#!/usr/bin/env python
"""
Выгрузка метрик Яндекс.Метрики через Reporting API.

Зачем при живых GSC и GA4: сайт нацелен на русскоязычный поиск, а половину этого
трафика даёт Яндекс, которого в GSC нет по определению. Плюс скрипт Google режут
блокировщики чаще метриковского, так что по русским заходам Метрика ближе к правде.

Что делает:
  1. Сводка          — визиты, посетители, отказы, глубина, время на сайте
  2. sources         — источники трафика
  3. search_phrases  — поисковые фразы (в GSC их видно только по Google)
  4. countries       — страны и регионы
  5. landing_pages   — страницы входа
  6. goals           — достижения целей (список целей берётся из API счётчика)

Использование:
    python scripts/seo/fetch_metrika.py
    python scripts/seo/fetch_metrika.py --days 90
    python scripts/seo/fetch_metrika.py --list        # счётчики, доступные токену

Токен берётся из --token → YANDEX_METRIKA_TOKEN → secrets/yandex-metrika-token.txt.
Как получить — docs/analytics/README.md, раздел «Ключи».
"""

import argparse
import csv
import json
import os
import subprocess
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import EXCLUDE_COUNTRIES  # noqa: E402

API = "https://api-metrika.yandex.net"

DEFAULT_COUNTER = "108311751"  # счётчик odin-dva.ru, стоит в index.html

REPO_ROOT = Path(__file__).resolve().parents[2]

# Только внутри репозитория: на соседние проекты не смотрим.
TOKEN_CANDIDATES = [
    "secrets/yandex-metrika-token.txt",
]
OUT_ROOT = REPO_ROOT / "docs" / "analytics" / "data" / "metrika"

METRICS = "ym:s:visits,ym:s:users,ym:s:bounceRate,ym:s:avgVisitDurationSeconds,ym:s:pageviews"

REPORTS = {
    "sources": "ym:s:lastTrafficSource",
    "search_phrases": "ym:s:searchPhrase",
    "countries": "ym:s:regionCountryName",
    "landing_pages": "ym:s:startURLPath",
    "devices": "ym:s:deviceCategory",
    "dates": "ym:s:date",
}


def call(path, token, **params):
    """Запрос к API. curl, а не urllib: на части сборок Python нет системных
    корневых сертификатов и любой https падает на проверке (см. fetch_bing.py)."""
    url = f"{API}{path}"
    args = ["curl", "-sS", "--max-time", "90", "-H", f"Authorization: OAuth {token}", "-G", url]
    for k, v in params.items():
        args += ["--data-urlencode", f"{k}={v}"]
    out = subprocess.run(args, capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"curl вернул {out.returncode}: {out.stderr.strip()[:200]}")
    body = out.stdout.strip()
    if not body:
        raise RuntimeError("пустой ответ")
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        raise RuntimeError(f"ответ не JSON — {body[:200]}")
    if isinstance(data, dict) and "errors" in data:
        msgs = "; ".join(e.get("message", "?") for e in data["errors"])
        raise RuntimeError(f"{data.get('message', 'ошибка API')}: {msgs}")
    return data


def resolve_token(explicit):
    if explicit:
        return explicit
    if os.environ.get("YANDEX_METRIKA_TOKEN"):
        return os.environ["YANDEX_METRIKA_TOKEN"]
    for f in TOKEN_CANDIDATES:
        f = Path(f).expanduser()
        if not f.is_absolute():
            f = REPO_ROOT / f
        if f.exists():
            return f.read_text(encoding="utf-8").strip()
    sys.exit(
        "Не задан OAuth-токен Яндекса.\n"
        "  положить его в secrets/yandex-metrika-token.txt\n"
        "  либо export YANDEX_METRIKA_TOKEN=...\n"
        "Как получить: docs/analytics/README.md, раздел «Ключи»"
    )


def list_counters(token):
    data = call("/management/v1/counters", token, per_page=100)
    counters = data.get("counters", [])
    for c in counters:
        print(f"  {c.get('id')}  {c.get('site')}  ({c.get('name')})")
    if not counters:
        print("  токену не доступен ни один счётчик")


def fetch_goals(token, counter):
    try:
        data = call(f"/management/v1/counter/{counter}/goals", token)
    except RuntimeError as e:
        print(f"  цели не прочитались: {e}")
        return []
    return [(g["id"], g.get("name", "?")) for g in data.get("goals", [])]


def country_filter(include_self):
    """Выражение фильтра Метрики: ym:s:regionCountryName!='Belgium' AND ..."""
    if include_self or not EXCLUDE_COUNTRIES["metrika"]:
        return None
    return " AND ".join(f"ym:s:regionCountryName!='{c}'" for c in EXCLUDE_COUNTRIES["metrika"])


def report(token, counter, dimension, start, end, metrics=METRICS, limit=1000,
           include_self=False):
    params = dict(
        ids=counter, metrics=metrics, dimensions=dimension,
        date1=start.isoformat(), date2=end.isoformat(),
        limit=limit, accuracy="full",
    )
    filters = country_filter(include_self)
    if filters:
        params["filters"] = filters
    data = call("/stat/v1/data", token, **params)
    rows = []
    for r in data.get("data", []):
        name = " / ".join(str(d.get("name") or d.get("id") or "") for d in r["dimensions"])
        rows.append([name] + [round(v, 2) if isinstance(v, float) else v for v in r["metrics"]])
    return rows, data.get("totals", [])


def write_csv(path, header, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)
    return len(rows)


def append_trend(counter_dir, run_date, totals, days):
    path = counter_dir / "TREND.md"
    visits, users, bounce, dur = (totals + [0, 0, 0, 0])[:4]
    row = (f"| {run_date} | {days} | {int(visits)} | {int(users)} | "
           f"{bounce:.1f}% | {int(dur // 60)}:{int(dur % 60):02d} | |\n")
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            f"# Яндекс.Метрика — история замеров: счётчик {counter_dir.name}\n\n"
            "Заполняется скриптом `scripts/seo/fetch_metrika.py`.\n"
            "Колонка «Что меняли» — руками, сразу после запуска.\n\n"
            "| Дата замера | Период (дн.) | Визиты | Посетители | Отказы | Время на сайте | Что меняли |\n"
            "|---|---|---|---|---|---|---|\n",
            encoding="utf-8",
        )
    with open(path, "a", encoding="utf-8") as f:
        f.write(row)
    return path


def main():
    p = argparse.ArgumentParser(description="Выгрузка метрик Яндекс.Метрики")
    p.add_argument("--days", type=int, default=28, help="длина периода в днях (по умолчанию 28)")
    p.add_argument("--counter", default=os.environ.get("YANDEX_METRIKA_ID", DEFAULT_COUNTER))
    p.add_argument("--list", action="store_true", help="показать счётчики, доступные токену")
    p.add_argument("--token", help="OAuth-токен (по умолчанию secrets/yandex-metrika-token.txt)")
    p.add_argument("--include-self", action="store_true",
                   help="не вырезать свои заходы (см. EXCLUDE_COUNTRIES в config.py)")
    args = p.parse_args()

    token = resolve_token(args.token)

    if args.list:
        try:
            list_counters(token)
        except RuntimeError as e:
            sys.exit(f"ОШИБКА: {e}")
        return

    end = date.today() - timedelta(days=1)   # сегодняшний день ещё копится
    start = end - timedelta(days=args.days - 1)
    print(f"\n{'=' * 70}\nЯндекс.Метрика, счётчик {args.counter}\n{'=' * 70}")
    print(f"Период: {start} … {end}")
    if not args.include_self and EXCLUDE_COUNTRIES["metrika"]:
        print(f"Исключено: свои заходы ({', '.join(EXCLUDE_COUNTRIES['metrika'])}) — см. scripts/seo/config.py")

    out_dir = OUT_ROOT / args.counter / f"{end.isoformat()}_{args.days}d"
    header = ["dimension", "visits", "users", "bounce_rate", "avg_duration_sec", "pageviews"]
    totals = []

    try:
        for name, dim in REPORTS.items():
            rows, tot = report(token, args.counter, dim, start, end,
                               include_self=args.include_self)
            totals = tot or totals
            n = write_csv(out_dir / f"{name}.csv", header, rows)
            print(f"  {name:<15} {n:>6} строк → {out_dir.relative_to(REPO_ROOT)}/{name}.csv")

        goals = fetch_goals(token, args.counter)
        if goals:
            metrics = ",".join(f"ym:s:goal{gid}reaches" for gid, _ in goals)
            rows, _ = report(token, args.counter, "ym:s:date", start, end, metrics=metrics,
                             include_self=args.include_self)
            n = write_csv(out_dir / "goals.csv",
                          ["date"] + [f"{name} ({gid})" for gid, name in goals], rows)
            print(f"  {'goals':<15} {n:>6} строк → {out_dir.relative_to(REPO_ROOT)}/goals.csv")
            reached = {name: sum(r[i + 1] for r in rows) for i, (gid, name) in enumerate(goals)}
            print("\n  Цели за период:")
            for name, cnt in sorted(reached.items(), key=lambda x: -x[1]):
                print(f"    {int(cnt):>6}  {name}")
    except RuntimeError as e:
        print(f"\n  ОШИБКА: {e}")
        if "403" in str(e) or "Forbidden" in str(e) or "access" in str(e).lower():
            print("  Токен без доступа к счётчику. Проверь: python scripts/seo/fetch_metrika.py --list")
        return

    if totals:
        visits, users, bounce, dur, views = (totals + [0] * 5)[:5]
        print(f"\n  Визиты:         {int(visits):>7}")
        print(f"  Посетители:     {int(users):>7}")
        print(f"  Просмотры:      {int(views):>7}")
        print(f"  Отказы:         {bounce:>6.1f}%")
        print(f"  Время на сайте: {int(dur // 60)}:{int(dur % 60):02d}")

    trend = append_trend(OUT_ROOT / args.counter, date.today().isoformat(), totals, args.days)
    print(f"\n  История: {trend.relative_to(REPO_ROOT)}  ← впиши, что менял")
    print("\nГотово.\n")


if __name__ == "__main__":
    main()
