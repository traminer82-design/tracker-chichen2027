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

  const reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
  await navigator.serviceWorker.ready;

  const messaging = getMessaging(app);
  return await getToken(messaging, {
    vapidKey,
    serviceWorkerRegistration: reg,
  });
}
