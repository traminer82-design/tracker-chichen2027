import { admin, FieldValue, getDb, hashPin, initAdmin, normalizeRole, requireChef, validName, validPin } from './_lib.js';

// Gestione account: solo lo Chef (verificato dal token) può creare, modificare o eliminare cuochi.
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).send('Metodo non consentito');
  if (!initAdmin()) return res.status(503).send('Server non configurato');

  const chef = await requireChef(req);
  if (!chef) return res.status(403).send('Solo lo Chef può gestire gli account');

  const db = getDb();
  const b = req.body || {};
  const all = async () => (await db.collection('users').get()).docs;
  const chefCount = async () => (await all()).filter((d) => normalizeRole(d.data().role) === 'chef').length;
  const isChefDoc = async (id: string) => {
    const s = await db.collection('users').doc(id).get();
    return s.exists ? normalizeRole(s.data()?.role) === 'chef' : false;
  };
  const roleOf = (r: unknown) => (r === 'chef' ? 'chef' : 'cuoco');

  if (b.action === 'create') {
    if (!validName(b.name) || !validPin(b.pin)) return res.status(400).send('Nome o PIN non validi');
    const name = b.name.trim();
    if ((await all()).some((d) => String(d.data().name).toLowerCase() === name.toLowerCase())) {
      return res.status(409).send('Nome già presente');
    }
    const ref = await db.collection('users').add({ name, role: roleOf(b.role), createdAt: FieldValue.serverTimestamp() });
    await db.collection('credentials').doc(ref.id).set({ ...hashPin(b.pin), fails: 0, lockedUntil: 0 });
    return res.status(200).json({ id: ref.id });
  }

  const userId = typeof b.userId === 'string' ? b.userId : '';
  if (!userId || userId.length > 100) return res.status(400).send('Dati non validi');
  const userRef = db.collection('users').doc(userId);
  if (!(await userRef.get()).exists) return res.status(404).send('Utente non trovato');

  if (b.action === 'setPin') {
    if (!validPin(b.pin)) return res.status(400).send('PIN non valido');
    await db.collection('credentials').doc(userId).set({ ...hashPin(b.pin), fails: 0, lockedUntil: 0 });
    return res.status(200).json({ ok: true });
  }

  if (b.action === 'setRole') {
    const next = roleOf(b.role);
    if (next === 'cuoco' && (await isChefDoc(userId)) && (await chefCount()) <= 1) {
      return res.status(409).send('Serve almeno uno Chef');
    }
    await userRef.update({ role: next });
    return res.status(200).json({ ok: true });
  }

  if (b.action === 'delete') {
    if (userId === chef.uid) return res.status(400).send('Non puoi eliminare il tuo account');
    if ((await isChefDoc(userId)) && (await chefCount()) <= 1) return res.status(409).send('Serve almeno uno Chef');
    await Promise.all([
      userRef.delete(),
      db.collection('credentials').doc(userId).delete(),
      db.collection('pushTokens').doc(userId).delete(),
    ]);
    await admin.auth().revokeRefreshTokens(userId).catch(() => {});
    await admin.auth().deleteUser(userId).catch(() => {});
    return res.status(200).json({ ok: true });
  }

  res.status(400).send('Azione non valida');
}
