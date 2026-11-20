# KitchenOS

Richieste merce e ordini di cucina in tempo reale: **3 cuochi** inviano le richieste, lo **chef** le gestisce.

## Flusso

1. **Da ordinare** – i cuochi inviano una richiesta (prodotti, quantità, unità kg/lt/crt/pz/conf, fornitore, tag rapidi: Urgente, Scorta bassa, Colazione, Servizio, nota). Le urgenti salgono in cima.
2. **Ordinato** – lo chef tocca *Segna Ordinato*; tutti vedono data/ora e nome di chi ha ordinato.
3. **Archiviato** – quando la merce arriva lo chef tocca *Merce arrivata · Archivia*. Storico consultabile.

## Cosa sanno i cuochi

- **Stato merce per prodotto**: vista che separa *In attesa di essere ordinata* e *Già ordinata (in arrivo)*, con quantità totali, chi l'ha chiesta, data/ora e nome dello chef.
- **Anti-doppioni**: nella nuova richiesta ogni prodotto mostra se è già in attesa o già ordinato, prima di inviarlo.
- **Avvisi**: quando lo chef segna "Ordinato", il cuoco riceve banner + suono (+ notifica push se attiva); la scheda Ordinato mostra "N nuovi" finché non la apre.
- **Ripeti richiesta** da una richiesta ordinata/archiviata, e **ritiro/modifica** della propria richiesta finché è "Da ordinare".

## Extra per lo chef

Riepilogo accorpato per fornitore, **condividi/copia lista** (es. WhatsApp al fornitore), **Segna tutte Ordinate** e **export CSV** dell'archivio.

Ogni passaggio ha **Annulla** (7 secondi) e, sulla card, un tasto per tornare indietro di un passo.

## Permessi

| | Cuoco | Chef |
|---|---|---|
| Creare richieste | ✅ | ✅ |
| Vedere tutte le richieste e gli stati | ✅ | ✅ |
| Modificare/ritirare la *propria* richiesta finché è Da ordinare | ✅ | ✅ |
| Modificare qualsiasi richiesta, in qualunque stato | ❌ | ✅ |
| Ordinare, archiviare, ripristinare, eliminare, accorpare, esportare | ❌ | ✅ |
| Gestire account e PIN, catalogo, soglie scorta | ❌ | ✅ |

## Accessi e sicurezza

- **Lo Chef è il supervisore di tutto**: crea, modifica ed elimina gli account dei cuochi dall'app (scheda *Account*), imposta i PIN, gestisce catalogo e soglie, ordina/archivia/ripristina ed elimina qualsiasi richiesta.
- Il **PIN è verificato solo dal server** (`/api/login`): non è mai salvato in chiaro né letto dal browser. 5 PIN errati bloccano l'account per 10 minuti. Il server restituisce un token Firebase e le **regole Firestore** applicano davvero i permessi (cuoco/chef) leggendo il ruolo dall'account.
- Gli account si creano/modificano solo tramite `/api/admin-users`, riservato allo Chef.
- Serve la variabile `FIREBASE_SERVICE_ACCOUNT` su Vercel (chiave account di servizio Firebase). Senza, nessuno può accedere.

### Messa in produzione (in quest'ordine)

1. Imposta `FIREBASE_SERVICE_ACCOUNT` su Vercel (e opzionalmente `FIRESTORE_DATABASE_ID`).
2. Pubblica il codice (GitHub → Vercel).
3. Lo Chef apre l'app e fa login con nome + PIN attuale: il server sposta tutti i PIN esistenti in un archivio protetto e li rimuove dagli account.
4. **Solo dopo**, pubblica `firestore.rules` dalla console Firebase.
5. Ogni cuoco rifà il login una volta (le vecchie sessioni vengono chiuse).

## Compatibilità dati esistenti

Account, richieste e catalogo restano. Nessuna migrazione manuale dei ruoli/stati: i vecchi valori vengono letti come `operatore→cuoco`, `responsabile→chef`, `pending→inviata`, `received→ordinata`, `done→archiviata`.

## Avvio in locale

1. `npm install`
2. Copia `.env.example` in `.env` (email avvisi scorta)
3. `npm run dev` → http://localhost:3000

## Pubblicazione

Repository su GitHub → importato su Vercel. Variabili: `EMAIL_USER`, `EMAIL_PASS`, `ALERT_TO`, `FIREBASE_SERVICE_ACCOUNT`, `VITE_FIREBASE_VAPID_KEY`.
Le notifiche push usano `api/notify-order` (chef) e `api/notify-status` (cuochi). Ogni utente deve fare login una volta per registrare il proprio dispositivo.
Dopo ogni modifica a `firestore.rules`, pubblicale dalla console Firebase (o con `firebase deploy --only firestore:rules`).

## Offline

Se manca la rete compare un avviso; le richieste restano salvate sul telefono e partono al ritorno della connessione (le card mostrano "in attesa di sincronizzazione").
