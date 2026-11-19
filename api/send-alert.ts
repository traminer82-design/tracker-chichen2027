// Funzione serverless per Vercel: stessa logica di /api/send-alert in server.ts
import nodemailer from 'nodemailer';

// Best-effort: su Vercel la memoria si azzera ogni tanto, quindi l'anti-doppione non è garantito.
const lastSent = new Map<string, number>();
const COOLDOWN = 60 * 60 * 1000;

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).send('Metodo non consentito');

  const name = String(req.body?.itemName ?? '').slice(0, 60).trim();
  const quantity = Number(req.body?.quantity);
  const unit = String(req.body?.unit ?? '').slice(0, 10);
  if (!name || !Number.isFinite(quantity)) return res.status(400).send('Dati non validi');

  const { EMAIL_USER, EMAIL_PASS, ALERT_TO } = process.env;
  if (!EMAIL_USER || !EMAIL_PASS || !ALERT_TO) return res.status(503).send('Email non configurata');

  const now = Date.now();
  if (now - (lastSent.get(name) ?? 0) < COOLDOWN) return res.status(200).send('Già avvisato');

  try {
    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_USER, pass: EMAIL_PASS } });
    await transporter.sendMail({
      from: EMAIL_USER,
      to: ALERT_TO,
      subject: quantity === 0 ? `Finito: ${name}` : `Scorta bassa: ${name}`,
      text: `${name}: ne restano ${quantity} ${unit}. Da riordinare.`,
    });
    lastSent.set(name, now);
    res.status(200).send('Avviso inviato');
  } catch (e) {
    console.error('Errore invio email:', e);
    res.status(500).send('Errore invio email');
  }
}
