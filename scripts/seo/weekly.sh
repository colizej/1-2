#!/bin/sh
# Недельный замер: выгрузить всё и разобрать. Запускается из launchd (см.
# docs/analytics/README.md) либо руками. Ключи лежат только на машине разработчика,
# на GitHub Pages ничего из этого не уезжает.
set -e
cd "$(dirname "$0")/../.."
PY=python3
echo "=== $(date '+%Y-%m-%d %H:%M') ==="
$PY scripts/seo/fetch_gsc.py --days 28 || echo "GSC пропущен (нет доступа?)"
$PY scripts/seo/fetch_ga4.py --days 28
$PY scripts/seo/fetch_metrika.py --days 28
$PY scripts/seo/fetch_bing.py || echo "Bing пропущен (нет ключа?)"
$PY scripts/seo/analyze.py
