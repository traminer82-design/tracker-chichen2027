import { admin, getDb, initAdmin, requireUser } from './_lib.js';

initAdmin();

// Avvisa i cuochi quando lo chef segna la loro merce come "Ordinata".
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).send('Metodo non consentito');
  if (!admin.apps.length) return res.status(200).json({ skipped: 'FCM non configurato' });
  if (!(await requireUser(req))) return res.status(401).send('Non autorizzato');

  const { userIds, chefName, products } = req.body || {};
  if (
    !Array.isArray(userIds) || userIds.length === 0 || userIds.length > 10 ||
    !Array.isArray(products) || products.length === 0
  ) {
    return res.status(400).send('Dati non validi');
  }

  const db = getDb();
  const refs = userIds.map((id: unknown) => db.collection('pushTokens').doc(String(id).slice(0, 100)));
  const snaps = await db.getAll(...refs);
  const tokens = snaps.map((s) => s.data()?.token).filter(Boolean);
  if (tokens.length === 0) return res.status(200).json({ sent: 0 });

  const body = products
    .slice(0, 20)
    .map((p: unknown) => String(p).slice(0, 40))
    .join(', ')
    .slice(0, 300);

  const response = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: {
      title: chefName ? `Merce ordinata da ${String(chefName).slice(0, 40)}` : 'Merce ordinata',
      body,
    },
    android: { priority: 'high', notification: { sound: 'default', channelId: 'kitchenos_orders' } },
    webpush: { headers: { Urgency: 'high' } },
  });

  res.status(200).json({ sent: response.successCount });
}
