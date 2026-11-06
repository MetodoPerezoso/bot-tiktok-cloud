self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Manejador básico de red para PWA
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});