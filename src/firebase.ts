import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { initializeFirestore, persistentLocalCache } from 'firebase/firestore';
import { getMessaging, getToken, isSupported } from 'firebase/messaging';
import config from '../firebase-applet-config.json';

const app = initializeApp(config);
export const auth = getAuth(app);

// La cache locale permette di usare l'app anche con il Wi-Fi che balla.
export const db = initializeFirestore(
  app,
  { localCache: persistentLocalCache() },
  config.firestoreDatabaseId,
);

export async function registerPushToken(): Promise<string | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return null;
  if (!('Notification' in window) || Notification.permission !== 'granted') return null;

  const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;
  if (!vapidKey) return null;

  const supported = await isSupported().catch(() => false);
  if (!supported) return null;

  // Due service worker nello stesso ambito si sostituiscono a vicenda e le notifiche ad app chiusa
  // smettono di arrivare: si usa quello dell'app (che include la gestione push).
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<ServiceWorkerRegistration>((resolve) =>
      setTimeout(
        () => resolve(navigator.serviceWorker.register('/firebase-messaging-sw.js')),
        8000,
      ),
    ),
  ]);

  const messaging = getMessaging(app);
  return await getToken(messaging, {
    vapidKey,
    serviceWorkerRegistration: reg,
  });
}
