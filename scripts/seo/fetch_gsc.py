#!/usr/bin/env python
"""
Выгрузка метрик Google Search Console через API.

Что делает:
  1. Search Analytics  — клики/показы/CTR/позиция по запросам, страницам, датам, странам, устройствам
  2. Sitemaps          — когда Google последний раз читал sitemap и сколько URL оттуда взял
  3. URL Inspection    — реальный статус индексации по каждому URL (--inspect N)

Чего не умеет ни один API Google (только веб-интерфейс GSC): сводный отчёт
«Индексирование → Страницы». Режим --inspect даёт то же самое по выборке URL.

Использование:
    pip install -r requirements-seo.txt

    python scripts/seo/fetch_gsc.py                    # 28 дней
    python scripts/seo/fetch_gsc.py --days 90
    python scripts/seo/fetch_gsc.py --list             # какие ресурсы видит ключ
    python scripts/seo/fetch_gsc.py --site https://odin-dva.ru/
    python scripts/seo/fetch_gsc.py --inspect 100      # + проверить индексацию 100 URL

Ключ берётся из --credentials → GSC_CREDENTIALS_FILE → GOOGLE_APPLICATION_CREDENTIALS →
secrets/google-service-account.json (тот же сервис-аккаунт обслуживает и GA4 — доступы
к ним выдаются в двух разных интерфейсах).
Настройка доступа: docs/analytics/README.md
"""

import argparse
import csv
import os
import re
import subprocess
import sys
import time
import urllib.request
from datetime import date, timedelta
from pathlib import Path

try:
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError
except ImportError:
    sys.exit("Не установлены зависимости.\n  pip install -r requirements-seo.txt")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import EXCLUDE_COUNTRIES  # noqa: E402

SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"]

SITE_HOST = "odin-dva.ru"
# Тип ресурса (домен sc-domain: или префикс https://) определяется автоматически
# через sites().list(); это значение — запасное, если список недоступен.
FALLBACK_SITE = f"sc-domain:{SITE_HOST}"

# GSC отдаёт данные с задержкой ~2-3 дня. Берём с запасом, иначе хвост будет пустым.
DATA_LAG_DAYS = 3

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_ROOT = REPO_ROOT / "docs" / "analytics" / "data" / "gsc"

# По убыванию приоритета; первый существующий и берём. Всё внутри репозитория:
# на соседние проекты скрипты не смотрят. Один сервис-аккаунт может обслуживать
# и GSC, и GA4 — доступы к ним выдаются в двух разных интерфейсах.
CREDENTIAL_CANDIDATES = [
    os.environ.get("GSC_CREDENTIALS_FILE"),
    os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"),
    "secrets/google-service-account.json",
    "secrets/gsc-service-account.json",
    "secrets/ga4-service-account.json",
]

DIMENSIONS = {
    "queries": ["query"],
    "pages": ["page"],
    "dates": ["date"],
    "countries": ["country"],
    "devices": ["device"],
    # Пара «запрос × страница» — по ней видно каннибализацию: когда по одному
    # запросу Google показывает две твои страницы и они мешают друг другу.
    "query_page": ["query", "page"],
}


def resolve_credentials(explicit):
    for cand in ([explicit] if explicit else []) + CREDENTIAL_CANDIDATES:
        if not cand:
            continue
        path = Path(cand).expanduser()
        if not path.is_absolute():
            path = REPO_ROOT / path
        if path.exists():
            return path
    sys.exit(
        "Файл ключа сервис-аккаунта не найден. Положи его в\n"
        "  secrets/google-service-account.json\n"
        "или укажи путь: --credentials / GSC_CREDENTIALS_FILE.\n"
        "Инструкция: docs/analytics/README.md, раздел «Ключи»"
    )


def get_service(creds_file):
    path = resolve_credentials(creds_file)
    print(f"Ключ: {path}")
    creds = service_account.Credentials.from_service_account_file(str(path), scopes=SCOPES)
    return build("searchconsole", "v1", credentials=creds, cache_discovery=False)


def list_sites(service):
    try:
        return service.sites().list().execute().get("siteEntry", [])
    except HttpError as e:
        detail = str(e)
        print(f"  не удалось получить список ресурсов (API {e.resp.status})")
        if "has not been used in project" in detail or "is disabled" in detail:
            print(
                "  В GCP-проекте ключа не включён Search Console API. Включить:\n"
                "  console.cloud.google.com/apis/library/searchconsole.googleapis.com\n"
                "  (выбрать проект ключа), затем подождать пару минут."
            )
        return []


