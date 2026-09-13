// Минимальный service worker — нужен, чтобы браузер разрешил установку PWA
// на телефон. Полноценный офлайн-режим не делаем: кэшируем только "оболочку"
// (главная страница, манифест, иконки), а остальное всегда берём из сети
const CACHE_NAME = 'salon-shell-v1'
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

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)))
})
