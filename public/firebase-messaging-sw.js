/* KitchenOS Service Worker - Push anche ad app chiusa */
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {
    title: 'Nuova richiesta KitchenOS',
    body: 'Un cuoco ha inviato una nuova richiesta.',
    url: '/',
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      const notif = parsed.notification || parsed;
      data = {
        title: notif.title || data.title,
        body: notif.body || data.body,
        url: parsed.data?.url || notif.click_action || '/',
      };
    } catch {
      const txt = event.data.text();
      if (txt) data.body = txt;
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/badge-96.png',
      vibrate: [350, 120, 350, 120, 500],
      requireInteraction: true,
      tag: 'kitchenos-' + Date.now(),
      data: { url: data.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    }),
  );
});