def detect_sites(service):
    """Какой ресурс odin-dva заведён в этом аккаунте — доменный или с префиксом URL."""
    found = [s["siteUrl"] for s in list_sites(service) if SITE_HOST in s["siteUrl"]]
    if not found:
        print(
            f"  ⚠ Ключ не видит ни одного ресурса с {SITE_HOST}. Беру {FALLBACK_SITE} наугад.\n"
            "    Скорее всего сервисный аккаунт не добавлен в GSC → Настройки →\n"
            "    Пользователи и разрешения. См. docs/analytics/README.md"
        )
        return [FALLBACK_SITE]
    # Доменный ресурс покрывает все протоколы и поддомены — он информативнее.
    found.sort(key=lambda s: not s.startswith("sc-domain:"))
    return found[:1]


def site_slug(site_url):
    """sc-domain:odin-dva.ru -> odin-dva.ru"""
    return re.sub(r"^(sc-domain:|https?://)", "", site_url).strip("/").replace("/", "_")


def country_filter(include_self):
    """Отсечь свои же заходы. GSC умеет notEquals только по одному значению за
    фильтр, поэтому на каждую страну — отдельный фильтр в одной группе (AND)."""
    if include_self or not EXCLUDE_COUNTRIES["gsc"]:
        return {}
    return {"dimensionFilterGroups": [{"groupType": "and", "filters": [
        {"dimension": "country", "operator": "notEquals", "expression": c}
        for c in EXCLUDE_COUNTRIES["gsc"]
    ]}]}


def query_all_rows(service, site_url, start, end, dimensions, row_limit=25000, include_self=False):
    """Постранично забирает все строки Search Analytics по заданным измерениям."""
    rows, start_row = [], 0
    while True:
        body = {
            "startDate": start.isoformat(),
            "endDate": end.isoformat(),
            "dimensions": dimensions,
            "rowLimit": min(row_limit, 25000),
            "startRow": start_row,
            "type": "web",
            **country_filter(include_self),
        }
        resp = service.searchanalytics().query(siteUrl=site_url, body=body).execute()
        batch = resp.get("rows", [])
        rows.extend(batch)
        if len(batch) < body["rowLimit"]:
            break
        start_row += len(batch)
        if start_row >= 100000:  # предохранитель
            break
    return rows


def totals(service, site_url, start, end, include_self=False):
    """Суммарные клики/показы/CTR/позиция за период (без разбивки)."""
    body = {"startDate": start.isoformat(), "endDate": end.isoformat(), "type": "web",
            **country_filter(include_self)}
    resp = service.searchanalytics().query(siteUrl=site_url, body=body).execute()
    rows = resp.get("rows", [])
    if not rows:
        return {"clicks": 0, "impressions": 0, "ctr": 0.0, "position": 0.0}
    r = rows[0]
    return {
        "clicks": int(r.get("clicks", 0)),
        "impressions": int(r.get("impressions", 0)),
        "ctr": float(r.get("ctr", 0.0)),
        "position": float(r.get("position", 0.0)),
    }


