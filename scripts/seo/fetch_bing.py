#!/usr/bin/env python
"""
Выгрузка метрик Bing Webmaster Tools через API.

Что делает:
  1. GetRankAndTrafficStats — клики и показы по дням
  2. GetQueryStats         — запросы: клики, показы, средняя позиция
  3. GetPageStats          — страницы: клики, показы
  4. GetCrawlStats         — как Bing сканирует сайт (коды ответов, ошибки)

Использование:
    python scripts/seo/fetch_bing.py
    python scripts/seo/fetch_bing.py --sites          # только список доступных сайтов
    python scripts/seo/fetch_bing.py --site https://odin-dva.ru/

Ключ берётся из --key → BING_API_KEY → secrets/bing-api-key.txt.
Где взять: bing.com/webmasters → шестерёнка справа вверху → «Доступ к API» → API Key.
Ключ один на весь аккаунт, отдельный для каждого сайта не нужен.

Настройка: docs/analytics/README.md
"""

import argparse
import csv
import json
import os
import re
import subprocess
import sys
import urllib.parse
from datetime import date, datetime, timezone
from pathlib import Path

API = "https://ssl.bing.com/webmaster/api.svc/json"

DEFAULT_SITES = ["https://odin-dva.ru/"]

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_ROOT = REPO_ROOT / "docs" / "analytics" / "data" / "bing"


def call(method, key, **params):
    """Запрос к API. curl, а не urllib: на части сборок Python нет системных
    корневых сертификатов и любой https падает на проверке."""
    params["apikey"] = key
    url = f"{API}/{method}?" + urllib.parse.urlencode(params)
    out = subprocess.run(["curl", "-sS", "--max-time", "60", url],
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"curl вернул {out.returncode}: {out.stderr.strip()[:200]}")
    body = out.stdout.strip()
    if not body:
        raise RuntimeError(f"{method}: пустой ответ")
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        raise RuntimeError(f"{method}: ответ не JSON — {body[:200]}")
    if isinstance(data, dict) and "Message" in data and "d" not in data:
        raise RuntimeError(f"{method}: {data['Message']}")
    return data.get("d", data) if isinstance(data, dict) else data


def parse_ms_date(v):
    """Bing отдаёт даты в формате /Date(1757116800000)/ (мс от эпохи)."""
    if not isinstance(v, str):
        return ""
    m = re.search(r"/Date\((-?\d+)", v)
    if not m:
        return v
    return datetime.fromtimestamp(int(m.group(1)) / 1000, timezone.utc).date().isoformat()


def write_csv(path, rows, columns):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(columns)
        for r in rows:
            w.writerow([parse_ms_date(r.get(c, "")) if c == "Date" else r.get(c, "")
                        for c in columns])
    return len(rows)


def append_trend(site_dir, run_date, clicks, impressions, days):
    """По строке на запуск — история, ради которой всё и затевалось."""
    path = site_dir / "TREND.md"
    ctr = clicks / impressions * 100 if impressions else 0
    row = f"| {run_date} | {days} | {clicks} | {impressions} | {ctr:.2f}% | |\n"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            f"# Bing — история замеров: {site_dir.name}\n\n"
            "Заполняется скриптом `scripts/seo/fetch_bing.py`.\n"
            "Колонка «Что меняли» — руками, сразу после запуска.\n\n"
            "| Дата замера | Дней в выборке | Клики | Показы | CTR | Что меняли |\n"
            "|---|---|---|---|---|---|\n",
            encoding="utf-8",
        )
    with open(path, "a", encoding="utf-8") as f:
        f.write(row)
    return path


def site_slug(site_url):
    return re.sub(r"^https?://", "", site_url).strip("/").replace("/", "_")


