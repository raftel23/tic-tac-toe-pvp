const CACHE_NAME = 'neon-strike-v2'; // Bumped version
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/sounds/move.mp3',
  '/sounds/match.mp3',
  '/sounds/win.mp3',
  '/sounds/lose.mp3',
  '/sounds/click.mp3',
  '/sounds/draw.mp3'
];

self.addEventListener('install', (event) => {
  self.skipWaiting(); // Force active
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(keys.map((key) => {
        if (key !== CACHE_NAME) return caches.delete(key);
      }));
    })
  );
});

self.addEventListener('fetch', (event) => {
  // Network First Strategy for HTML/JS/CSS to ensure latest version
  if (event.request.mode === 'navigate' || 
      event.request.url.includes('script.js') || 
      event.request.url.includes('style.css')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const resClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    // Cache First for assets (images, sounds)
    event.respondWith(
      caches.match(event.request).then((response) => {
        return response || fetch(event.request);
      })
    );
  }
});
