const CACHE_NAME = 'odindva-v49';
const ASSETS = [
  './',
  './index.html',
  './static/style.css',
  './static/app.js',
  './manifest.json',
  './sounds/beep_tick.m4a',
  './sounds/beep_go.m4a',
  './sounds/beep_warn.m4a',
  './sounds/beep_end.m4a',
  // Демо-музыка (11 МБ на три трека) здесь намеренно НЕ перечислена. Раньше была —
  // и качалась при установке SW, то есть на первом же заходе, до того как человек
  // что-либо сделал. На мобильной сети это 11 МБ в фоне ради музыки, которую могут
  // никогда не включить. Теперь её тянет app.js по первому жесту, а сюда она
  // попадает обычным путём — через runtime-кэш в fetch-обработчике ниже.
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Only handle same-origin GET requests
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        if (!response || response.status !== 200 || response.type !== 'basic') return response;
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        return response;
      });
    })
  );
});
