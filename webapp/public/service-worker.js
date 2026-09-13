// Минимальный service worker — нужен, чтобы браузер разрешил установку PWA
// на телефон. Полноценный офлайн-режим не делаем: кэшируем только "оболочку"
// (главная страница, манифест, иконки), а остальное всегда берём из сети.
//
// Версию имени кэша нужно менять при каждом заметном изменении этого файла —
// это единственный способ заставить уже установленные у людей приложения
// забрать новую версию кэша (см. ниже, почему это критично)
const CACHE_NAME = 'salon-shell-v2'
const PRECACHE_URLS = ['./', './manifest.json', './icons/icon-192.png', './icons/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  )
  self.clients.claim()
})

// Важно: всегда сначала пробуем сеть, и только если сети совсем нет — берём
// из кэша. Раньше было наоборот (сначала кэш) — из-за этого один раз
// сохранённая главная страница показывалась вечно, даже после того как
// на сайте выходило обновление и старые файлы (со случайными именами вроде
// index-B_ZQ2Xa5.js) физически удалялись с сервера. Итог — страница из кэша
// пыталась загрузить уже несуществующий файл и весь интерфейс переставал
// показываться и в браузере, и в установленном приложении
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone()
        event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)))
        return response
      })
      .catch(() => caches.match(event.request))
  )
})
