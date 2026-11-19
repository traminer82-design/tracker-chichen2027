import { initializeApp } from 'firebase/app';
import { initializeFirestore, persistentLocalCache } from 'firebase/firestore';
import { getMessaging, getToken, isSupported } from 'firebase/messaging';
import config from '../firebase-applet-config.json';

const app = initializeApp(config);
// La cache locale permette di usare l'app anche con il Wi-Fi che balla.
export const db = initializeFirestore(
  app,
  { localCache: persistentLocalCache() },
  config.firestoreDatabaseId,
);

export async function registerPushToken(): Promise<string | null> {
  const supported = await isSupported();
  if (!supported) return null;
  const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;
  if (!vapidKey) return null;

  const reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
  const messaging = getMessaging(app);
  return await getToken(messaging, { vapidKey, serviceWorkerRegistration: reg });
}
