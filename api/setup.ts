import { admin, FieldValue, getDb, hashPin, initAdmin, validName, validPin } from './_lib.js';

// Primo avvio: crea lo Chef solo se non esiste ancora nessun account.
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).send('Metodo non consentito');
  if (!initAdmin()) return res.status(503).send('Server non configurato');

  const { name, pin } = req.body || {};
  if (!validName(name) || !validPin(pin)) return res.status(400).send('Dati non validi');

  const db = getDb();
  const existing = await db.collection('users').limit(1).get();
  if (!existing.empty) return res.status(403).send('Configurazione già eseguita');

  const ref = await db.collection('users').add({
    name: name.trim(),
    role: 'chef',
    createdAt: FieldValue.serverTimestamp(),
  });
  await db.collection('credentials').doc(ref.id).set({ ...hashPin(pin), fails: 0, lockedUntil: 0 });
  res.status(200).json({ token: await admin.auth().createCustomToken(ref.id) });
}
