// Inkling's service worker: the studio opens with no signal, so you can draw in airplane mode.
// Only the app shell is cached. Your library, AI, and share links are never served from a cache.
const VERSION = 'inkling-shell-v1';
const SHELL = ['/', '/studio.css', '/studio.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== VERSION).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

// Fresh when online (so updates land on the next visit), the cached copy when not. A slow, flaky
// connection gets four seconds before the cached studio takes over.
async function networkFirst(request, key) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(key, { ignoreSearch: true });
  const network = fetch(request).then(response => {
    if (response.ok) cache.put(key, response.clone());
    return response;
  });
  if (!cached) return network;
  network.catch(() => {}); // offline: the cached copy answers; nothing to report
  try {
    return await Promise.race([network, new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), 4000))]);
  } catch {
    return cached;
  }
}

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    if (url.pathname === '/' || url.pathname === '/studio') event.respondWith(networkFirst(request, '/'));
    return; // share pages (/s/...) and anything else: straight to the network
  }
  if (SHELL.includes(url.pathname)) event.respondWith(networkFirst(request, url.pathname));
});
