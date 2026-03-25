// Service Worker — caches everything for full offline use.

const CACHE_NAME = 'putt-solver-v5';

// App shell files — cached on install
const APP_SHELL = [
    './',
    './index.html',
    './app.js',
    './solver.js',
    './worker.js',
    './style.css',
    './manifest.json',
    './data/courses.json',
];

// Install: cache the app shell
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
    );
});

// Activate: clean old caches, take control immediately
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(k => k !== CACHE_NAME)
                    .map(k => caches.delete(k))
            )
        ).then(() => self.clients.claim())
    );
});

// Fetch: try cache first, then network (and cache the network response)
self.addEventListener('fetch', (event) => {
    const request = event.request;

    // Only handle GET requests
    if (request.method !== 'GET') return;

    event.respondWith(
        caches.open(CACHE_NAME).then(cache => {
            return cache.match(request).then(cached => {
                if (cached) {
                    return cached;
                }

                return fetch(request).then(response => {
                    // Cache successful responses for data files and app shell
                    if (response.ok) {
                        cache.put(request, response.clone());
                    }
                    return response;
                }).catch(() => {
                    // Offline and not in cache — return a basic error for
                    // navigation requests, otherwise just fail
                    if (request.mode === 'navigate') {
                        return cache.match('./index.html');
                    }
                    return new Response('Offline', { status: 503 });
                });
            });
        })
    );
});