def write_csv(path, dimensions, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(dimensions + ["clicks", "impressions", "ctr", "position"])
        for r in rows:
            w.writerow(
                list(r.get("keys", []))
                + [
                    r.get("clicks", 0),
                    r.get("impressions", 0),
                    round(r.get("ctr", 0.0) * 100, 2),
                    round(r.get("position", 0.0), 1),
                ]
            )
    return len(rows)


def fetch_sitemaps(service, site_url):
    try:
        resp = service.sitemaps().list(siteUrl=site_url).execute()
    except HttpError as e:
        return [f"(ошибка чтения sitemaps: {e.resp.status})"]
    out = []
    for s in resp.get("sitemap", []):
        submitted = sum(int(c.get("submitted", 0)) for c in s.get("contents", []))
        out.append(
            f"{s.get('path', '?')} — последнее чтение Google: "
            f"{(s.get('lastDownloaded') or 'НИКОГДА')[:10]}, "
            f"URL заявлено: {submitted or '?'}, "
            f"ошибок: {s.get('errors', 0)}, предупреждений: {s.get('warnings', 0)}"
        )
    return out or ["(sitemap не отправлен в GSC — это надо сделать вручную)"]


def fetch_url(url, timeout=30):
    """urllib + запасной вариант через curl: на части сборок Python нет
    системных корневых сертификатов и любой https падает на verify."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.read().decode("utf-8", "replace")
    except Exception:
        out = subprocess.run(["curl", "-sL", "--max-time", str(timeout), url],
                             capture_output=True, text=True)
        if out.returncode != 0:
            raise RuntimeError(f"не удалось скачать {url}")
        return out.stdout


def sitemap_urls(site_url, limit):
    """Берёт URL прямо из живого sitemap.xml — для режима --inspect."""
    local = REPO_ROOT / "sitemap.xml"
    try:
        xml = fetch_url(f"https://{SITE_HOST}/sitemap.xml")
        if "<loc>" not in xml:
            raise RuntimeError("живой sitemap не отдаёт <loc> — сайт лежит?")
    except Exception as e:
        # Сайт может быть недоступен, а проверить индексацию всё равно надо —
        # именно тогда это и нужнее всего. Берём карту из репозитория.
        if not local.exists():
            print(f"    не удалось скачать sitemap: {e}")
            return []
        print(f"    живой sitemap недоступен ({e}) — беру {local.name} из репозитория")
        xml = local.read_text(encoding="utf-8")
    locs = re.findall(r"<loc>([^<]+)</loc>", xml)
    # sitemap_index: <loc> ведут на вложенные карты, а не на страницы
    if locs and all(l.endswith(".xml") for l in locs[:3]):
        pages = []
        for child in locs:
            try:
                pages += re.findall(r"<loc>([^<]+)</loc>", fetch_url(child))
            except Exception:
                continue
            if len(pages) >= limit:
                break
        locs = pages
    return locs[:limit]


def inspect_urls(service, site_url, urls):
    """URL Inspection API. Квота: 2000 запросов/сутки на ресурс, 600/мин."""
    stats, examples = {}, {}
    for i, url in enumerate(urls, 1):
        try:
            resp = (
                service.urlInspection()
                .index()
                .inspect(body={"inspectionUrl": url, "siteUrl": site_url, "languageCode": "ru"})
                .execute()
            )
            state = (
                resp.get("inspectionResult", {})
                .get("indexStatusResult", {})
                .get("coverageState", "(нет данных)")
            )
        except HttpError as e:
            state = f"(ошибка API {e.resp.status})"
            if e.resp.status in (403, 429):
                print(f"    квота исчерпана на {i}-м URL — останавливаюсь")
                stats[state] = stats.get(state, 0) + 1
                break
        stats[state] = stats.get(state, 0) + 1
        examples.setdefault(state, []).append(url)
        if i % 20 == 0:
            print(f"    проверено {i}/{len(urls)}")
        time.sleep(0.15)  # держимся ниже 600/мин
    return stats, examples


def append_trend(site_dir, run_date, cur, prev, days):
    """Одна строка на запуск — это и есть история, ради которой всё затевалось."""
    path = site_dir / "TREND.md"
    d_clicks = cur["clicks"] - prev["clicks"]
    d_impr = cur["impressions"] - prev["impressions"]
    row = (
        f"| {run_date} | {days} | {cur['clicks']} | {d_clicks:+d} | "
        f"{cur['impressions']} | {d_impr:+d} | {cur['ctr']*100:.2f}% | "
        f"{cur['position']:.1f} | |\n"
    )
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            f"# GSC — история замеров: {site_dir.name}\n\n"
            "Заполняется скриптом `scripts/seo/fetch_gsc.py`.\n"
            "Колонка «Что меняли» — руками, сразу после запуска. Без неё через месяц\n"
            "будет непонятно, почему цифра сдвинулась.\n\n"
            "| Дата замера | Период (дн.) | Клики | Δ | Показы | Δ | CTR | Поз. | Что меняли |\n"
            "|---|---|---|---|---|---|---|---|---|\n",
            encoding="utf-8",
        )
    with open(path, "a", encoding="utf-8") as f:
        f.write(row)
    return path


def process_site(service, site_url, days, inspect_n, include_self=False):
    slug = site_slug(site_url)
    print(f"\n{'=' * 70}\n{site_url}\n{'=' * 70}")

    end = date.today() - timedelta(days=DATA_LAG_DAYS)
    start = end - timedelta(days=days - 1)
    prev_end = start - timedelta(days=1)
    prev_start = prev_end - timedelta(days=days - 1)

    print(f"Период:     {start} … {end}")
    print(f"Сравнение:  {prev_start} … {prev_end}")
    if not include_self and EXCLUDE_COUNTRIES["gsc"]:
        print(f"Исключено:  свои заходы ({', '.join(EXCLUDE_COUNTRIES['gsc'])}) — см. scripts/seo/config.py")

    try:
        cur = totals(service, site_url, start, end, include_self)
        prev = totals(service, site_url, prev_start, prev_end, include_self)
    except HttpError as e:
        if e.resp.status == 403:
            print(
                "\n  ОШИБКА 403. Сервисный аккаунт не имеет доступа к этому ресурсу.\n"
                "  Проверь: GSC → Настройки → Пользователи и разрешения → добавлен ли\n"
                "  email сервисного аккаунта.\n"
                "  И совпадает ли тип ресурса: sc-domain: (домен) vs https:// (префикс URL)."
            )
        else:
            print(f"\n  ОШИБКА API {e.resp.status}: {e}")
        return

    print(f"\n  Клики:   {cur['clicks']:>7}   ({cur['clicks'] - prev['clicks']:+d} к прошлому периоду)")
    print(f"  Показы:  {cur['impressions']:>7}   ({cur['impressions'] - prev['impressions']:+d})")
    print(f"  CTR:     {cur['ctr']*100:>6.2f}%")
    print(f"  Позиция: {cur['position']:>6.1f}")
    if cur["impressions"] > 0 and cur["clicks"] == 0:
        print("  ⚠ Показы есть, кликов нет — сайт в индексе, но глубоко в выдаче.")
    if cur["impressions"] == 0:
        print("  ⚠ Показов нет вообще — проблема не в позициях, а в индексации.")

    # В имени папки обязателен и период: иначе запуск на 90 дней затирает выгрузку на 28.
    out_dir = OUT_ROOT / slug / f"{end.isoformat()}_{days}d"
    for name, dims in DIMENSIONS.items():
        rows = query_all_rows(service, site_url, start, end, dims, include_self=include_self)
        n = write_csv(out_dir / f"{name}.csv", dims, rows)
        print(f"  {name:<10} {n:>6} строк → {out_dir.relative_to(REPO_ROOT)}/{name}.csv")

    print("\n  Sitemap:")
    for line in fetch_sitemaps(service, site_url):
        print(f"    {line}")

    if inspect_n:
        urls = sitemap_urls(site_url, inspect_n)
        if urls:
            print(f"\n  Проверка индексации {len(urls)} URL (это медленно):")
            stats, examples = inspect_urls(service, site_url, urls)
            print("\n  Статус индексации:")
            for state, count in sorted(stats.items(), key=lambda x: -x[1]):
                pct = count / max(sum(stats.values()), 1) * 100
                print(f"    {count:>5} ({pct:>5.1f}%)  {state}")
                if "not indexed" in state.lower():
                    for ex in examples.get(state, [])[:3]:
                        print(f"              пример: {ex}")

    trend = append_trend(OUT_ROOT / slug, date.today().isoformat(), cur, prev, days)
    print(f"\n  История: {trend.relative_to(REPO_ROOT)}  ← впиши в последнюю строку, что менял")


def main():
    p = argparse.ArgumentParser(description="Выгрузка метрик Google Search Console")
    p.add_argument("--days", type=int, default=28, help="длина периода в днях (по умолчанию 28)")
    p.add_argument("--site", action="append", help="ресурс GSC; можно указать несколько раз")
    p.add_argument("--list", action="store_true", help="показать ресурсы, доступные ключу")
    p.add_argument("--inspect", type=int, default=0, metavar="N",
                   help="проверить статус индексации первых N URL из sitemap (квота 2000/сутки)")
    p.add_argument("--credentials", help="путь до JSON-ключа сервис-аккаунта")
    p.add_argument("--include-self", action="store_true",
                   help="не вырезать свои заходы (см. EXCLUDE_COUNTRIES в config.py)")
    args = p.parse_args()

    service = get_service(args.credentials)

    if args.list:
        entries = list_sites(service)
        if not entries:
            print("  ключу не доступен ни один ресурс")
        for s in entries:
            print(f"  {s['siteUrl']}  ({s['permissionLevel']})")
        return

    for site in (args.site or detect_sites(service)):
        process_site(service, site, args.days, args.inspect, args.include_self)

    print("\nГотово.\n")


if __name__ == "__main__":
    main()
