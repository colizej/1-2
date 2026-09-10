#!/usr/bin/env python
"""
Выгрузка метрик GA4 через Data API — каналы, страны, города, посадочные, события.

Складывает разрезы в CSV и ведёт TREND.md, чтобы замеры копились и их можно было
сравнивать между собой: цифра за один замер сама по себе ничего не говорит.

Использование:
    pip install -r requirements-seo.txt

    python scripts/seo/fetch_ga4.py
    python scripts/seo/fetch_ga4.py --days 90
    python scripts/seo/fetch_ga4.py --list             # какие ресурсы видит ключ
    python scripts/seo/fetch_ga4.py --property 529871644

Ключ берётся из --credentials → GOOGLE_APPLICATION_CREDENTIALS → GSC_CREDENTIALS_FILE →
secrets/google-service-account.json. Всё внутри репозитория.
Настройка доступа: docs/analytics/README.md
"""

import argparse
import csv
import os
import sys
from datetime import date, timedelta
from pathlib import Path

try:
    from google.oauth2 import service_account
    from google.analytics.data_v1beta import BetaAnalyticsDataClient
    from google.analytics.data_v1beta.types import (
        DateRange, Dimension, Filter, FilterExpression, Metric, RunReportRequest,
    )
    from google.api_core.exceptions import GoogleAPIError
except ImportError:
    sys.exit("Не установлены зависимости.\n  pip install -r requirements-seo.txt")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import EXCLUDE_COUNTRIES  # noqa: E402

SCOPES = ["https://www.googleapis.com/auth/analytics.readonly"]

DEFAULT_PROPERTY_ID = "529871644"   # ресурс «Один Два», поток G-1D6J41RLMG

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_ROOT = REPO_ROOT / "docs" / "analytics" / "data" / "ga4"

# По убыванию приоритета; первый существующий и берём.
CREDENTIAL_CANDIDATES = [
    os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"),
    os.environ.get("GSC_CREDENTIALS_FILE"),
    "secrets/google-service-account.json",
    "secrets/ga4-service-account.json",
    "secrets/gsc-service-account.json",
]

REPORTS = {
    "channels": (["sessionDefaultChannelGroup"], ["sessions", "totalUsers"]),
    "countries": (["country"], ["sessions", "totalUsers"]),
    "cities": (["city"], ["sessions", "totalUsers"]),
    "landing_pages": (["landingPage"], ["sessions", "totalUsers"]),
    "events": (["eventName"], ["eventCount"]),
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
        "или укажи путь: --credentials / GOOGLE_APPLICATION_CREDENTIALS.\n"
        "Инструкция: docs/analytics/README.md, раздел «Ключи»"
    )


def get_credentials(explicit):
    path = resolve_credentials(explicit)
    return service_account.Credentials.from_service_account_file(str(path), scopes=SCOPES), path


def list_properties(creds):
    """Какие GA4-ресурсы вообще видит ключ. Пустой список = SA не добавлен в GA."""
    from googleapiclient.discovery import build
    admin = build("analyticsadmin", "v1beta", credentials=creds, cache_discovery=False)
    summaries = admin.accountSummaries().list().execute().get("accountSummaries", [])
    for a in summaries:
        print(f"  аккаунт: {a.get('displayName')}")
        for p in a.get("propertySummaries", []):
            print(f"    {p.get('property')}  {p.get('displayName')}")
    if not summaries:
        print(
            "  ключу не доступен ни один ресурс GA4.\n"
            "  GA → Администратор → Управление доступом к ресурсу → добавить email\n"
            "  сервис-аккаунта с ролью «Читатель»."
        )


def country_filter(include_self):
    """NOT country IN (...) — вырезает свои же заходы. Фильтровать можно по любому
    измерению, даже если его нет в самом отчёте."""
    if include_self or not EXCLUDE_COUNTRIES["ga4"]:
        return None
    return FilterExpression(not_expression=FilterExpression(filter=Filter(
        field_name="country",
        in_list_filter=Filter.InListFilter(values=EXCLUDE_COUNTRIES["ga4"]),
    )))


