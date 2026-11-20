import { admin, getDb, initAdmin, requireUser } from './_lib.js';

initAdmin();

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).send('Metodo non consentito');
  if (!admin.apps.length) return res.status(200).json({ skipped: 'FCM non configurato' });
  if (!(await requireUser(req))) return res.status(401).send('Non autorizzato');

  const { operatorName, lines } = req.body || {};
  if (typeof operatorName !== 'string' || !operatorName || !Array.isArray(lines) || lines.length === 0 || lines.length > 50) {
    return res.status(400).send('Dati non validi');
  }

  const db = getDb();
  const snap = await db.collection('pushTokens').where('role', '==', 'chef').get();
  const tokens = snap.docs.map((d) => d.data().token).filter(Boolean);
  if (tokens.length === 0) return res.status(200).json({ sent: 0 });

  const body = lines
    .map((l: any) => `${String(l.name).slice(0, 40)}: ${Number(l.quantity)} ${String(l.unit).slice(0, 8)}`)
    .join(', ')
    .slice(0, 300);

  const response = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: {
      title: `Nuova richiesta da ${String(operatorName).slice(0, 40)}`,
      body,
    },
    android: {
      priority: 'high',
      notification: {
        sound: 'default',
        channelId: 'kitchenos_orders',
      },
    },
    webpush: {
      headers: { Urgency: 'high' },
    },
  });

  res.status(200).json({ sent: response.successCount });
}
