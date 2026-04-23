// Minimal service worker for PWA installability + push notifications.
// No offline caching — app requires SSE connection.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// --- Push notifications ---
//
// Two payload shapes from the server:
//   { kind: "notify", title, body, tag, data }  → showNotification
//   { kind: "close",  tag }                      → close any existing
//                                                  notifications with that
//                                                  tag (cross-device recall
//                                                  for acked/consumed inbox
//                                                  messages).

self.addEventListener('push', (e) => {
  if (!e.data) return;

  let payload;
  try {
    payload = e.data.json();
  } catch {
    return;
  }

  if (payload.kind === 'close' && payload.tag) {
    e.waitUntil(closeByTag(payload.tag));
    return;
  }

  // Backward-compat: older payloads had no `kind`. Treat as notify.
  const { title, body, tag, data } = payload;
  const finalTag = tag || data?.sessionId || 'default';
  e.waitUntil(showNotify(title, body, finalTag, data));
});

// iOS Safari's tag-based notification collapse in showNotification is
// unreliable: notifications stack in Notification Center even with
// identical tag. The community-standard workaround is to explicitly close
// any existing same-tag notifications in the SW before showing the new
// one. Harmless on conformant platforms (they already replace).
//
// NOTE: In iOS 17 PWA dogfood this workaround did NOT actually collapse
// banners either — two same-tag pushes still produced two banners. The
// underlying cause appears to be in WebKit / APNs and is outside our
// control. We keep this code because (a) it's correct per the Web
// Notifications spec, (b) it works on Chrome/Firefox/Android, and
// (c) future iOS versions may honor it.
async function showNotify(title, body, tag, data) {
  const existing = await self.registration.getNotifications({ tag });
  for (const n of existing) n.close();
  await self.registration.showNotification(title || 'WebAgent', {
    body: body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag,
    data: data || {},
  });
}

async function closeByTag(tag) {
  const notifications = await self.registration.getNotifications({ tag });
  for (const n of notifications) n.close();
}

// Allow page-side code to request close of a message-tagged notification
// (frontend dispatches this on `message_acked` / `message_consumed` so the
// local device's banner disappears without waiting for the server's silent
// close push).
self.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg && msg.type === 'close-notification' && msg.tag) {
    e.waitUntil(closeByTag(msg.tag));
  }
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();

  const data = e.notification.data || {};
  // For inbox messages, route to the bound session (if set) or root.
  // For session events, route to the session.
  const sessionId = data.sessionId;
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

