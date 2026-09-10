# ОДИН·ДВА — Interval Timer PWA

Прогрессивное веб-приложение для интервальных тренировок. Работает офлайн, устанавливается на главный экран телефона.

🔗 **[odin-dva.ru](https://odin-dva.ru)**

## Возможности

- **Тренировки с упражнениями** — название, иконка, список упражнений с индивидуальным временем работы и отдыха
- **Настройка подготовки** — настраиваемый обратный отсчёт перед первым упражнением
- **Таймер с визуализацией** — круговой прогресс-бар, подсветка фаз, обратный отсчёт 3-2-1, кнопка пропуска
- **Музыка по фазам** — отдельный трек для фаз «Работа», «Отдых» и «Финиш»; хранится локально через IndexedDB; продолжает играть с той же позиции между упражнениями
- **Звуковые сигналы** — Web Audio API, sample-accurate воспроизведение через AudioBuffer
- **Wake Lock** — экран не гаснет во время тренировки
- **Экспорт / Импорт** — экспортировать конкретную тренировку в JSON, импортировать чужие через кнопку +
- **Прогресс** — история тренировок с возможностью удаления записей
- **Адаптивный дизайн** — mobile-first, на десктопе ограничена шириной 480 px
- **PWA** — офлайн через Service Worker, иконки 192/512/180 px, fullscreen

## Стек

| Слой | Технологии |
|------|-----------|
| UI | Vanilla HTML / CSS (Custom Properties, Flexbox, CSS Animations) |
| Логика | Vanilla JavaScript (ES2020+) |
| Хранилище тренировок | `localStorage` |
| Хранилище музыки | `IndexedDB` (база `odindva_music`) |
| Звук | `Web Audio API` (AudioContext + AudioBuffer, gapless loop) |
| Офлайн | `Service Worker` (cache-first, версия в `CACHE_NAME`) |
| Манифест | `manifest.json` (fullscreen, portrait) |

## Структура проекта

```
1-2/
├── index.html          # Разметка (5 экранов + bottom sheets + диалог)
├── sw.js               # Service Worker (обязательно в корне)
├── manifest.json       # PWA-манифест
├── CNAME               # Домен для GitHub Pages
├── static/
│   ├── app.js          # Полная логика приложения
│   └── style.css       # Все стили, CSS-переменные, анимации
├── icons/
│   ├── favicon.svg     # Векторный исходник логотипа
│   ├── og-image.svg    # Векторный исходник социальной карточки 1200×630
│   ├── og-image.png    # OG-образ для мессенджеров (генерируется)
│   ├── favicon-32.png  # Растровый фолбэк (генерируется)
│   ├── icon-180.png    # Apple Touch Icon (генерируется)
│   ├── icon-192.png    # PWA icon (генерируется)
│   └── icon-512.png    # PWA icon maskable (генерируется)
├── scripts/
│   ├── gen-og.js       # SVG → PNG: все иконки + og-image
│   └── seo/            # Выгрузка GSC / GA4 / Метрики / Bing
├── docs/
│   └── analytics/      # Инструкции, выгрузки, TREND.md, отчёты
├── secrets/            # Ключи API (в .gitignore, кроме README)
├── .github/workflows/  # Деплой на GitHub Pages + уведомление IndexNow
└── sounds/
    ├── beep_tick.m4a   # Бип отсчёта подготовки
    ├── beep_go.m4a     # Бип старта фазы
    ├── beep_warn.m4a   # Бип предупреждения (последние 3 сек)
    ├── beep_end.m4a    # Бип окончания фазы
    ├── demo_work.m4a   # Демо-музыка фазы Работа
    ├── demo_relaxe.m4a # Демо-музыка фазы Отдых
    └── demo_fin.m4a    # Демо-музыка фазы Финиш
```

## Запуск локально

```bash
make dev          # сервер на http://localhost:8080
make dev PORT=3000  # другой порт
```

## Иконки и OG-образ

Все PNG-иконки генерируются из SVG-исходников скриптом:

```bash
make og  # → icons/og-image.png, icon-512.png, icon-192.png, icon-180.png, favicon-32.png
```

Исходники:
- `icons/favicon.svg` — логотип приложения (все размеры иконок)
- `icons/og-image.svg` — карточка 1200×630 для мессенджеров / Twitter

Генератор: `scripts/gen-og.js` (Node.js + `@resvg/resvg-js`).

## Флоу тренировки

```
Подготовка (N сек) → [Работа → Отдых] × упражнения → 🎉 Результат
```

- Отдых = 0 у упражнения → фаза отдыха пропускается
- После последнего упражнения — фаза «Финиш» с музыкой → экран результатов

## Экраны

1. **Главная** — список тренировок + горизонтальное колесо прогресса (по одной карточке на тренировку, свайп)
2. **Детали тренировки** — упражнения с временем работы и отдыха, кнопка «Старт», gear menu (редактировать / экспортировать / удалить)
3. **Создание/редактирование** — форма: название, упражнения (работа + отдых у каждого), время подготовки, музыка по фазам
4. **Таймер** — анимированный круговой таймер, пауза по тапу, кнопка пропуска, индикатор упражнений
5. **Результаты** — конфетти, статистика сессии, лог по упражнениям
6. **Прогресс тренировок** — свайп-карточки по тренировкам → таблица всех сессий с временем и датами

## Хранение данных

| Данные | Где |
|--------|-----|
| Тренировки | `localStorage` ключ `odindva_workouts` |
| История | `localStorage` ключ `odindva_history` |
| Музыкальные треки | `IndexedDB` база `odindva_music` |

Все удаления требуют подтверждения через встроенный диалог.

## SEO и индексация

| Файл | Назначение |
|------|-----------|
| `robots.txt` | Разрешает индексацию `index.html`; запрещает `sw.js`, `static/`, `sounds/`, `manifest.json` |
| `sitemap.xml` | Четыре записи: `/`, `/intervalnyj-tajmer.html`, `/privacy.html`, `/terms.html` |
| `<meta name="description">` | Ключевая фраза для поисковиков, включает HIIT, силовые, кардио, офлайн |
| `<title>` | `Один-Два` — запоминающееся название |
| `.gitignore` | Личные `mp3`, `.DS_Store` — не попадают в репо и не индексируются |
| `<ключ>.txt` в корне | Подтверждение домена для IndexNow — трогать нельзя |
| Подтверждения сайтов | `google-site-verification`, `yandex-verification`, `msvalidate.01` в `<head>` `index.html` |

## Аналитика

Подключены Google Analytics 4 (property `529871644`, поток `G-1D6J41RLMG`),
Яндекс.Метрика (счётчик `108311751`) и Google Search Console. Счётчики стоят в
`index.html`, выгрузка метрик через API — скриптами в `scripts/seo/`:

```bash
pip3 install -r requirements-seo.txt

scripts/seo/weekly.sh        # всё разом: выгрузка + разбор
```

Свои заходы (Бельгия) режутся на уровне API — список в `scripts/seo/config.py`,
посмотреть сырые данные можно флагом `--include-self`.

Действия в приложении шлются в оба счётчика функцией `track()` из `static/app.js`:
`timer_start`, `workout_complete`, `workout_create`, `pwa_install`.

- [docs/analytics/README.md](docs/analytics/README.md) — доступы, ключи, Bing, IndexNow, замеры
- [docs/analytics/metrika-goals.md](docs/analytics/metrika-goals.md) — как завести цели в Метрике
- [docs/analytics/issues.md](docs/analytics/issues.md) — доступность, индексация, разбор Ahrefs

## Деплой

Сайт публикуется на GitHub Pages из ветки `main` через
[.github/workflows/pages.yml](.github/workflows/pages.yml) — каждый push собирает и
выкатывает, прогон виден во вкладке Actions. Содержимое сайта берётся по списку
исключений: `docs/`, `scripts/`, `secrets/`, `*.md` и `Makefile` в веб не попадают.

Запустить руками: `gh workflow run pages.yml --repo colizej/1-2 --ref main`
