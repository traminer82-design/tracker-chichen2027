# KitchenOS

Gestione inventario cucina in tempo reale con account multipli, ordini e notifiche.

## Funzionalità

- **Giacenza** – traccia le merci in magazzino, imposta la soglia minima e ricevi un avviso (email + toast) quando scende sotto scorta.
- **Catalogo / Storico** – elenco condiviso delle derrate. Una volta inserito un prodotto, compare a tutti: non serve più digitarlo a mano. Dalla ricerca in Giacenza puoi aggiungerlo in un tap.
- **Categorie** – Carne, Pesce, Verdure, Latticini, Pasticceria, Altro.
- **Account** – crea account solo con il nome (Operatore o Responsabile) direttamente dall’app.
- **Ordini** – gli operatori selezionano i prodotti (soprattutto quelli sotto scorta) e inviano un ordine.
- **Notifiche** – quando arriva un ordine, il Responsabile riceve notifica browser + suono nell’app.

## Avvio in locale

1. `npm install`
2. Copia `.env.example` in `.env` e compila i valori (email per gli avvisi di scorta)
3. `npm run dev` e apri http://localhost:3000

## Pubblicazione su Vercel

Importa il repository su vercel.com e aggiungi le variabili `EMAIL_USER`, `EMAIL_PASS`, `ALERT_TO`.

## Primo avvio

1. Apri l’app → crea il primo account (diventa Responsabile).
2. Nella sezione **Account** crea gli account degli operatori (solo nome).
3. Ogni persona sceglie il proprio nome alla login.
4. Aggiungi prodotti in **Giacenza**: vengono salvati automaticamente nel **Catalogo**.
5. Gli operatori vanno su **Ordini → Nuovo ordine**, selezionano i prodotti e inviano.
6. Il Responsabile riceve subito la notifica (suono + popup browser se autorizzato).