def run(client, prop, dims, mets, start, end, include_self=False):
    req = RunReportRequest(
        property=f"properties/{prop}",
        date_ranges=[DateRange(start_date=start.isoformat(), end_date=end.isoformat())],
        dimensions=[Dimension(name=d) for d in dims],
        metrics=[Metric(name=m) for m in mets],
        dimension_filter=country_filter(include_self),
        limit=10000,
    )
    resp = client.run_report(req)
    return [
        [dv.value for dv in row.dimension_values] + [mv.value for mv in row.metric_values]
        for row in resp.rows
    ]


def write_csv(path, header, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)
    return len(rows)


def append_trend(prop_dir, run_date, sessions, users, days):
    path = prop_dir / "TREND.md"
    row = f"| {run_date} | {days} | {sessions} | {users} | |\n"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            f"# GA4 — история замеров: {prop_dir.name}\n\n"
            "Заполняется скриптом `scripts/seo/fetch_ga4.py`.\n"
            "Колонка «Что меняли» — руками, сразу после запуска.\n\n"
            "| Дата замера | Период (дн.) | Сеансы | Пользователи | Что меняли |\n"
            "|---|---|---|---|---|\n",
            encoding="utf-8",
        )
    with open(path, "a", encoding="utf-8") as f:
        f.write(row)
    return path


def main():
    p = argparse.ArgumentParser(description="Выгрузка метрик GA4 Data API")
    p.add_argument("--days", type=int, default=28, help="длина периода в днях (по умолчанию 28)")
    p.add_argument("--property", default=os.environ.get("GA4_PROPERTY_ID", DEFAULT_PROPERTY_ID))
    p.add_argument("--list", action="store_true", help="показать ресурсы, доступные ключу")
    p.add_argument("--credentials", help="путь до JSON-ключа сервис-аккаунта")
    p.add_argument("--include-self", action="store_true",
                   help="не вырезать свои заходы (см. EXCLUDE_COUNTRIES в config.py)")
    args = p.parse_args()

    creds, creds_path = get_credentials(args.credentials)
    print(f"Ключ: {creds_path}")

    if args.list:
        list_properties(creds)
        return

    client = BetaAnalyticsDataClient(credentials=creds)
    end = date.today() - timedelta(days=1)   # «вчера»: сегодняшний день ещё копится
    start = end - timedelta(days=args.days - 1)

    print(f"\n{'=' * 70}\nGA4 property {args.property}\n{'=' * 70}")
    print(f"Период: {start} … {end}")
    if not args.include_self and EXCLUDE_COUNTRIES["ga4"]:
        print(f"Исключено: свои заходы ({', '.join(EXCLUDE_COUNTRIES['ga4'])}) — см. scripts/seo/config.py")

    out_dir = OUT_ROOT / args.property / f"{end.isoformat()}_{args.days}d"
    sessions = users = 0
    try:
        for name, (dims, mets) in REPORTS.items():
            rows = run(client, args.property, dims, mets, start, end, args.include_self)
            n = write_csv(out_dir / f"{name}.csv", dims + mets, rows)
            print(f"  {name:<14} {n:>6} строк → {out_dir.relative_to(REPO_ROOT)}/{name}.csv")
            if name == "channels":
                sessions = sum(int(r[1]) for r in rows)
                users = sum(int(r[2]) for r in rows)
    except GoogleAPIError as e:
        print(
            f"\n  ОШИБКА API: {e}\n"
            "  Если это 403 — сервис-аккаунт не добавлен в ресурс GA4:\n"
            "  GA → Администратор → Управление доступом к ресурсу → роль «Читатель».\n"
            "  Проверить, что ключу вообще доступно: python scripts/seo/fetch_ga4.py --list"
        )
        return

    print(f"\n  Сеансы:        {sessions:>7}")
    print(f"  Пользователи:  {users:>7}")

    trend = append_trend(OUT_ROOT / args.property, date.today().isoformat(),
                         sessions, users, args.days)
    print(f"\n  История: {trend.relative_to(REPO_ROOT)}  ← впиши, что менял")
    print("\nГотово.\n")


if __name__ == "__main__":
    main()
