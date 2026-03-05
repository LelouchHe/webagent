// Minimal service worker for PWA installability.
// No offline caching — app requires WebSocket connection.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