def process_site(site, key):
    slug = site_slug(site)
    print(f"\n{'=' * 70}\n{site}\n{'=' * 70}")

    try:
        daily = call("GetRankAndTrafficStats", key, siteUrl=site)
    except RuntimeError as e:
        print(f"  ОШИБКА: {e}")
        if "not verified" in str(e).lower() or "not found" in str(e).lower():
            print("  Сайт не подтверждён в этом аккаунте Bing Webmaster Tools.")
        return

    clicks = sum(int(r.get("Clicks", 0)) for r in daily)
    impressions = sum(int(r.get("Impressions", 0)) for r in daily)
    ctr = clicks / impressions * 100 if impressions else 0
    dates = [parse_ms_date(r.get("Date", "")) for r in daily if r.get("Date")]
    period = f"{min(dates)} … {max(dates)}" if dates else "—"

    print(f"Период:   {period}  ({len(daily)} дней)")
    print(f"\n  Клики:   {clicks:>7}")
    print(f"  Показы:  {impressions:>7}")
    print(f"  CTR:     {ctr:>6.2f}%")
    if impressions == 0:
        print("  ⚠ Показов нет. Либо сайт только что подтверждён и данные ещё не набрались\n"
              "    (первые цифры появляются через 2-3 дня), либо он не в индексе Bing.")

    out_dir = OUT_ROOT / slug / date.today().isoformat()
    n = write_csv(out_dir / "daily.csv", daily, ["Date", "Clicks", "Impressions"])
    print(f"\n  daily      {n:>6} строк → {(out_dir / 'daily.csv').relative_to(REPO_ROOT)}")

    for method, fname, cols in [
        ("GetQueryStats", "queries",
         ["Query", "Clicks", "Impressions", "AvgClickPosition", "AvgImpressionPosition"]),
        ("GetPageStats", "pages",
         ["Query", "Clicks", "Impressions", "AvgClickPosition", "AvgImpressionPosition"]),
        ("GetCrawlStats", "crawl",
         ["Date", "CrawledPages", "InIndex", "InLinks", "Code2xx", "Code301",
          "Code302", "Code4xx", "Code5xx", "BlockedByRobotsTxt", "AllOtherCodes"]),
    ]:
        try:
            rows = call(method, key, siteUrl=site)
            n = write_csv(out_dir / f"{fname}.csv", rows, cols)
            print(f"  {fname:<10} {n:>6} строк → {(out_dir / f'{fname}.csv').relative_to(REPO_ROOT)}")
        except RuntimeError as e:
            print(f"  {fname:<10} пропущено: {e}")

    trend = append_trend(OUT_ROOT / slug, date.today().isoformat(),
                         clicks, impressions, len(daily))
    print(f"\n  История: {trend.relative_to(REPO_ROOT)}  ← впиши, что менял")


def resolve_key(explicit):
    if explicit:
        return explicit
    if os.environ.get("BING_API_KEY"):
        return os.environ["BING_API_KEY"]
    keyfile = REPO_ROOT / "secrets" / "bing-api-key.txt"
    if keyfile.exists():
        return keyfile.read_text(encoding="utf-8").strip()
    return None


def main():
    p = argparse.ArgumentParser(description="Выгрузка метрик Bing Webmaster Tools")
    p.add_argument("--site", action="append", help="URL ресурса; можно указать несколько раз")
    p.add_argument("--sites", action="store_true", help="только показать доступные сайты")
    p.add_argument("--key", help="ключ API (по умолчанию BING_API_KEY / secrets/bing-api-key.txt)")
    args = p.parse_args()

    key = resolve_key(args.key)
    if not key:
        sys.exit(
            "Не задан ключ API.\n"
            "  export BING_API_KEY=...\n"
            "  либо положить его в secrets/bing-api-key.txt\n"
            "Где взять: bing.com/webmasters → шестерёнка справа вверху →\n"
            "«Доступ к API» → API Key"
        )

    if args.sites:
        try:
            for s in call("GetUserSites", key):
                mark = "✓" if s.get("IsVerified") else "✗ не подтверждён"
                print(f"  {mark}  {s.get('Url')}")
        except RuntimeError as e:
            sys.exit(f"ОШИБКА: {e}")
        return

    for site in (args.site or DEFAULT_SITES):
        process_site(site, key)

    print("\nГотово.\n")


if __name__ == "__main__":
    main()
