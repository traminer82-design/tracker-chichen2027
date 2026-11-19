import express from 'express';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import path from 'path';
import notifyOrderHandler from './api/notify-order.js';

dotenv.config();

const app = express();
app.use(express.json({ limit: '16kb' }));

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

// Un solo avviso per prodotto ogni ora, per evitare email a raffica.
const lastSent = new Map<string, number>();
const COOLDOWN = 60 * 60 * 1000;

app.post('/api/send-alert', async (req, res) => {
  const name = String(req.body?.itemName ?? '').slice(0, 60).trim();
  const quantity = Number(req.body?.quantity);
  const unit = String(req.body?.unit ?? '').slice(0, 10);
  if (!name || !Number.isFinite(quantity)) return res.status(400).send('Dati non validi');

  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS || !process.env.ALERT_TO) {
    return res.status(503).send('Email non configurata');
  }
  const now = Date.now();
  if (now - (lastSent.get(name) ?? 0) < COOLDOWN) return res.status(200).send('Già avvisato');

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.ALERT_TO,
      subject: quantity === 0 ? `Finito: ${name}` : `Scorta bassa: ${name}`,
      text: `${name}: ne restano ${quantity} ${unit}. Da riordinare.`,
    });
    lastSent.set(name, now);
    res.status(200).send('Avviso inviato');
  } catch (error) {
    console.error('Errore invio email:', error);
    res.status(500).send('Errore invio email');
  }
});

app.post('/api/notify-order', async (req, res) => {
  await notifyOrderHandler(req, res);
});

async function start() {
  if (process.env.NODE_ENV === 'production') {
    const dist = path.resolve('dist');
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  } else {
    // In sviluppo Vite gira dentro lo stesso server: basta "npm run dev".
    const { createServer } = await import('vite');
    const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  }
  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, '0.0.0.0', () => console.log(`KitchenOS su http://localhost:${PORT}`));
}
start();
