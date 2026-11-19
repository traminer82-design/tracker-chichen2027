import admin from 'firebase-admin';

if (!admin.apps.length && process.env.FIREBASE_SERVICE_ACCOUNT) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).send('Metodo non consentito');
  if (!admin.apps.length) return res.status(200).json({ skipped: 'FCM non configurato' });

  const { operatorName, lines } = req.body || {};
  if (!operatorName || !Array.isArray(lines)) return res.status(400).send('Dati non validi');

  const db = admin.firestore();
  const snap = await db.collection('pushTokens').get();
  const tokens = snap.docs.map((d) => d.data().token).filter(Boolean);
  if (tokens.length === 0) return res.status(200).json({ sent: 0 });

  const body = lines.map((l: any) => `${l.name}: ${l.quantity} ${l.unit}`).join(', ');

  const response = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: {
      title: `Nuovo ordine da ${operatorName}`,
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
