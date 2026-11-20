import { admin, getDb, initAdmin, requireChef } from './_lib.js';

// Notifica di prova allo Chef che la richiede: verifica server, chiave e dispositivo registrato.
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).send('Metodo non consentito');
  if (!initAdmin()) return res.status(503).send('Server non configurato (FIREBASE_SERVICE_ACCOUNT mancante).');

  const chef = await requireChef(req);
  if (!chef) return res.status(403).send('Solo lo Chef può inviare la notifica di prova.');

  const ref = getDb().collection('pushTokens').doc(chef.uid);
  const token = (await ref.get()).data()?.token;
  if (!token) return res.status(409).send('Nessun dispositivo registrato: tocca "Attiva notifiche".');

  // Ritardo facoltativo (max 8 s) per dare il tempo di chiudere l'app.
  const delay = Math.min(8000, Math.max(0, Number(req.body?.delay) || 0));
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));

  try {
    await admin.messaging().send({
      token,
      notification: {
        title: 'KitchenOS · notifica di prova',
        body: 'Se la vedi ad app chiusa, le notifiche funzionano.',
      },
      webpush: { headers: { Urgency: 'high' } },
    });
    return res.status(200).json({ sent: 1 });
  } catch (e: any) {
    const code = String(e?.code ?? '');
    if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
      await ref.delete().catch(() => {});
      return res.status(410).send('Il dispositivo registrato non è più valido: tocca di nuovo "Attiva notifiche".');
    }
    return res.status(500).send(`Invio non riuscito: ${e?.message ?? 'errore FCM'}`);
  }
}
