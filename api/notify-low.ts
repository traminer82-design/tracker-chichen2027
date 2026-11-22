import { admin, getDb, initAdmin, requireUser } from './_lib.js';

initAdmin();

// Avvisa lo Chef (notifica push ad app chiusa) quando un prodotto va sotto la soglia minima.
// Un solo avviso per prodotto ogni ora, controllato su Firestore (vale anche tra più istanze del server).
const COOLDOWN_MS = 60 * 60 * 1000;

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).send('Metodo non consentito');
  if (!admin.apps.length) return res.status(200).json({ skipped: 'FCM non configurato' });
  if (!(await requireUser(req))) return res.status(401).send('Non autorizzato');

  const name = String(req.body?.name ?? '').slice(0, 60).trim();
  const quantity = Number(req.body?.quantity);
  const unit = String(req.body?.unit ?? '').slice(0, 8);
  if (!name || !Number.isFinite(quantity)) return res.status(400).send('Dati non validi');

  const db = getDb();

  // Anti-raffica: salta se già avvisato da meno di un'ora.
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80) || 'prodotto';
  const ref = db.collection('lowStockAlerts').doc(key);
  const last = (await ref.get()).data()?.sentAt;
  const lastMs = typeof last?.toMillis === 'function' ? last.toMillis() : 0;
  if (Date.now() - lastMs < COOLDOWN_MS) return res.status(200).json({ sent: 0, skipped: 'già avvisato' });

  const snap = await db.collection('pushTokens').where('role', '==', 'chef').get();
  const tokens = snap.docs.map((d) => d.data().token).filter(Boolean);
  if (tokens.length === 0) return res.status(200).json({ sent: 0 });

  const finito = quantity <= 0;
  const response = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: {
      title: finito ? `Finito: ${name}` : `Scorta bassa: ${name}`,
      body: finito ? `${name} è finito. Da riordinare.` : `Ne restano ${quantity} ${unit}. Da riordinare.`,
    },
    android: { priority: 'high', notification: { sound: 'default', channelId: 'kitchenos_orders' } },
    webpush: { headers: { Urgency: 'high' } },
  });

  await ref.set({ sentAt: admin.firestore.Timestamp.now(), name }).catch(() => {});
  res.status(200).json({ sent: response.successCount });
}
