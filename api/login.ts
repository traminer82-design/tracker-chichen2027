import { admin, FieldValue, checkPin, getDb, hashPin, initAdmin, migrateLegacyPins, normalizeRole, validPin } from './_lib.js';

const MAX_FAILS = 5;
const LOCK_MIN = 10;

// Accesso con PIN: il PIN viene verificato SOLO qui, mai nel browser.
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).send('Metodo non consentito');
  if (!initAdmin()) return res.status(503).send('Server non configurato');

  const { userId, pin } = req.body || {};
  if (typeof userId !== 'string' || !userId || userId.length > 100 || !validPin(pin)) {
    return res.status(400).send('Dati non validi');
  }

  const db = getDb();
  const userRef = db.collection('users').doc(userId);
  const credRef = db.collection('credentials').doc(userId);
  const [u, c] = await Promise.all([userRef.get(), credRef.get()]);
  if (!u.exists) return res.status(404).send('Utente non trovato');

  const cred = c.data() ?? {};
  const now = Date.now();
  if (cred.lockedUntil && cred.lockedUntil > now) {
    return res.status(429).json({ retryInMin: Math.ceil((cred.lockedUntil - now) / 60000) });
  }

  const legacy = u.data()?.pin; // vecchi account: PIN ancora in chiaro, migrato al primo accesso
  let ok = false;
  if (cred.hash && cred.salt) ok = checkPin(pin, cred.salt, cred.hash);
  else if (typeof legacy === 'string') ok = legacy === pin;

  if (!ok) {
    const fails = (cred.fails ?? 0) + 1;
    await credRef.set(
      { fails: fails >= MAX_FAILS ? 0 : fails, lockedUntil: fails >= MAX_FAILS ? now + LOCK_MIN * 60000 : 0 },
      { merge: true },
    );
    return res.status(401).send('PIN errato');
  }

  if (cred.hash) await credRef.set({ fails: 0, lockedUntil: 0 }, { merge: true });
  else await credRef.set({ ...hashPin(pin), fails: 0, lockedUntil: 0 }, { merge: true });
  if (legacy !== undefined) await userRef.update({ pin: FieldValue.delete() });

  const role = normalizeRole(u.data()?.role);
  if (role === 'chef') await migrateLegacyPins().catch(() => {});

  // L'uid Firebase coincide con l'id dell'account: le regole Firestore lo usano per riconoscere il ruolo.
  const token = await admin.auth().createCustomToken(userId);
  res.status(200).json({ token });
}
