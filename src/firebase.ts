import { initializeApp } from 'firebase/app';
import { initializeFirestore, persistentLocalCache } from 'firebase/firestore';
import config from '../firebase-applet-config.json';

const app = initializeApp(config);
// La cache locale permette di usare l'app anche con il Wi-Fi che balla.
export const db = initializeFirestore(
  app,
  { localCache: persistentLocalCache() },
  config.firestoreDatabaseId,
);
