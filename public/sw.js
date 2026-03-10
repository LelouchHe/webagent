// Minimal service worker for PWA installability + push notifications.
// No offline caching — app requires WebSocket connection.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// --- Push notifications ---

self.addEventListener('push', (e) => {
  if (!e.data) return;

  let payload;
  try {
    payload = e.data.json();
  } catch {
    return;
  }

  const { title, body, data } = payload;
  e.waitUntil(
    self.registration.showNotification(title || 'WebAgent', {
      body: body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data?.sessionId || 'default',
      data: data || {},
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();

  const sessionId = e.notification.data?.sessionId;
  const urlHash = sessionId ? `/#${sessionId}` : '/';

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus existing window if open
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          client.focus();
          client.postMessage({ type: 'navigate', sessionId });
          return;
        }
      }
      // Otherwise open a new window
      return self.clients.openWindow(urlHash);
    })
  );
});
