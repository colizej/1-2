# secrets/

Ключи API. **Всё содержимое папки в `.gitignore`**, кроме этого файла.

| Файл | Для чего | Как получить |
|---|---|---|
| `google-service-account.json` | Search Console + GA4 (один сервис-аккаунт на оба) | [../docs/analytics/README.md](../docs/analytics/README.md), раздел «Ключи» |
| `yandex-metrika-token.txt` | Яндекс.Метрика Reporting API | там же |
| `bing-api-key.txt` | Bing Webmaster Tools | bing.com/webmasters → шестерёнка справа вверху → «Доступ к API» → API Key |

Скрипты находят их сами, экспортировать переменные окружения не нужно:

```bash
python3 scripts/seo/fetch_gsc.py
python3 scripts/seo/fetch_ga4.py
python3 scripts/seo/fetch_metrika.py
python3 scripts/seo/fetch_bing.py
```

Порядок поиска у каждого: аргумент командной строки → переменная окружения → файл здесь.
Ни один скрипт не смотрит за пределы репозитория.

⚠️ Ключи аккаунтные: тем же сервис-аккаунтом и токеном читаются и соседние проекты.
Если ключ случайно попал в git — отозвать (Google Cloud → Service Accounts → Keys → Delete;
oauth.yandex.ru → отозвать токен; Bing → «Доступ к API» → сгенерировать заново) и выпустить
новый. Удаления файла из репозитория мало.
