// Utilità condivise dalle funzioni serverless (il prefisso _ le esclude dalle rotte pubbliche).
import admin from 'firebase-admin';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export { admin, FieldValue };

// Il database Firestore dell'app è "con nome": va indicato anche lato server.
const DB_ID = process.env.FIRESTORE_DATABASE_ID || 'ai-studio-c21d8730-fc15-4165-9190-fae4cb2bf6d1';

export function initAdmin(): boolean {
  if (!admin.apps.length && process.env.FIREBASE_SERVICE_ACCOUNT) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    });
  }
  return admin.apps.length > 0;
}

export const getDb = () => getFirestore(admin.app(), DB_ID);

export const validPin = (p: unknown): p is string => typeof p === 'string' && /^\d{4}$/.test(p);
export const validName = (n: unknown): n is string =>
  typeof n === 'string' && n.trim().length > 0 && n.trim().length <= 40;
export const normalizeRole = (r?: string): 'chef' | 'cuoco' =>
  r === 'chef' || r === 'responsabile' ? 'chef' : 'cuoco';

export function hashPin(pin: string) {
  const salt = randomBytes(16);
  return { salt: salt.toString('hex'), hash: scryptSync(pin, salt, 32).toString('hex') };
}

export function checkPin(pin: string, salt: string, hash: string) {
  const h = scryptSync(pin, Buffer.from(salt, 'hex'), 32);
  const e = Buffer.from(hash, 'hex');
  return e.length === h.length && timingSafeEqual(h, e);
}

// Verifica il token Firebase dell'utente e che esista ancora nell'elenco account.
export async function requireUser(req: any): Promise<{ uid: string; role: 'chef' | 'cuoco'; name: string } | null> {
  const m = String(req.headers?.authorization ?? '').match(/^Bearer (.+)$/);
  if (!m) return null;
  try {
    const t = await admin.auth().verifyIdToken(m[1]);
    const snap = await getDb().collection('users').doc(t.uid).get();
    if (!snap.exists) return null;
    return { uid: t.uid, role: normalizeRole(snap.data()?.role), name: String(snap.data()?.name ?? '') };
  } catch {
    return null;
  }
}

export async function requireChef(req: any) {
  const u = await requireUser(req);
  return u && u.role === 'chef' ? u : null;
}

// Sposta nel database riservato (credentials) i PIN ancora in chiaro dei vecchi account.
export async function migrateLegacyPins() {
  const db = getDb();
  const snap = await db.collection('users').get();
  for (const d of snap.docs) {
    const pin = d.data().pin;
    if (typeof pin !== 'string') continue;
    const ref = db.collection('credentials').doc(d.id);
    const ex = await ref.get();
    if (!ex.exists || !ex.data()?.hash) {
      await ref.set({ ...hashPin(pin), fails: 0, lockedUntil: 0 }, { merge: true });
    }
    await d.ref.update({ pin: FieldValue.delete() });
  }
}
