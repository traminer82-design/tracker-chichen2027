importScripts('https://www.gstatic.com/firebasejs/11.0.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.0.0/firebase-messaging-compat.js');

firebase.initializeApp({
  projectId: 'gen-lang-client-0210208250',
  appId: '1:638021087128:web:7290ee4521383914db85ed',
  apiKey: 'AIzaSyCWjgjHkUKNoWHZyUD4oOZqxblVNLMZoOc',
  messagingSenderId: '638021087128',
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || 'Nuovo ordine KitchenOS';
  const body = payload.notification?.body || 'Un operatore ha inviato la lista merce.';
  self.registration.showNotification(title, {
    body,
    icon: 'https://cdn-icons-png.flaticon.com/512/3652/3652191.png',
    badge: 'https://cdn-icons-png.flaticon.com/512/3652/3652191.png',
    vibrate: [300, 100, 300, 100, 400],
    requireInteraction: true,
    tag: 'kitchenos-order',
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});
