const CACHE_NAME = 'neurospark-cache-v26';
const ASSETS = [
  './',
  './index.html',
  './index.css',
  './manifest.json',
  './storage.js',
  './webgpu.js',
  './tools/ragSearch.js',
  './assets/icon-192.png',
  './assets/icon-512.png',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5.0.5/dist/tesseract.min.js'
];

// Install Event: Cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Caching static assets');
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate Event: Clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[Service Worker] Removing old cache:', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch Event: Stale-While-Revalidate strategy
self.addEventListener('fetch', (event) => {
  // Intercept Hugging Face requests for offline models
  if (event.request.method === 'GET' && event.request.url.includes('huggingface.co')) {
    event.respondWith(
      caches.open('neurospark-models-cache').then((cache) => {
        return cache.match(event.request).then((cachedResponse) => {
          if (cachedResponse) {
            console.log('[Service Worker] Serving cached model file:', event.request.url);
            return cachedResponse;
          }
          return fetch(event.request);
        });
      })
    );
    return;
  }

  // Only handle GET requests and local scope
  if (event.request.method !== 'GET' || !event.request.url.startsWith(self.location.origin)) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        // Cache the updated response
        if (networkResponse && networkResponse.status === 200) {
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, networkResponse.clone());
          });
        }
        return networkResponse;
      }).catch(() => {
        // Fail silently or handle offline fallback here if needed
      });

      // Return cached response immediately if available, otherwise wait for network
      return cachedResponse || fetchPromise;
    })
  );
});
