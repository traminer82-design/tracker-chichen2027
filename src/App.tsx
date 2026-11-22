import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  addDoc,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import {
  Archive,
  Bell,
  Settings,
  Check,
  CheckCheck,
  ChefHat,
  ClipboardList,
  KeyRound,
  Lock,
  LogOut,
  Minus,
  Package,
  Pencil,
  Plus,
  Search,
  Send,
  Share2,
  ShoppingBasket,
  Snowflake,
  Trash2,
  Undo2,
  UserPlus,
  Users,
  Volume2,
  WifiOff,
  X,
} from 'lucide-react';
import { onAuthStateChanged, signInWithCustomToken, signOut } from 'firebase/auth';
import { auth, db } from './firebase';

/* ─── Tipi ─────────────────────────────────────────────── */
type Role = 'cuoco' | 'chef';
type OrderStatus = 'inviata' | 'ordinata' | 'archiviata';
type TS = { seconds: number };
type Category = 'carne' | 'pesce' | 'fondi' | 'pasta_fresca' | 'altro';
type StorageZone = 'cella_congelamento' | 'magazzino';
type OrderUnit = 'kg' | 'l' | 'cartoni' | 'pezzi' | 'conf';

type User = { id: string; name: string; role: Role };
type Product = {
  id: string;
  name: string;
  category: Category;
  unit: string;
  defaultMin: number;
};
type Item = {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  min: number;
  category: Category;
  zone: StorageZone;
  productId?: string;
  updatedAt?: TS | null;
  updatedBy?: string;
  lastDelta?: number;
};
type Draft = {
  id?: string;
  name: string;
  quantity: number;
  unit: string;
  min: number;
  category: Category;
  zone: StorageZone;
  productId?: string;
};
type OrderLine = {
  productKey: string;
  name: string;
  quantity: number;
  unit: OrderUnit;
  category: Category;
};
type Order = {
  id: string;
  operatorId: string;
  operatorName: string;
  lines: OrderLine[];
  note: string;
  tags: string[];
  supplier: string;
  status: OrderStatus;
  createdAt?: TS | null;
  orderedAt?: TS | null;
  orderedByName?: string;
  orderedById?: string;
  archivedAt?: TS | null;
  archivedByName?: string;
  editedByName?: string;
  pending?: boolean; // scritture locali non ancora confermate dal server
};

const STOCK_UNITS = ['kg', 'l', 'cartoni', 'pezzi', 'conf.'];
const ORDER_UNITS: OrderUnit[] = ['kg', 'l', 'cartoni', 'pezzi', 'conf'];
const UNIT_LABEL: Record<OrderUnit, string> = { kg: 'kg', l: 'lt', cartoni: 'crt', pezzi: 'pz', conf: 'conf' };

const CATEGORIES: { id: Category; label: string; emoji: string }[] = [
  { id: 'carne', label: 'Carne', emoji: '🥩' },
  { id: 'pesce', label: 'Pesce', emoji: '🐟' },
  { id: 'fondi', label: 'Fondi', emoji: '🍲' },
  { id: 'pasta_fresca', label: 'Pasta fresca', emoji: '🍝' },
  { id: 'altro', label: 'Altro', emoji: '📦' },
];

// I vecchi prodotti con altre categorie (verdure, latticini, pasticceria…) finiscono in "Altro".
function normalizeCategory(c?: string): Category {
  const k = String(c ?? '').toLowerCase().trim().replace(/\s+/g, '_');
  if (k === 'carne' || k === 'pesce' || k === 'fondi') return k;
  if (k === 'pasta_fresca' || k === 'pasta') return 'pasta_fresca';
  return 'altro';
}

const itemsCol = collection(db, 'items');
const usersCol = collection(db, 'users');
const ordersCol = collection(db, 'orders');
const productsCol = collection(db, 'products');

const isLow = (i: Item) => i.quantity <= i.min;

// Legge un articolo anche dai vecchi documenti (campo "threshold" al posto di "min", categorie diverse).
function toItem(id: string, data: Record<string, any>): Item {
  const min =
    typeof data.min === 'number' ? data.min : typeof data.threshold === 'number' ? data.threshold : 1;
  return {
    ...data,
    id,
    name: data.name ?? '?',
    quantity: typeof data.quantity === 'number' ? data.quantity : 0,
    unit: data.unit ?? 'kg',
    zone: data.zone ?? 'cella_congelamento',
    category: normalizeCategory(data.category),
    min,
  } as Item;
}

// Accesso: il PIN è verificato dal server, che restituisce un token Firebase.
async function authWithServer(url: string, body: object): Promise<string | null> {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.status === 401) return 'PIN errato';
    if (r.status === 429) {
      const j = await r.json().catch(() => ({}) as { retryInMin?: number });
      return `Troppi tentativi. Riprova tra ${j.retryInMin ?? 10} minuti.`;
    }
    if (r.status === 503) return 'Server non configurato: avvisa lo chef.';
    if (!r.ok) return (await r.text().catch(() => '')) || 'Accesso non riuscito.';
    const { token } = await r.json();
    await signInWithCustomToken(auth, token);
    return null;
  } catch {
    return 'Serve la connessione per accedere.';
  }
}

async function postAuthed(url: string, body: object): Promise<Response> {
  const tok = await auth.currentUser?.getIdToken();
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify(body),
  });
}

// Notifiche push best-effort (non bloccano mai l'interfaccia).
function authedPost(url: string, body: object) {
  postAuthed(url, body).catch(() => {});
}

// Gestione account (solo Chef, verificato dal server). Restituisce il messaggio d'errore o null.
async function adminCall(body: object): Promise<string | null> {
  try {
    const r = await postAuthed('/api/admin-users', body);
    if (r.ok) return null;
    return (await r.text().catch(() => '')) || 'Operazione non riuscita';
  } catch {
    return 'Serve la connessione per gestire gli account.';
  }
}

// Compatibilità con i dati già presenti (operatore/responsabile, pending/received/done).
function normalizeRole(r?: string): Role {
  return r === 'chef' || r === 'responsabile' ? 'chef' : 'cuoco';
}
function normalizeStatus(s?: string): OrderStatus {
  if (s === 'ordinata' || s === 'received') return 'ordinata';
  if (s === 'archiviata' || s === 'done') return 'archiviata';
  return 'inviata';
}

function normalizeOrderUnit(u?: string): OrderUnit {
  if (!u) return 'kg';
  const low = u.toLowerCase().trim();
  if (low === 'conf' || low === 'conf.' || low === 'confezioni' || low === 'confezione') return 'conf';
  if (low === 'l' || low === 'lt' || low === 'litri') return 'l';
  if (low === 'cartoni' || low === 'cartone' || low === 'ct' || low === 'crt') return 'cartoni';
  if (low === 'pezzi' || low === 'pz' || low === 'pezzo') return 'pezzi';
  return 'kg';
}

/* ─── Suono notifica (doppio squillo ad alto volume) ──── */
function playNotifySound(force = false) {
  if (!force && localStorage.getItem('kitchenos-sound') === 'off') return;
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new AudioCtx();
    const notes = [880, 1174.66, 1318.51];
    notes.forEach((freq, idx) => {
      const start = ctx.currentTime + idx * 0.16;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.frequency.value = freq;
      o.type = 'triangle';
      g.gain.setValueAtTime(0.4, start);
      g.gain.exponentialRampToValueAtTime(0.01, start + 0.35);
      o.start(start);
      o.stop(start + 0.35);
    });
    if ('vibrate' in navigator) {
      navigator.vibrate([250, 100, 250, 100, 400]);
    }
  } catch {
    /* silenzioso se bloccato prima dell'interazione */
  }
}

async function sendEmailAlert(i: Item, quantity: number) {
  try {
    await fetch('/api/send-alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemName: i.name, quantity, unit: i.unit }),
    });
  } catch {
    /* best-effort */
  }
}

async function showPushNotification(title: string, body: string) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }
  if (Notification.permission !== 'granted') return;

  const options: NotificationOptions = {
    body,
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    tag: 'kitchenos-order-' + Date.now(),
    requireInteraction: true,
  };

  if ('serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) {
      await reg.showNotification(title, options);
      return;
    }
  }
  new Notification(title, options);
}

/* ─── App principale ───────────────────────────────────── */
export default function App() {
  const [users, setUsers] = useState<User[]>([]);
  const [authUid, setAuthUid] = useState<string | null | undefined>(undefined);
  const currentUser = useMemo<User | null>(
    () => users.find((u) => u.id === authUid) ?? null,
    [users, authUid],
  );
  const [booting, setBooting] = useState(true);
  const [usersError, setUsersError] = useState('');
  const [tab, setTab] = useState<'giacenza' | 'ordini' | 'impostazioni'>('ordini');
  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersError, setOrdersError] = useState('');
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const knownOrderIds = useRef<Set<string>>(new Set());
  const initialOrdersLoaded = useRef(false);
  const prevStatus = useRef<Map<string, OrderStatus>>(new Map());
  const [flash, setFlash] = useState('');
  const [seenOrdered, setSeenOrdered] = useState<number | null>(null);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  useEffect(() => onAuthStateChanged(auth, (u) => setAuthUid(u ? u.uid : null)), []);

  // Account eliminato dallo chef: esce subito.
  useEffect(() => {
    if (authUid && !booting && users.length > 0 && !users.some((u) => u.id === authUid)) {
      signOut(auth).catch(() => {});
    }
  }, [authUid, booting, users]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(''), 10000);
    return () => clearTimeout(t);
  }, [flash]);

  // Ultimo momento in cui il cuoco ha guardato la sezione "Ordinato" (per evidenziare le novità).
  useEffect(() => {
    if (!currentUser) {
      setSeenOrdered(null);
      return;
    }
    const k = `kitchenos-seen-${currentUser.id}`;
    const v = localStorage.getItem(k);
    if (v) setSeenOrdered(Number(v));
    else {
      const now = Math.floor(Date.now() / 1000);
      localStorage.setItem(k, String(now));
      setSeenOrdered(now);
    }
  }, [currentUser?.id]);

  useEffect(() => {
    const unsub = onSnapshot(
      query(usersCol, orderBy('name')),
      (snap) => {
        const list: User[] = snap.docs.map((d) => {
          const data = d.data() as { name?: string; pin?: string; role?: string };
          return {
            id: d.id,
            name: data.name ?? '?',
            role: normalizeRole(data.role),
          };
        });
        setUsers(list);
        setUsersError('');
        setBooting(false);
      },
      () => {
        setUsersError('Impossibile caricare gli account. Controlla la connessione.');
        setBooting(false);
      },
    );
    return unsub;
  }, []);

  // Un solo ascolto in tempo reale delle richieste, condiviso da tutte le schermate.
  useEffect(() => {
    if (!currentUser) {
      setOrders([]);
      initialOrdersLoaded.current = false;
      knownOrderIds.current.clear();
      prevStatus.current = new Map();
      return;
    }
    const meId = currentUser.id;
    const meChef = currentUser.role === 'chef';

    const unsub = onSnapshot(
      query(ordersCol, orderBy('createdAt', 'desc'), limit(300)),
      (snap) => {
        const list: Order[] = snap.docs.map((d) => {
          const data = d.data() as Record<string, any>;
          return {
            ...(data as object),
            id: d.id,
            status: normalizeStatus(data.status),
            note: data.note ?? '',
            tags: Array.isArray(data.tags) ? data.tags : [],
            supplier: data.supplier ?? '',
            lines: Array.isArray(data.lines) ? data.lines : [],
            pending: d.metadata.hasPendingWrites,
          } as Order;
        });
        setOrders(list);
        setOrdersError('');

        // Il cuoco viene avvisato quando lo chef segna "Ordinato" (suono + banner + notifica).
        const justOrdered = list.filter(
          (o) => prevStatus.current.get(o.id) === 'inviata' && o.status === 'ordinata' && !o.pending,
        );
        prevStatus.current = new Map(list.map((o) => [o.id, o.status]));
        if (!meChef && initialOrdersLoaded.current && justOrdered.length > 0) {
          playNotifySound();
          const names = justOrdered
            .flatMap((o) => o.lines.map((l) => l.name))
            .slice(0, 6)
            .join(', ');
          setFlash(`Ordinato dallo chef: ${names}`);
        }

        if (!initialOrdersLoaded.current) {
          list.forEach((o) => knownOrderIds.current.add(o.id));
          initialOrdersLoaded.current = true;
          return;
        }
        list.forEach((o) => {
          if (knownOrderIds.current.has(o.id)) return;
          knownOrderIds.current.add(o.id);
          if (meChef && o.status === 'inviata' && o.operatorId !== meId && !o.pending) {
            playNotifySound();
            const summary = o.lines
              .map((l) => `${l.name} (${l.quantity} ${UNIT_LABEL[l.unit] ?? l.unit})`)
              .join(', ');
            showPushNotification(`Nuova richiesta da ${o.operatorName}`, summary);
          }
        });
      },
      () => setOrdersError('Sincronizzazione richieste non riuscita. Riprovo appena possibile.'),
    );
    return unsub;
  }, [currentUser?.id, currentUser?.role]);

  // Notifiche push ad app chiusa: SOLO lo Chef registra il proprio dispositivo.
  useEffect(() => {
    if (!currentUser) return;
    const u = currentUser;
    if (u.role !== 'chef') {
      deleteDoc(doc(db, 'pushTokens', u.id)).catch(() => {}); // pulizia di eventuali vecchi token
      return;
    }
    (async () => {
      try {
        if ('Notification' in window && Notification.permission === 'default') {
          await Notification.requestPermission();
        }
        const { registerPushToken } = await import('./firebase');
        const token = await registerPushToken();
        if (token) {
          await setDoc(doc(db, 'pushTokens', u.id), {
            token,
            userId: u.id,
            userName: u.name,
            role: u.role,
            updatedAt: serverTimestamp(),
          });
        }
      } catch {
        /* FCM opzionale se non ancora configurato con VAPID key */
      }
    })();
  }, [currentUser?.id, currentUser?.role]);

  const login = (userId: string, pin: string) => authWithServer('/api/login', { userId, pin });
  const setupFirst = (name: string, pin: string) => authWithServer('/api/setup', { name, pin });

  function logout() {
    signOut(auth).catch(() => {});
    setTab('ordini');
  }

  if (booting || authUid === undefined) {
    return <div className="grid min-h-dvh place-items-center text-ink/50">Caricamento…</div>;
  }

  if (usersError && users.length === 0) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 px-6 text-center">
        <WifiOff className="mx-auto size-12 text-tomato" />
        <p className="text-lg font-semibold">{usersError}</p>
        <button
          onClick={() => window.location.reload()}
          className="h-14 rounded-2xl bg-basil text-lg font-semibold text-white"
        >
          Riprova
        </button>
      </div>
    );
  }

  if (!currentUser) {
    return <LoginScreen users={users} onLogin={login} onSetup={setupFirst} />;
  }

  const isChef = currentUser.role === 'chef';
  const newCount = orders.filter((o) => o.status === 'inviata').length;
  const me = currentUser;
  const newOrdered =
    isChef || seenOrdered === null
      ? 0
      : orders.filter((o) => o.status === 'ordinata' && o.orderedAt && o.orderedAt.seconds > seenOrdered)
          .length;
  function markSeen() {
    const t = Math.max(seenOrdered ?? 0, ...orders.map((o) => o.orderedAt?.seconds ?? 0));
    if (t === seenOrdered) return;
    setSeenOrdered(t);
    localStorage.setItem(`kitchenos-seen-${me.id}`, String(t));
  }

  return (
    <div className="mx-auto min-h-dvh max-w-xl pb-24 pt-4">
      <header className="mb-3 flex items-center justify-between px-4">
        <div>
          <h1 className="font-display text-3xl font-extrabold tracking-tight">KitchenOS</h1>
          <p className="text-sm text-ink/60">
            {currentUser.name} · {isChef ? 'Chef' : 'Cuoco'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isChef && (
            <button
              onClick={() => {
                playNotifySound(true);
                showPushNotification('Test Notifica KitchenOS', 'Audio e notifiche attivi.');
              }}
              title="Testa suono notifica"
              className="grid size-11 place-items-center rounded-full bg-white text-basil ring-1 ring-ink/10"
            >
              <Volume2 className="size-5" />
            </button>
          )}
          <button
            onClick={logout}
            className="flex h-11 items-center gap-2 rounded-full bg-white px-4 text-sm font-semibold ring-1 ring-ink/10"
          >
            <LogOut className="size-4" /> Esci
          </button>
        </div>
      </header>

      <ConnectionBanner online={online} error={ordersError} />
      {flash && (
        <div
          role="status"
          className="mx-4 mb-3 flex items-start gap-2 rounded-xl bg-basil px-3 py-2.5 text-sm font-semibold text-white"
        >
          <CheckCheck className="mt-0.5 size-4 shrink-0" />
          <button className="flex-1 text-left" onClick={() => setTab('ordini')}>
            {flash}
          </button>
          <button onClick={() => setFlash('')} aria-label="Chiudi">
            <X className="size-4" />
          </button>
        </div>
      )}

      {tab === 'ordini' && (
        <OrdersSection
          currentUser={currentUser}
          users={users}
          orders={orders}
          online={online}
          newOrdered={newOrdered}
          onSeenOrdered={markSeen}
        />
      )}
      {tab === 'giacenza' && <InventorySection currentUser={currentUser} />}
      {tab === 'impostazioni' && isChef && <SettingsSection currentUser={currentUser} users={users} />}

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-ink/10 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-xl justify-around py-2">
          <NavBtn
            active={tab === 'ordini'}
            onClick={() => setTab('ordini')}
            icon={<ShoppingBasket className="size-5" />}
            label="Ordini"
            badge={isChef ? newCount : newOrdered}
          />
          <NavBtn
            active={tab === 'giacenza'}
            onClick={() => setTab('giacenza')}
            icon={<Package className="size-5" />}
            label="Giacenza"
          />
          {isChef && (
            <NavBtn
              active={tab === 'impostazioni'}
              onClick={() => setTab('impostazioni')}
              icon={<Settings className="size-5" />}
              label="Impostazioni"
            />
          )}
        </div>
      </nav>
    </div>
  );
}

function ConnectionBanner({ online, error }: { online: boolean; error: string }) {
  if (online && !error) return null;
  return (
    <div
      role="alert"
      className={`mx-4 mb-3 flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold ${
        online ? 'bg-tomato/15 text-tomato' : 'bg-amber-100 text-amber-900'
      }`}
    >
      <WifiOff className="mt-0.5 size-4 shrink-0" />
      <span>
        {online
          ? error
          : 'Sei offline. Le richieste restano salvate sul telefono e partono appena torna la rete.'}
      </span>
    </div>
  );
}

function NavBtn({
  active,
  onClick,
  icon,
  label,
  badge = 0,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative flex flex-col items-center gap-0.5 px-5 py-1 text-xs font-semibold ${
        active ? 'text-basil' : 'text-ink/50'
      }`}
    >
      {icon}
      {badge > 0 && (
        <span className="absolute right-2 top-0 grid min-w-5 place-items-center rounded-full bg-tomato px-1 text-[10px] font-bold text-white">
          {badge}
        </span>
      )}
      {label}
    </button>
  );
}

/* ─── Login con PIN ────────────────────────────────────── */
function LoginScreen({
  users,
  onLogin,
  onSetup,
}: {
  users: User[];
  onLogin: (userId: string, pin: string) => Promise<string | null>;
  onSetup: (name: string, pin: string) => Promise<string | null>;
}) {
  const [name, setName] = useState('Simone');
  const [pin, setPin] = useState('');
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [enteredPin, setEnteredPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [busy, setBusy] = useState(false);

  async function createFirst() {
    const n = name.trim();
    if (!n || pin.length < 4 || busy) return;
    setBusy(true);
    const err = await onSetup(n, pin);
    setBusy(false);
    if (err) setPinError(err);
  }

  async function handleDigit(d: string) {
    if (!selectedUser || enteredPin.length >= 4 || busy) return;
    const next = enteredPin + d;
    setEnteredPin(next);
    setPinError('');
    if (next.length === 4) {
      setBusy(true);
      const err = await onLogin(selectedUser.id, next);
      setBusy(false);
      if (err) {
        setPinError(err);
        setTimeout(() => setEnteredPin(''), 450);
      }
    }
  }

  if (users.length === 0) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-5 px-6">
        <div className="text-center">
          <ChefHat className="mx-auto mb-3 size-14 text-basil" />
          <h1 className="font-display text-3xl font-extrabold">KitchenOS</h1>
          <p className="mt-2 text-ink/60">Configura l&apos;account Chef</p>
        </div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nome Chef (es. Simone)"
          maxLength={40}
          className="h-14 rounded-2xl bg-white px-4 text-lg ring-1 ring-ink/10"
        />
        <input
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={4}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
          placeholder="Scegli un PIN a 4 cifre"
          className="h-14 rounded-2xl bg-white px-4 text-center font-display text-2xl tracking-[0.5em] ring-1 ring-ink/10"
        />
        <button
          onClick={createFirst}
          disabled={!name.trim() || pin.length < 4}
          className="h-14 rounded-2xl bg-basil text-lg font-semibold text-white disabled:opacity-40"
        >
          Crea account Chef
        </button>
        {pinError && <p className="text-center text-sm font-semibold text-tomato">{pinError}</p>}
      </div>
    );
  }

  if (selectedUser) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-xs flex-col justify-center gap-6 px-6">
        <div className="text-center">
          <div className="mx-auto mb-3 grid size-14 place-items-center rounded-full bg-basil/15 font-display text-2xl font-extrabold text-basil">
            {selectedUser.name.charAt(0).toUpperCase()}
          </div>
          <h2 className="font-display text-2xl font-extrabold">{selectedUser.name}</h2>
          <p className="mt-1 text-sm text-ink/60">Inserisci il tuo PIN a 4 cifre</p>
        </div>

        <div className="flex justify-center gap-4">
          {[0, 1, 2, 3].map((idx) => (
            <span
              key={idx}
              className={`size-4 rounded-full transition-all ${
                pinError
                  ? 'bg-tomato scale-110'
                  : idx < enteredPin.length
                    ? 'bg-basil scale-110'
                    : 'bg-ink/15'
              }`}
            />
          ))}
        </div>
        {pinError && <p className="text-center text-sm font-semibold text-tomato">{pinError}</p>}

        <div className="grid grid-cols-3 gap-3">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
            <button
              key={d}
              onClick={() => handleDigit(d)}
              className="h-16 rounded-2xl bg-white font-display text-2xl font-extrabold shadow-sm ring-1 ring-ink/10 active:bg-paper"
            >
              {d}
            </button>
          ))}
          <button
            onClick={() => {
              setSelectedUser(null);
              setEnteredPin('');
              setPinError('');
            }}
            className="h-16 rounded-2xl bg-paper text-sm font-semibold text-ink/60"
          >
            Indietro
          </button>
          <button
            onClick={() => handleDigit('0')}
            className="h-16 rounded-2xl bg-white font-display text-2xl font-extrabold shadow-sm ring-1 ring-ink/10 active:bg-paper"
          >
            0
          </button>
          <button
            onClick={() => {
              setEnteredPin((p) => p.slice(0, -1));
              setPinError('');
            }}
            className="h-16 rounded-2xl bg-paper text-sm font-semibold text-ink/60"
          >
            Canc
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6">
      <div className="text-center">
        <ChefHat className="mx-auto mb-3 size-14 text-basil" />
        <h1 className="font-display text-3xl font-extrabold">KitchenOS</h1>
        <p className="mt-2 text-ink/60">Seleziona il tuo account e inserisci il PIN</p>
      </div>
      <ul className="space-y-2">
        {users.map((u) => (
          <button
            key={u.id}
            onClick={() => {
              setSelectedUser(u);
              setEnteredPin('');
              setPinError('');
            }}
            className="flex h-14 w-full items-center gap-3 rounded-2xl bg-white px-4 text-left shadow-sm ring-1 ring-ink/10 active:bg-paper"
          >
            <span className="grid size-10 place-items-center rounded-full bg-basil/15 text-lg font-bold text-basil">
              {u.name.charAt(0).toUpperCase()}
            </span>
            <div className="flex-1">
              <div className="font-semibold">{u.name}</div>
              <div className="text-xs text-ink/50">
                {u.role === 'chef' ? 'Chef' : 'Cuoco'}
              </div>
            </div>
            <Lock className="size-4 text-ink/30" />
          </button>
        ))}
      </ul>
      <p className="text-center text-sm text-ink/40">
        I cuochi e i relativi PIN vengono creati dallo Chef
      </p>
    </div>
  );
}

/* ─── Sezione Giacenza (Cella di congelamento + Magazzino) */
function InventorySection({ currentUser }: { currentUser: User }) {
  const isResp = currentUser.role === 'chef';
  const [items, setItems] = useState<Item[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [onlyLow, setOnlyLow] = useState(false);
  const [zoneFilter, setZoneFilter] = useState<'tutti' | StorageZone>('tutti');
  const [catTab, setCatTab] = useState<Category | 'tutti'>('tutti');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [adjusting, setAdjusting] = useState<Item | null>(null);
  const [toast, setToast] = useState('');

  useEffect(() => {
    return onSnapshot(
      query(itemsCol, orderBy('name')),
      (snap) => {
        setItems(snap.docs.map((d) => toItem(d.id, d.data() as Record<string, any>)));
        setLoading(false);
      },
      () => {
        setLoading(false);
        setToast('Impossibile caricare la giacenza. Controlla la connessione.');
      },
    );
  }, []);

  useEffect(() => {
    return onSnapshot(query(productsCol, orderBy('name')), (snap) => {
      setProducts(
        snap.docs.map(
          (d) =>
            ({
              unit: 'kg',
              defaultMin: 1,
              ...(d.data() as object),
              category: normalizeCategory((d.data() as { category?: string }).category),
              id: d.id,
            }) as Product,
        ),
      );
    });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const zoneItems = useMemo(() => {
    if (zoneFilter === 'tutti') return items;
    return items.filter((i) => (i.zone ?? 'cella_congelamento') === zoneFilter);
  }, [items, zoneFilter]);

  const low = useMemo(() => zoneItems.filter(isLow), [zoneItems]);

  // La soglia minima è un dato dello Chef: i cuochi non vedono né filtrano per "sotto scorta".
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (onlyLow && isResp ? low : zoneItems).filter((i) => i.name.toLowerCase().includes(q));
  }, [zoneItems, low, onlyLow, search, isResp]);

  const catCounts = useMemo(() => {
    const m: Record<string, number> = {};
    zoneItems.forEach((i) => {
      m[i.category] = (m[i.category] ?? 0) + 1;
    });
    return m;
  }, [zoneItems]);

  const sections = useMemo(
    () =>
      CATEGORIES.filter((c) => catTab === 'tutti' || c.id === catTab)
        .map((c) => ({ cat: c, rows: shown.filter((i) => i.category === c.id) }))
        .filter((s) => catTab !== 'tutti' || s.rows.length > 0),
    [shown, catTab],
  );

  const catalogSuggestions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    const inStock = new Set(items.map((i) => i.name.toLowerCase()));
    return products
      .filter((p) => p.name.toLowerCase().includes(q) && !inStock.has(p.name.toLowerCase()))
      .slice(0, 8);
  }, [products, items, search]);

  // Carico/consumo: aggiorna la quantità senza bloccare l'interfaccia (funziona anche offline).
  function change(i: Item, delta: number) {
    const next = Math.max(0, Number((i.quantity + delta).toFixed(2)));
    const applied = Number((next - i.quantity).toFixed(2));
    if (applied === 0) return;
    updateDoc(doc(db, 'items', i.id), {
      quantity: increment(applied),
      lastDelta: applied,
      updatedBy: currentUser.name,
      updatedAt: serverTimestamp(),
    }).catch(() => setToast('Modifica non salvata. Controlla la connessione e riprova.'));
    if (!isLow(i) && next <= i.min) {
      sendEmailAlert(i, next);
      authedPost('/api/notify-low', { name: i.name, quantity: next, unit: i.unit });
      setToast(isResp ? `${i.name}: scorta bassa, avviso inviato` : `${i.name}: aggiornato`);
    } else {
      setToast(`${i.name}: ${applied > 0 ? '+' : '−'}${Math.abs(applied)} ${i.unit} → ${next}`);
    }
  }

  async function saveToCatalogAndStock(
    name: string,
    category: Category,
    unit: string,
    min: number,
    quantity: number,
    zone: StorageZone,
    itemId?: string,
    productId?: string,
  ) {
    const n = name.trim();
    if (!n) return;

    let pid = productId;
    const existing = products.find((p) => p.name.toLowerCase() === n.toLowerCase());
    if (existing) {
      pid = existing.id;
      await updateDoc(doc(db, 'products', existing.id), {
        name: n,
        category,
        unit,
        ...(isResp ? { defaultMin: min } : {}),
        updatedAt: serverTimestamp(),
      });
    } else {
      const ref = await addDoc(productsCol, {
        name: n,
        category,
        unit,
        defaultMin: isResp ? min : 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      pid = ref.id;
    }

    const before = itemId ? items.find((x) => x.id === itemId)?.quantity ?? quantity : 0;
    const data = {
      name: n,
      quantity,
      unit,
      // Solo lo Chef scrive la soglia; per i cuochi il valore esistente non viene toccato.
      ...(isResp ? { min } : itemId ? {} : { min: 1 }),
      category,
      zone,
      productId: pid,
      lastDelta: Number((quantity - before).toFixed(2)),
      updatedBy: currentUser.name,
      updatedAt: serverTimestamp(),
    };
    if (itemId) await updateDoc(doc(db, 'items', itemId), data);
    else await addDoc(itemsCol, data);
  }

  async function save() {
    if (!draft || !draft.name.trim()) return;
    try {
      await saveToCatalogAndStock(
        draft.name,
        draft.category,
        draft.unit,
        draft.min,
        draft.quantity,
        draft.zone,
        draft.id,
        draft.productId,
      );
      setDraft(null);
      setSearch('');
    } catch {
      setToast('Salvataggio non riuscito. Controlla la connessione e riprova.');
    }
  }

  async function addFromCatalog(p: Product) {
    const targetZone: StorageZone =
      zoneFilter === 'magazzino' ? 'magazzino' : 'cella_congelamento';
    try {
      await addDoc(itemsCol, {
        name: p.name,
        quantity: 0,
        unit: p.unit,
        min: isResp ? p.defaultMin : 1,
        category: p.category,
        zone: targetZone,
        productId: p.id,
        updatedBy: currentUser.name,
        updatedAt: serverTimestamp(),
      });
      setSearch('');
      setToast(`"${p.name}" aggiunto in ${targetZone === 'cella_congelamento' ? 'Cella' : 'Magazzino'}`);
    } catch {
      setToast('Non aggiunto. Controlla la connessione e riprova.');
    }
  }

  async function remove() {
    if (!draft?.id || !isResp) return;
    try {
      await deleteDoc(doc(db, 'items', draft.id));
      setDraft(null);
    } catch {
      setToast('Eliminazione non riuscita.');
    }
  }

  async function shareList() {
    const text =
      'Sotto scorta:\n' + low.map((i) => `- ${i.name} (${i.quantity}/${i.min} ${i.unit})`).join('\n');
    if (navigator.share) {
      try {
        await navigator.share({ text });
      } catch {
        /* annullato */
      }
    } else {
      await navigator.clipboard.writeText(text);
      setToast('Lista copiata');
    }
  }

  const exact = items.some((i) => i.name.toLowerCase() === search.trim().toLowerCase());
  const exactInCatalog = products.some((p) => p.name.toLowerCase() === search.trim().toLowerCase());
  const newDraft = (name: string): Draft => ({
    name,
    quantity: 1,
    unit: 'kg',
    min: 1,
    category: catTab === 'tutti' ? 'altro' : catTab,
    zone: zoneFilter === 'magazzino' ? 'magazzino' : 'cella_congelamento',
  });

  function renderRow(i: Item) {
    const lowNow = isResp && isLow(i);
    const last =
      i.updatedBy && typeof i.lastDelta === 'number' && i.lastDelta !== 0
        ? `${i.updatedBy} ${i.lastDelta > 0 ? '+' : '−'}${Math.abs(i.lastDelta)}${
            i.updatedAt ? ` · ${fmtTs(i.updatedAt)}` : ''
          }`
        : '';
    return (
      <li
        key={i.id}
        className={`flex items-center gap-2 rounded-2xl bg-white p-2.5 pl-3 shadow-sm ring-1 ${
          lowNow || i.quantity === 0 ? 'ring-tomato/50' : 'ring-ink/10'
        }`}
      >
        <button className="min-w-0 flex-1 text-left" onClick={() => setDraft({ ...i })}>
          <div className="truncate text-base font-semibold">{i.name}</div>
          <div className={`text-xs ${lowNow || i.quantity === 0 ? 'font-semibold text-tomato' : 'text-ink/50'}`}>
            {i.quantity === 0
              ? `Finito · ${i.unit}`
              : isResp
                ? lowNow
                  ? `Sotto scorta (min ${i.min} ${i.unit})`
                  : `${i.unit} · min ${i.min}`
                : i.unit}
          </div>
          {last && <div className="truncate text-[11px] text-ink/40">{last}</div>}
        </button>
        <button
          aria-label={`Togli uno a ${i.name}`}
          onClick={() => change(i, -1)}
          className="grid size-12 place-items-center rounded-xl bg-paper active:bg-ink/10"
        >
          <Minus className="size-5" />
        </button>
        <button
          aria-label={`Carico o consumo di ${i.name}`}
          onClick={() => setAdjusting(i)}
          className="w-14 rounded-lg py-1 text-center font-display text-2xl font-extrabold tabular-nums underline decoration-dotted decoration-ink/30 underline-offset-4"
        >
          {i.quantity}
        </button>
        <button
          aria-label={`Aggiungi uno a ${i.name}`}
          onClick={() => change(i, 1)}
          className="grid size-12 place-items-center rounded-xl bg-basil text-white active:bg-basil/80"
        >
          <Plus className="size-5" />
        </button>
      </li>
    );
  }

  return (
    <div className="px-4">
      <div className="mb-3 grid grid-cols-3 gap-2 rounded-2xl bg-white p-1.5 shadow-sm ring-1 ring-ink/10">
        {[
          { id: 'tutti' as const, label: 'Tutto' },
          { id: 'cella_congelamento' as const, label: '❄️ Cella Congel.' },
          { id: 'magazzino' as const, label: '📦 Magazzino' },
        ].map((z) => (
          <button
            key={z.id}
            onClick={() => setZoneFilter(z.id)}
            className={`h-10 rounded-xl text-xs font-bold transition-colors ${
              zoneFilter === z.id ? 'bg-basil text-white' : 'text-ink/70'
            }`}
          >
            {z.label}
          </button>
        ))}
      </div>

      <p className="mb-3 text-sm text-ink/60">
        {isResp
          ? low.length === 0
            ? 'Tutto in scorta.'
            : `${low.length} ${low.length === 1 ? 'prodotto sotto scorta' : 'prodotti sotto scorta'}.`
          : 'Tocca il numero per registrare un consumo o un carico.'}
      </p>

      <div className="sticky top-0 z-10 -mx-4 space-y-3 bg-paper/95 px-4 pb-3 pt-1 backdrop-blur">
        <label className="flex h-12 items-center gap-3 rounded-2xl bg-white px-4 shadow-sm ring-1 ring-ink/10">
          <Search className="size-5 text-ink/50" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cerca o aggiungi prodotto"
            className="h-full flex-1 bg-transparent text-base outline-none"
          />
          {search && (
            <button aria-label="Cancella" onClick={() => setSearch('')}>
              <X className="size-5 text-ink/50" />
            </button>
          )}
        </label>

        <div className="flex gap-2 overflow-x-auto pb-1">
          <button
            onClick={() => setCatTab('tutti')}
            className={`shrink-0 rounded-full px-3 py-2 text-sm font-semibold ${
              catTab === 'tutti' ? 'bg-ink text-white' : 'bg-white ring-1 ring-ink/10'
            }`}
          >
            Tutte ({zoneItems.length})
          </button>
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              onClick={() => setCatTab(c.id)}
              className={`shrink-0 rounded-full px-3 py-2 text-sm font-semibold ${
                catTab === c.id ? 'bg-ink text-white' : 'bg-white ring-1 ring-ink/10'
              }`}
            >
              {c.emoji} {c.label} ({catCounts[c.id] ?? 0})
            </button>
          ))}
        </div>

        {isResp && (
          <div className="flex gap-2">
            {[
              { label: `Tutti (${zoneItems.length})`, value: false },
              { label: `Sotto scorta (${low.length})`, value: true },
            ].map((t) => (
              <button
                key={t.label}
                onClick={() => setOnlyLow(t.value)}
                className={`h-10 rounded-full px-4 text-sm font-semibold transition-colors ${
                  onlyLow === t.value ? 'bg-ink text-white' : 'bg-white ring-1 ring-ink/10'
                }`}
              >
                {t.label}
              </button>
            ))}
            {onlyLow && low.length > 0 && (
              <button
                onClick={shareList}
                className="ml-auto flex h-10 items-center gap-1.5 rounded-full bg-basil px-3 text-sm font-semibold text-white"
              >
                <Share2 className="size-3.5" /> Condividi
              </button>
            )}
          </div>
        )}
      </div>

      {loading ? (
        <p className="py-16 text-center text-ink/50">Caricamento…</p>
      ) : shown.length === 0 && catTab === 'tutti' ? (
        <div className="py-16 text-center text-ink/60">
          <Snowflake className="mx-auto mb-3 size-10 text-basil/60" />
          {zoneItems.length === 0
            ? 'Nessun prodotto stoccato qui. Tocca "Aggiungi" per inserire.'
            : onlyLow && !search
              ? 'Nessun prodotto sotto scorta.'
              : 'Nessun risultato.'}
        </div>
      ) : (
        <div className="mt-2 space-y-5">
          {sections.map(({ cat, rows }) => (
            <section key={cat.id}>
              <h3 className="mb-2 flex items-center gap-2 font-display text-lg font-extrabold">
                <span>{cat.emoji}</span> {cat.label}
                <span className="rounded-full bg-ink/10 px-2 py-0.5 text-xs font-bold text-ink/60">
                  {rows.length}
                </span>
                {isResp && rows.some(isLow) && (
                  <span className="rounded-full bg-tomato/15 px-2 py-0.5 text-xs font-bold text-tomato">
                    {rows.filter(isLow).length} sotto scorta
                  </span>
                )}
              </h3>
              {rows.length === 0 ? (
                <p className="rounded-xl bg-white p-4 text-sm text-ink/60 ring-1 ring-ink/10">
                  Nessun prodotto in {cat.label}.
                </p>
              ) : (
                <ul className="space-y-2.5">{rows.map(renderRow)}</ul>
              )}
            </section>
          ))}
        </div>
      )}

      {search.trim() && catalogSuggestions.length > 0 && (
        <div className="mt-3 space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink/40">Dalla merce base</p>
          {catalogSuggestions.map((p) => {
            const cat = CATEGORIES.find((c) => c.id === p.category);
            return (
              <button
                key={p.id}
                onClick={() => addFromCatalog(p)}
                className="flex h-12 w-full items-center gap-2 rounded-2xl bg-white px-3 text-left shadow-sm ring-1 ring-basil/30"
              >
                <span>{cat?.emoji}</span>
                <span className="flex-1 font-semibold">{p.name}</span>
                <span className="text-xs text-ink/50">{p.unit}</span>
                <span className="rounded-full bg-basil/15 px-2 py-0.5 text-xs font-semibold text-basil">
                  + stocca
                </span>
              </button>
            );
          })}
        </div>
      )}

      {search.trim() && !exact && !exactInCatalog && (
        <button
          onClick={() => setDraft(newDraft(search.trim()))}
          className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-basil font-semibold text-basil"
        >
          <Plus className="size-5" /> Nuovo prodotto &quot;{search.trim()}&quot;
        </button>
      )}

      <button
        onClick={() => setDraft(newDraft(''))}
        className="fixed bottom-20 left-1/2 z-20 flex h-14 -translate-x-1/2 items-center gap-2 rounded-full bg-ink px-7 text-base font-semibold text-white shadow-lg active:scale-95"
      >
        <Plus className="size-5" /> Aggiungi
      </button>

      {toast && (
        <div
          role="status"
          className="fixed inset-x-4 bottom-36 z-30 mx-auto max-w-sm rounded-xl bg-ink px-4 py-3 text-center text-white shadow-lg"
        >
          {toast}
        </div>
      )}

      {adjusting && (
        <AdjustSheet
          item={adjusting}
          onApply={(delta) => {
            change(adjusting, delta);
            setAdjusting(null);
          }}
          onClose={() => setAdjusting(null)}
        />
      )}

      {draft && (
        <ItemSheet
          draft={draft}
          setDraft={setDraft}
          canEditMin={isResp}
          canDelete={isResp}
          onSave={save}
          onDelete={remove}
          onClose={() => setDraft(null)}
        />
      )}
    </div>
  );
}

// Registrazione rapida di un consumo (−) o di un carico (+) con quantità libera.
function AdjustSheet({
  item,
  onApply,
  onClose,
}: {
  item: Item;
  onApply: (delta: number) => void;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState('1');
  const val = parseFloat(amount.replace(',', '.'));
  const ok = Number.isFinite(val) && val > 0;
  return (
    <div className="fixed inset-0 z-40 flex items-end bg-ink/40" onClick={onClose}>
      <div
        className="mx-auto w-full max-w-xl space-y-4 rounded-t-3xl bg-white p-5 pb-10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-display text-2xl font-extrabold">{item.name}</h2>
            <p className="text-sm text-ink/60">
              In giacenza: <strong>{item.quantity} {item.unit}</strong>
            </p>
          </div>
          <button aria-label="Chiudi" onClick={onClose}>
            <X className="size-6" />
          </button>
        </div>
        <div className="flex items-center gap-2 rounded-xl bg-paper px-4">
          <input
            inputMode="decimal"
            autoFocus
            aria-label="Quantità"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ''))}
            className="h-14 flex-1 bg-transparent font-display text-3xl font-extrabold outline-none"
          />
          <span className="font-semibold text-ink/60">{item.unit}</span>
        </div>
        <div className="flex gap-2">
          {['0.5', '1', '2', '5', '10'].map((c) => (
            <button
              key={c}
              onClick={() => setAmount(c)}
              className={`h-11 flex-1 rounded-xl text-sm font-bold ${amount === c ? 'bg-ink text-white' : 'bg-paper'}`}
            >
              {c}
            </button>
          ))}
        </div>
        {ok && val > item.quantity && (
          <p className="text-sm text-ink/60">Il consumo supera la giacenza: scenderà a 0.</p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <button
            disabled={!ok}
            onClick={() => onApply(-val)}
            className="flex h-16 items-center justify-center gap-2 rounded-2xl bg-tomato text-lg font-bold text-white disabled:opacity-40"
          >
            <Minus className="size-5" /> Consumo
          </button>
          <button
            disabled={!ok}
            onClick={() => onApply(val)}
            className="flex h-16 items-center justify-center gap-2 rounded-2xl bg-basil text-lg font-bold text-white disabled:opacity-40"
          >
            <Plus className="size-5" /> Carico
          </button>
        </div>
      </div>
    </div>
  );
}

function Stepper({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="font-semibold">{label}</span>
      <div className="flex items-center gap-3">
        <button
          aria-label={`Diminuisci ${label}`}
          onClick={() => onChange(Math.max(0, value - 1))}
          className="grid size-11 place-items-center rounded-xl bg-paper"
        >
          <Minus className="size-5" />
        </button>
        <span className="w-10 text-center font-display text-2xl font-extrabold tabular-nums">{value}</span>
        <button
          aria-label={`Aumenta ${label}`}
          onClick={() => onChange(value + 1)}
          className="grid size-11 place-items-center rounded-xl bg-paper"
        >
          <Plus className="size-5" />
        </button>
      </div>
    </div>
  );
}

function ItemSheet({
  draft,
  setDraft,
  canEditMin,
  canDelete,
  onSave,
  onDelete,
  onClose,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  canEditMin: boolean;
  canDelete: boolean;
  onSave: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [confirmDel, setConfirmDel] = useState(false);
  return (
    <div className="fixed inset-0 z-40 flex items-end bg-ink/40" onClick={onClose}>
      <div
        className="mx-auto max-h-[90dvh] w-full max-w-xl space-y-4 overflow-y-auto rounded-t-3xl bg-white p-5 pb-10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-display text-2xl font-extrabold">
            {draft.id ? 'Modifica prodotto' : 'Nuovo prodotto'}
          </h2>
          <button aria-label="Chiudi" onClick={onClose}>
            <X className="size-6" />
          </button>
        </div>

        <input
          autoFocus={!draft.id && !draft.name}
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="Nome (es. Petto di pollo, Latte)"
          maxLength={60}
          className="h-12 w-full rounded-xl bg-paper px-4 text-base"
        />

        <div>
          <p className="mb-2 text-sm font-semibold">Dove è stoccato</p>
          <div className="grid grid-cols-2 gap-2">
            {[
              { id: 'cella_congelamento' as const, label: '❄️ Cella di congelamento' },
              { id: 'magazzino' as const, label: '📦 Magazzino / Frigo' },
            ].map((z) => (
              <button
                key={z.id}
                onClick={() => setDraft({ ...draft, zone: z.id })}
                className={`h-11 rounded-xl text-sm font-semibold ${
                  draft.zone === z.id ? 'bg-basil text-white' : 'bg-paper'
                }`}
              >
                {z.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-2 text-sm font-semibold">Categoria</p>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                onClick={() => setDraft({ ...draft, category: c.id })}
                className={`rounded-full px-3 py-1.5 text-sm font-semibold ${
                  draft.category === c.id ? 'bg-ink text-white' : 'bg-paper'
                }`}
              >
                {c.emoji} {c.label}
              </button>
            ))}
          </div>
        </div>

        <Stepper
          label="Quantità attuale"
          value={draft.quantity}
          onChange={(n) => setDraft({ ...draft, quantity: n })}
        />

        <div className="flex flex-wrap gap-2">
          {STOCK_UNITS.map((u) => (
            <button
              key={u}
              onClick={() => setDraft({ ...draft, unit: u })}
              className={`h-10 flex-1 rounded-xl text-sm font-semibold ${
                draft.unit === u ? 'bg-ink text-white' : 'bg-paper'
              }`}
            >
              {u}
            </button>
          ))}
        </div>

        {canEditMin ? (
          <div className="rounded-2xl bg-paper p-3">
            <Stepper
              label="Sotto scorta (Chef)"
              value={draft.min}
              onChange={(n) => setDraft({ ...draft, min: n })}
            />
            <p className="mt-1 text-xs text-ink/50">
              Sotto o uguale a questa soglia il prodotto viene segnalato da riordinare.
            </p>
          </div>
        ) : null}

        <button
          onClick={onSave}
          disabled={!draft.name.trim()}
          className="h-12 w-full rounded-2xl bg-basil text-base font-semibold text-white disabled:opacity-40"
        >
          Salva
        </button>

        {draft.id && canDelete && (
          <button
            onClick={() => (confirmDel ? onDelete() : setConfirmDel(true))}
            className="flex h-11 w-full items-center justify-center gap-2 font-semibold text-tomato"
          >
            <Trash2 className="size-5" />{' '}
            {confirmDel ? 'Tocca ancora per eliminare' : 'Elimina prodotto'}
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── Sezione Ordini + Merce Base unificata (grafica originale) ─ */
type BaseCatalogRow = {
  key: string;
  productId?: string;
  name: string;
  category: Category;
  defaultUnit: OrderUnit;
};


const QUICK_TAGS = ['Urgente', 'Scorta bassa', 'Colazione', 'Servizio'];

const STATUS_META: Record<OrderStatus, { label: string; cls: string }> = {
  inviata: { label: 'Da ordinare', cls: 'bg-tomato/15 text-tomato' },
  ordinata: { label: 'Ordinato', cls: 'bg-basil/15 text-basil' },
  archiviata: { label: 'Archiviato', cls: 'bg-ink/10 text-ink/70' },
};

function fmtTs(ts?: TS | null) {
  if (!ts) return '';
  return new Date(ts.seconds * 1000).toLocaleString('it-IT', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function StatusBadge({ status }: { status: OrderStatus }) {
  const m = STATUS_META[status];
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${m.cls}`}>{m.label}</span>
  );
}

function StatusTabBtn({
  active,
  onClick,
  icon,
  label,
  count,
  alert,
  fresh = 0,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  count: number;
  alert?: boolean;
  fresh?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative flex min-h-16 flex-col items-center justify-center gap-1 rounded-2xl px-2 py-2 text-sm font-bold ${
        active ? 'bg-ink text-white' : 'bg-white text-ink ring-1 ring-ink/10'
      }`}
    >
      {icon}
      {label}
      {fresh > 0 && (
        <span className="absolute left-1.5 top-1.5 rounded-full bg-amber-300 px-1.5 text-[11px] font-bold text-ink">
          {fresh} nuov{fresh === 1 ? 'o' : 'i'}
        </span>
      )}
      {count > 0 && (
        <span
          className={`absolute right-1.5 top-1.5 grid min-w-6 place-items-center rounded-full px-1.5 text-xs font-bold tabular-nums text-white ${
            alert ? 'bg-tomato' : 'bg-basil'
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function OrderCard({
  o,
  isChef,
  mine,
  onChange,
  onSave,
  onDelete,
  onRepeat,
}: {
  o: Order;
  isChef: boolean;
  mine: boolean;
  onChange: (o: Order, to: OrderStatus) => void;
  onSave: (o: Order, lines: OrderLine[], note: string, supplier: string) => void;
  onDelete: (o: Order) => void;
  onRepeat: (o: Order) => void;
}) {
  const [confirmDel, setConfirmDel] = useState(false);
  const [editing, setEditing] = useState(false);
  const [lines, setLines] = useState<OrderLine[]>(o.lines);
  const [note, setNote] = useState(o.note);
  const [supplier, setSupplier] = useState(o.supplier);
  const urgent = o.tags.includes('Urgente') && o.status === 'inviata';

  function startEdit() {
    setLines(o.lines.map((l) => ({ ...l })));
    setNote(o.note);
    setSupplier(o.supplier);
    setEditing(true);
  }

  function patchLine(idx: number, patch: Partial<OrderLine>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  return (
    <li
      className={`rounded-2xl bg-white p-4 shadow-sm ring-1 ${
        urgent ? 'ring-2 ring-tomato' : 'ring-ink/10'
      }`}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="text-base font-bold">
            {mine ? 'Tu' : o.operatorName}
            {o.supplier && <span className="font-medium text-ink/60"> · {o.supplier}</span>}
          </div>
          <div className="text-xs text-ink/50">
            {o.createdAt ? `Inviata ${fmtTs(o.createdAt)}` : 'Invio in corso…'}
          </div>
        </div>
        <StatusBadge status={o.status} />
      </div>

      {o.tags.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {o.tags.map((t) => (
            <span
              key={t}
              className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
                t === 'Urgente' ? 'bg-tomato text-white' : 'bg-paper text-ink/70'
              }`}
            >
              {t}
            </span>
          ))}
        </div>
      )}

      {!editing ? (
        <ul className="mb-2 divide-y divide-ink/5">
          {o.lines.map((l, idx) => {
            const cat = CATEGORIES.find((c) => c.id === l.category);
            return (
              <li key={idx} className="flex items-center gap-2 py-2 text-base">
                <span>{cat?.emoji}</span>
                <span className="flex-1 font-medium">{l.name}</span>
                <span className="font-bold tabular-nums">
                  {l.quantity} {UNIT_LABEL[l.unit] ?? l.unit}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="mb-2 space-y-2">
          {lines.map((l, idx) => (
            <div key={idx} className="flex items-center gap-1.5 rounded-xl bg-paper p-2">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{l.name}</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.5"
                min={0.1}
                value={l.quantity}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  patchLine(idx, { quantity: Number.isFinite(v) && v > 0 ? v : 1 });
                }}
                className="h-11 w-16 rounded-lg bg-white text-center font-display font-extrabold tabular-nums ring-1 ring-ink/10"
              />
              <select
                value={l.unit}
                onChange={(e) => patchLine(idx, { unit: e.target.value as OrderUnit })}
                className="h-11 rounded-lg bg-white px-1 text-sm font-semibold ring-1 ring-ink/10"
              >
                {ORDER_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {UNIT_LABEL[u]}
                  </option>
                ))}
              </select>
              <button
                onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}
                className="grid size-11 place-items-center rounded-lg text-tomato"
                aria-label={`Rimuovi ${l.name}`}
              >
                <X className="size-5" />
              </button>
            </div>
          ))}
          <input
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
            placeholder="Fornitore (opzionale)"
            maxLength={40}
            className="h-11 w-full rounded-xl bg-paper px-3 text-sm outline-none"
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Nota"
            maxLength={120}
            className="h-11 w-full rounded-xl bg-paper px-3 text-sm outline-none"
          />
          <button
            onClick={() => (confirmDel ? onDelete(o) : setConfirmDel(true))}
            className="h-11 w-full rounded-xl text-sm font-bold text-tomato ring-1 ring-tomato/30"
          >
            {confirmDel ? 'Tocca ancora per confermare il ritiro' : 'Ritira richiesta'}
          </button>
          <div className="flex gap-2">
            <button
              onClick={() => setEditing(false)}
              className="h-12 flex-1 rounded-xl bg-paper font-semibold"
            >
              Annulla
            </button>
            <button
              disabled={lines.length === 0}
              onClick={() => {
                onSave(o, lines, note.trim(), supplier.trim());
                setEditing(false);
              }}
              className="flex h-12 flex-1 items-center justify-center gap-1 rounded-xl bg-basil font-semibold text-white disabled:opacity-40"
            >
              <Check className="size-4" /> Salva
            </button>
          </div>
        </div>
      )}

      {!editing && o.note && (
        <p className="mb-2 text-sm italic text-ink/60">&ldquo;{o.note}&rdquo;</p>
      )}
      {o.editedByName && !editing && (
        <p className="mb-1 text-xs text-ink/50">Modificata da {o.editedByName}</p>
      )}
      {o.orderedAt && o.status !== 'inviata' && (
        <p className="text-sm font-semibold text-basil">
          Ordinata il {fmtTs(o.orderedAt)}
          {o.orderedByName ? ` · ${o.orderedByName}` : ''}
        </p>
      )}
      {o.archivedAt && o.status === 'archiviata' && (
        <p className="text-sm text-ink/60">
          Archiviata il {fmtTs(o.archivedAt)}
          {o.archivedByName ? ` · ${o.archivedByName}` : ''}
        </p>
      )}
      {o.pending && (
        <p className="mt-1 text-xs font-semibold text-amber-800">
          In attesa di sincronizzazione con il server
        </p>
      )}

      {!editing && (
        <div className="mt-3 space-y-2">
          {o.status === 'inviata' && (isChef || mine) && (
            <div className="flex gap-2">
              <button
                onClick={startEdit}
                className="flex h-14 w-16 shrink-0 items-center justify-center rounded-xl bg-paper"
                aria-label="Modifica richiesta"
              >
                <Pencil className="size-5" />
              </button>
              {isChef ? (
                <button
                  onClick={() => onChange(o, 'ordinata')}
                  className="flex h-14 flex-1 items-center justify-center gap-2 rounded-xl bg-basil text-base font-bold text-white"
                >
                  <CheckCheck className="size-5" /> Segna Ordinato
                </button>
              ) : (
                <p className="flex h-14 flex-1 items-center rounded-xl bg-amber-100 px-3 text-sm font-bold text-amber-900">
                  In attesa che lo chef ordini
                </p>
              )}
            </div>
          )}
          {isChef && o.status === 'ordinata' && (
            <div className="flex gap-2">
              <button
                onClick={() => onChange(o, 'inviata')}
                className="flex h-14 w-16 shrink-0 items-center justify-center rounded-xl bg-paper"
                aria-label="Riporta in Da ordinare"
              >
                <Undo2 className="size-5" />
              </button>
              <button
                onClick={startEdit}
                className="flex h-14 w-16 shrink-0 items-center justify-center rounded-xl bg-paper"
                aria-label="Modifica ordine"
              >
                <Pencil className="size-5" />
              </button>
              <button
                onClick={() => onChange(o, 'archiviata')}
                className="flex h-14 flex-1 items-center justify-center gap-2 rounded-xl bg-ink text-base font-bold text-white"
              >
                <Archive className="size-5" /> Merce arrivata · Archivia
              </button>
            </div>
          )}
          {isChef && o.status === 'archiviata' && (
            <div className="flex gap-2">
              <button
                onClick={startEdit}
                className="flex h-12 w-14 shrink-0 items-center justify-center rounded-xl bg-paper"
                aria-label="Modifica ordine archiviato"
              >
                <Pencil className="size-4" />
              </button>
              <button
                onClick={() => onChange(o, 'ordinata')}
                className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-paper text-sm font-bold"
              >
                <Undo2 className="size-4" /> Ripristina in Ordinato
              </button>
            </div>
          )}
          {isChef && o.status !== 'inviata' && (
            <button
              onClick={() => (confirmDel ? onDelete(o) : setConfirmDel(true))}
              className="h-11 w-full rounded-xl text-sm font-bold text-tomato ring-1 ring-tomato/30"
            >
              {confirmDel ? 'Tocca ancora per eliminare definitivamente' : 'Elimina dallo storico'}
            </button>
          )}
          {o.status !== 'inviata' && (
            <button
              onClick={() => onRepeat(o)}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-xl text-sm font-bold text-basil ring-1 ring-basil/30"
            >
              <Plus className="size-4" /> Ripeti questa richiesta
            </button>
          )}
        </div>
      )}
    </li>
  );
}

type StockEntry = {
  name: string;
  unit: OrderUnit;
  qty: number;
  cooks: string[];
  at?: TS | null;
  by?: string;
};

function StockBadges({ info }: { info: { wait: StockEntry[]; done: StockEntry[] } }) {
  if (info.wait.length === 0 && info.done.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {info.wait.map((e) => (
        <span
          key={`w${e.unit}`}
          className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-900"
        >
          In attesa: {Number(e.qty.toFixed(2))} {UNIT_LABEL[e.unit]} ({e.cooks.join(', ')})
        </span>
      ))}
      {info.done.map((e) => (
        <span
          key={`d${e.unit}`}
          className="rounded-full bg-basil/15 px-2 py-0.5 text-[11px] font-bold text-basil"
        >
          Ordinato: {Number(e.qty.toFixed(2))} {UNIT_LABEL[e.unit]}
          {e.at ? ` · ${fmtTs(e.at)}` : ''}
        </span>
      ))}
    </div>
  );
}

// Vista "per prodotto": cosa è in attesa di essere ordinato e cosa è già stato ordinato.
function ProductOverview({
  wait,
  done,
  query,
}: {
  wait: StockEntry[];
  done: StockEntry[];
  query: string;
}) {
  const q = query.trim().toLowerCase();
  const prep = (a: StockEntry[]) =>
    a
      .filter((e) => !q || e.name.toLowerCase().includes(q))
      .sort((x, y) => x.name.localeCompare(y.name, 'it'));
  const block = (title: string, list: StockEntry[], tone: string, empty: string, ordered: boolean) => (
    <div className="space-y-2">
      <h3 className={`font-display text-lg font-extrabold ${tone}`}>
        {title} ({list.length})
      </h3>
      {list.length === 0 ? (
        <p className="rounded-xl bg-white p-4 text-sm text-ink/60 ring-1 ring-ink/10">{empty}</p>
      ) : (
        <ul className="divide-y divide-ink/5 rounded-2xl bg-white px-3 ring-1 ring-ink/10">
          {list.map((e) => (
            <li key={`${e.name}|${e.unit}`} className="flex items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-base font-semibold">{e.name}</div>
                <div className="text-xs text-ink/50">
                  {ordered
                    ? `${e.at ? fmtTs(e.at) : 'In sincronizzazione'}${e.by ? ` · ${e.by}` : ''}`
                    : `Richiesto da ${e.cooks.join(', ')}`}
                </div>
              </div>
              <div className="font-display text-lg font-extrabold tabular-nums">
                {Number(e.qty.toFixed(2))} {UNIT_LABEL[e.unit]}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <div className="space-y-5">
      {block('In attesa di essere ordinata', prep(wait), 'text-tomato', 'Niente in attesa: tutto quello richiesto è già stato ordinato.', false)}
      {block('Già ordinata (in arrivo)', prep(done), 'text-basil', 'Nessuna merce ordinata in questo momento.', true)}
    </div>
  );
}

function statusPatch(from: OrderStatus, to: OrderStatus, chef: User): Record<string, unknown> {
  const base = { status: to, updatedAt: serverTimestamp() };
  if (to === 'inviata') {
    return {
      ...base,
      orderedAt: deleteField(),
      orderedByName: deleteField(),
      orderedById: deleteField(),
      archivedAt: deleteField(),
      archivedByName: deleteField(),
    };
  }
  if (to === 'ordinata' && from === 'archiviata') {
    return { ...base, archivedAt: deleteField(), archivedByName: deleteField() };
  }
  if (to === 'ordinata') {
    return {
      ...base,
      orderedAt: serverTimestamp(),
      orderedByName: chef.name,
      orderedById: chef.id,
    };
  }
  return { ...base, archivedAt: serverTimestamp(), archivedByName: chef.name };
}

function OrdersSection({
  currentUser,
  users,
  orders,
  online,
  newOrdered,
  onSeenOrdered,
}: {
  currentUser: User;
  users: User[];
  orders: Order[];
  online: boolean;
  newOrdered: number;
  onSeenOrdered: () => void;
}) {
  const isChef = currentUser.role === 'chef';
  const [products, setProducts] = useState<Product[]>([]);
  const [draftLines, setDraftLines] = useState<Record<string, { qty: number; unit: OrderUnit }>>({});
  const [newName, setNewName] = useState('');
  const [newCat, setNewCat] = useState<Category>('altro');
  const [newUnit, setNewUnit] = useState<OrderUnit>('kg');
  const [search, setSearch] = useState('');
  const [filterCat, setFilterCat] = useState<Category | 'tutti'>('tutti');
  const [note, setNote] = useState('');
  const [supplier, setSupplier] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [showComposer, setShowComposer] = useState(false);
  const [statusTab, setStatusTab] = useState<OrderStatus>('inviata');
  const [cookFilter, setCookFilter] = useState('tutti');
  const [orderSearch, setOrderSearch] = useState('');
  const [archiveShown, setArchiveShown] = useState(30);
  const [showSummary, setShowSummary] = useState(false);
  const [snack, setSnack] = useState<{ text: string; undo?: () => void } | null>(null);
  const [view, setView] = useState<'richieste' | 'prodotti'>('richieste');

  useEffect(() => {
    if (statusTab === 'ordinata' || view === 'prodotti') onSeenOrdered();
  }, [statusTab, view, orders.length]);

  const toast = (text: string) => setSnack({ text });
  const failToast = () => toast('Operazione non riuscita. Controlla la connessione e riprova.');

  useEffect(() => {
    return onSnapshot(query(productsCol, orderBy('name')), (snap) => {
      setProducts(
        snap.docs.map(
          (d) =>
            ({
              unit: 'kg',
              defaultMin: 1,
              ...(d.data() as object),
              category: normalizeCategory((d.data() as { category?: string }).category),
              id: d.id,
            }) as Product,
        ),
      );
    });
  }, []);

  useEffect(() => {
    if (!snack) return;
    const t = setTimeout(() => setSnack(null), snack.undo ? 7000 : 2500);
    return () => clearTimeout(t);
  }, [snack]);

  const baseRows = useMemo<BaseCatalogRow[]>(() => {
    const q = search.trim().toLowerCase();
    return products
      .filter((p) => {
        if (filterCat !== 'tutti' && p.category !== filterCat) return false;
        return !q || p.name.toLowerCase().includes(q);
      })
      .map((p) => ({
        key: p.name.trim().toLowerCase(),
        productId: p.id,
        name: p.name,
        category: p.category,
        defaultUnit: normalizeOrderUnit(p.unit),
      }));
  }, [products, filterCat, search]);

  function addPlusToList(row: BaseCatalogRow) {
    setDraftLines((prev) => {
      const cur = prev[row.key];
      if (!cur) return { ...prev, [row.key]: { qty: 1, unit: row.defaultUnit || 'kg' } };
      return { ...prev, [row.key]: { qty: Number((cur.qty + 1).toFixed(2)), unit: cur.unit } };
    });
  }

  function setLineQty(key: string, qty: number) {
    setDraftLines((prev) => {
      const cur = prev[key];
      if (!cur) return prev;
      if (qty <= 0) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: { ...cur, qty: Number(qty.toFixed(2)) } };
    });
  }

  function setLineUnit(key: string, unit: OrderUnit) {
    setDraftLines((prev) => {
      const cur = prev[key];
      if (!cur) return prev;
      return { ...prev, [key]: { ...cur, unit } };
    });
  }

  function addBaseProduct() {
    const n = newName.trim();
    if (!n) return;
    const existing = products.find((p) => p.name.toLowerCase() === n.toLowerCase());
    if (!existing) {
      addDoc(productsCol, {
        name: n,
        category: newCat,
        unit: newUnit,
        defaultMin: 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }).catch(() => toast('Prodotto non salvato nel catalogo'));
    }
    const key = n.toLowerCase();
    setDraftLines((prev) => ({
      ...prev,
      [key]: {
        qty: prev[key]?.qty ? Number((prev[key].qty + 1).toFixed(2)) : 1,
        unit: prev[key]?.unit ?? newUnit,
      },
    }));
    setNewName('');
    toast(`"${n}" aggiunto alla richiesta`);
  }

  function removeBaseProduct(id: string) {
    if (!isChef) return;
    deleteDoc(doc(db, 'products', id)).catch(failToast);
    toast('Prodotto rimosso');
  }

  const selectedList = useMemo(() => {
    return Object.entries(draftLines)
      .filter(([, v]) => v.qty > 0)
      .map(([key, v]) => {
        const p = products.find((x) => x.name.trim().toLowerCase() === key);
        return {
          productKey: key,
          name: p?.name ?? key,
          category: p?.category ?? ('altro' as Category),
          quantity: v.qty,
          unit: v.unit,
        };
      });
  }, [draftLines, products]);

  function toggleTag(t: string) {
    setTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }

  // Non blocca l'interfaccia: offline Firestore tiene la richiesta in coda e la invia al ritorno della rete.
  function sendOrderList() {
    if (selectedList.length === 0) return;
    const lines: OrderLine[] = selectedList.map((l) => ({
      productKey: l.productKey,
      name: l.name,
      quantity: l.quantity,
      unit: l.unit,
      category: l.category,
    }));
    const saved = { draftLines, note, supplier, tags };

    addDoc(ordersCol, {
      operatorId: currentUser.id,
      operatorName: currentUser.name,
      lines,
      note: note.trim(),
      supplier: supplier.trim(),
      tags,
      status: 'inviata',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }).catch(() => {
      // Rifiutata dal server: ripristino la bozza per non perdere il lavoro.
      setDraftLines(saved.draftLines);
      setNote(saved.note);
      setSupplier(saved.supplier);
      setTags(saved.tags);
      setShowComposer(true);
      toast('Richiesta NON inviata. Riprova.');
    });

    if (online) {
      authedPost('/api/notify-order', { operatorName: currentUser.name, lines });
    }

    setDraftLines({});
    setNote('');
    setSupplier('');
    setTags([]);
    setShowComposer(false);
    setStatusTab('inviata');
    toast(
      online ? 'Richiesta inviata allo chef' : 'Salvata offline: parte appena torna la rete',
    );
  }

  function deleteOrder(o: Order) {
    deleteDoc(doc(db, 'orders', o.id)).catch(failToast);
    toast('Richiesta eliminata');
  }

  function repeatOrder(o: Order) {
    setDraftLines((prev) => {
      const next = { ...prev };
      o.lines.forEach((l) => {
        next[l.name.trim().toLowerCase()] = { qty: l.quantity, unit: l.unit };
      });
      return next;
    });
    setShowComposer(true);
    toast('Prodotti copiati nella nuova richiesta');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ─── Azioni dello chef (con annulla) ─── */
  function changeStatus(o: Order, to: OrderStatus) {
    if (!isChef) return;
    const prev = o.status;
    updateDoc(doc(db, 'orders', o.id), statusPatch(prev, to, currentUser)).catch(failToast);
    const text =
      to === 'archiviata'
        ? 'Archiviata'
        : to === 'inviata'
          ? 'Riportata in Da ordinare'
          : prev === 'archiviata'
            ? 'Ripristinata in Ordinato'
            : 'Segnata come Ordinata';
    setSnack({
      text,
      undo: () => {
        updateDoc(doc(db, 'orders', o.id), statusPatch(to, prev, currentUser)).catch(failToast);
        setSnack(null);
      },
    });
  }

  function saveEdit(o: Order, lines: OrderLine[], newNote: string, newSupplier: string) {
    updateDoc(doc(db, 'orders', o.id), {
      lines,
      note: newNote,
      supplier: newSupplier,
      editedByName: currentUser.name,
      updatedAt: serverTimestamp(),
    }).catch(failToast);
    toast('Modifiche salvate');
  }

  /* ─── Liste e contatori ─── */
  const counts = useMemo(
    () => ({
      inviata: orders.filter((o) => o.status === 'inviata').length,
      ordinata: orders.filter((o) => o.status === 'ordinata').length,
      archiviata: orders.filter((o) => o.status === 'archiviata').length,
    }),
    [orders],
  );

  const cookNames = useMemo(() => {
    const s = new Set<string>();
    users.filter((u) => u.role === 'cuoco').forEach((u) => s.add(u.name));
    orders.forEach((o) => s.add(o.operatorName));
    return Array.from(s).sort((a, b) => a.localeCompare(b, 'it'));
  }, [users, orders]);

  const visible = useMemo(() => {
    const q = orderSearch.trim().toLowerCase();
    let list = orders.filter((o) => o.status === statusTab);
    if (cookFilter === 'miei') list = list.filter((o) => o.operatorId === currentUser.id);
    else if (cookFilter !== 'tutti') list = list.filter((o) => o.operatorName === cookFilter);
    if (q) {
      list = list.filter(
        (o) =>
          o.lines.some((l) => l.name.toLowerCase().includes(q)) ||
          o.note.toLowerCase().includes(q) ||
          o.supplier.toLowerCase().includes(q),
      );
    }
    const ts = (t?: TS | null) => (t ? t.seconds : Number.MAX_SAFE_INTEGER);
    const sorted = [...list];
    if (statusTab === 'inviata') {
      sorted.sort(
        (a, b) =>
          Number(b.tags.includes('Urgente')) - Number(a.tags.includes('Urgente')) ||
          ts(a.createdAt) - ts(b.createdAt),
      );
    } else if (statusTab === 'ordinata') {
      sorted.sort((a, b) => ts(b.orderedAt) - ts(a.orderedAt));
    } else {
      sorted.sort((a, b) => ts(b.archivedAt) - ts(a.archivedAt));
    }
    return sorted;
  }, [orders, statusTab, cookFilter, orderSearch, currentUser.id]);

  // Riepilogo accorpato: stessi prodotti e unità sommati tra le richieste visibili.
  const summary = useMemo(() => {
    if (statusTab !== 'inviata') return [];
    const m = new Map<string, { name: string; unit: OrderUnit; qty: number; supplier: string; cooks: Set<string> }>();
    visible.forEach((o) =>
      o.lines.forEach((l) => {
        const k = `${o.supplier.trim().toLowerCase()}|${l.name.trim().toLowerCase()}|${l.unit}`;
        const cur = m.get(k) ?? { name: l.name, unit: l.unit, qty: 0, supplier: o.supplier, cooks: new Set<string>() };
        cur.qty += l.quantity;
        cur.cooks.add(o.operatorName);
        m.set(k, cur);
      }),
    );
    return Array.from(m.values()).sort((a, b) => a.supplier.localeCompare(b.supplier, 'it') || a.name.localeCompare(b.name, 'it'));
  }, [visible, statusTab]);

  function bulkOrder() {
    if (!isChef || visible.length === 0) return;
    const ids = visible.slice(0, 400).map((o) => o.id);
    const batch = writeBatch(db);
    ids.forEach((id) =>
      batch.update(doc(db, 'orders', id), statusPatch('inviata', 'ordinata', currentUser)),
    );
    batch.commit().catch(failToast);
    setSnack({
      text: `${ids.length} richieste segnate come Ordinate`,
      undo: () => {
        const b = writeBatch(db);
        ids.forEach((id) =>
          b.update(doc(db, 'orders', id), statusPatch('ordinata', 'inviata', currentUser)),
        );
        b.commit().catch(failToast);
        setSnack(null);
      },
    });
  }

  const productView = useMemo(() => {
    const mk = (st: OrderStatus) => {
      const m = new Map<string, StockEntry>();
      orders
        .filter((o) => o.status === st)
        .forEach((o) =>
          o.lines.forEach((l) => {
            const k = `${l.name.trim().toLowerCase()}|${l.unit}`;
            const cur = m.get(k) ?? { name: l.name, unit: l.unit, qty: 0, cooks: [], at: null, by: '' };
            cur.qty += l.quantity;
            if (!cur.cooks.includes(o.operatorName)) cur.cooks.push(o.operatorName);
            const t = st === 'ordinata' ? o.orderedAt : o.createdAt;
            if (t && (!cur.at || t.seconds > cur.at.seconds)) {
              cur.at = t;
              if (st === 'ordinata') cur.by = o.orderedByName ?? '';
            }
            m.set(k, cur);
          }),
        );
      return Array.from(m.values());
    };
    return { wait: mk('inviata'), done: mk('ordinata') };
  }, [orders]);

  const statusOfName = (name: string) => {
    const n = name.trim().toLowerCase();
    const same = (e: StockEntry) => e.name.trim().toLowerCase() === n;
    return { wait: productView.wait.filter(same), done: productView.done.filter(same) };
  };

  function summaryText() {
    const by = new Map<string, string[]>();
    summary.forEach((x) => {
      const k = x.supplier || 'Da ordinare';
      by.set(k, [...(by.get(k) ?? []), `- ${x.name}: ${Number(x.qty.toFixed(2))} ${UNIT_LABEL[x.unit]}`]);
    });
    return Array.from(by.entries())
      .map(([k, v]) => `${k}\n${v.join('\n')}`)
      .join('\n\n');
  }

  async function shareSummary() {
    const text = summaryText();
    try {
      if (navigator.share) {
        await navigator.share({ text });
        return;
      }
      await navigator.clipboard.writeText(text);
      toast('Lista copiata negli appunti');
    } catch {
      /* condivisione annullata */
    }
  }

  function exportCsv() {
    const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [
      ['Richiesta', 'Cuoco', 'Prodotto', 'Quantità', 'Unità', 'Fornitore', 'Tag', 'Nota', 'Ordinata il', 'Ordinata da', 'Archiviata il'],
    ];
    visible.forEach((o) =>
      o.lines.forEach((l) =>
        rows.push([
          fmtTs(o.createdAt), o.operatorName, l.name, String(l.quantity), UNIT_LABEL[l.unit] ?? l.unit,
          o.supplier, o.tags.join(' / '), o.note, fmtTs(o.orderedAt), o.orderedByName ?? '', fmtTs(o.archivedAt),
        ]),
      ),
    );
    const csv = '\uFEFF' + rows.map((r) => r.map(q).join(';')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `archivio-ordini-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const shownOrders = statusTab === 'archiviata' ? visible.slice(0, archiveShown) : visible;

  const emptyText: Record<OrderStatus, string> = {
    inviata: 'Nessuna richiesta in attesa.',
    ordinata: 'Nessun ordine in corso: la merce non è stata ancora ordinata.',
    archiviata: 'Archivio vuoto.',
  };

  return (
    <div className="space-y-4 px-4">
      <button
        onClick={() => setShowComposer((v) => !v)}
        className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-basil text-lg font-bold text-white"
      >
        <Plus className="size-5" /> Nuova richiesta
        {selectedList.length > 0 && ` (${selectedList.length} in bozza)`}
      </button>

      {showComposer && (
        <section className="space-y-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-ink/10">
          <div>
            <h2 className="font-display text-xl font-extrabold">Nuova richiesta</h2>
            <p className="text-sm text-ink/60">
              Aggiungi i prodotti con <strong>+</strong>, imposta quantità e unità (kg, lt, crt, pz) e invia la richiesta allo chef.
            </p>
          </div>

          <div className="flex gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Nuovo prodotto base..."
              maxLength={60}
              className="h-11 flex-1 rounded-xl bg-paper px-3 text-sm outline-none"
            />
            <button
              onClick={addBaseProduct}
              disabled={!newName.trim()}
              className="flex h-11 shrink-0 items-center gap-1 rounded-xl bg-basil px-4 text-sm font-semibold text-white disabled:opacity-40"
            >
              <Plus className="size-4" /> Aggiungi
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5">
              {CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setNewCat(c.id)}
                  className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                    newCat === c.id ? 'bg-ink text-white' : 'bg-paper'
                  }`}
                >
                  {c.emoji} {c.label}
                </button>
              ))}
            </div>
            <div className="flex gap-1">
              {ORDER_UNITS.map((u) => (
                <button
                  key={u}
                  onClick={() => setNewUnit(u)}
                  className={`rounded-lg px-2 py-1 text-xs font-semibold ${
                    newUnit === u ? 'bg-basil text-white' : 'bg-paper'
                  }`}
                >{UNIT_LABEL[u]}</button>
              ))}
            </div>
          </div>

          <label className="flex h-11 items-center gap-2 rounded-xl bg-paper px-3">
            <Search className="size-4 text-ink/50" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cerca nella merce base..."
              className="h-full flex-1 bg-transparent text-sm outline-none"
            />
            {search && (
              <button onClick={() => setSearch('')}>
                <X className="size-4 text-ink/50" />
              </button>
            )}
          </label>

          <div className="flex gap-2 overflow-x-auto pb-1">
            <button
              onClick={() => setFilterCat('tutti')}
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${
                filterCat === 'tutti' ? 'bg-ink text-white' : 'bg-paper'
              }`}
            >
              Tutti
            </button>
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                onClick={() => setFilterCat(c.id)}
                className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${
                  filterCat === c.id ? 'bg-ink text-white' : 'bg-paper'
                }`}
              >
                {c.emoji} {c.label}
              </button>
            ))}
          </div>

          <ul className="max-h-64 space-y-2 overflow-y-auto">
            {baseRows.map((row) => {
              const cat = CATEGORIES.find((c) => c.id === row.category);
              const inList = draftLines[row.key];
              return (
                <li
                  key={row.key}
                  className="flex items-center justify-between gap-2 rounded-xl bg-paper px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span>{cat?.emoji}</span>
                      <span className="truncate text-sm font-semibold">{row.name}</span>
                    </div>
                    <div className="text-xs text-ink/50">
                      {cat?.label} · {UNIT_LABEL[row.defaultUnit]}
                    </div>
                  <StockBadges info={statusOfName(row.name)} />
                  </div>
                  {inList && (
                    <span className="rounded-full bg-basil/15 px-2.5 py-0.5 text-xs font-bold text-basil tabular-nums">
                      {inList.qty} {UNIT_LABEL[inList.unit]}
                    </span>
                  )}
                  {isChef && row.productId && (
                    <button
                      onClick={() => removeBaseProduct(row.productId!)}
                      className="grid size-8 place-items-center rounded-lg text-tomato"
                      aria-label={`Elimina ${row.name}`}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  )}
                  <button
                    onClick={() => addPlusToList(row)}
                    className="grid size-9 place-items-center rounded-xl bg-basil text-white"
                    aria-label={`Aggiungi ${row.name} alla lista`}
                  >
                    <Plus className="size-4" />
                  </button>
                </li>
              );
            })}
          </ul>

          {selectedList.length > 0 && (
            <div className="space-y-2.5 border-t border-ink/10 pt-3">
              <h3 className="font-display text-base font-extrabold">
                Lista da inviare ({selectedList.length})
              </h3>
              <ul className="space-y-2">
                {selectedList.map((line) => (
                  <li key={line.productKey} className="space-y-2 rounded-xl bg-paper p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-bold">{line.name}</span>
                      <StockBadges info={statusOfName(line.name)} />
                    </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => setLineQty(line.productKey, line.quantity - 1)}
                          className="grid size-8 place-items-center rounded-lg bg-white ring-1 ring-ink/10"
                        >
                          <Minus className="size-3.5" />
                        </button>
                        <input
                          type="number"
                          inputMode="decimal"
                          step="0.5"
                          min={0.1}
                          value={line.quantity}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value);
                            setLineQty(line.productKey, Number.isFinite(v) ? v : 0);
                          }}
                          className="h-8 w-16 rounded-lg bg-white text-center font-display text-sm font-extrabold tabular-nums ring-1 ring-ink/10"
                        />
                        <button
                          onClick={() => setLineQty(line.productKey, line.quantity + 1)}
                          className="grid size-8 place-items-center rounded-lg bg-white ring-1 ring-ink/10"
                        >
                          <Plus className="size-3.5" />
                        </button>
                        <button
                          onClick={() => setLineQty(line.productKey, 0)}
                          className="grid size-8 place-items-center rounded-lg text-tomato"
                          aria-label={`Rimuovi ${line.name}`}
                        >
                          <X className="size-4" />
                        </button>
                      </div>
                    </div>
                    <div className="flex gap-1.5">
                      {ORDER_UNITS.map((u) => (
                        <button
                          key={u}
                          onClick={() => setLineUnit(line.productKey, u)}
                          className={`h-8 flex-1 rounded-lg text-xs font-semibold ${
                            line.unit === u ? 'bg-ink text-white' : 'bg-white ring-1 ring-ink/10'
                          }`}
                        >{UNIT_LABEL[u]}</button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>

              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  {QUICK_TAGS.map((t) => (
                    <button
                      key={t}
                      onClick={() => toggleTag(t)}
                      className={`h-10 rounded-full px-4 text-sm font-bold ${
                        tags.includes(t)
                          ? t === 'Urgente'
                            ? 'bg-tomato text-white'
                            : 'bg-ink text-white'
                          : 'bg-paper'
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <input
                  value={supplier}
                  onChange={(e) => setSupplier(e.target.value)}
                  placeholder="Fornitore (opzionale)"
                  maxLength={40}
                  className="h-11 w-full rounded-xl bg-paper px-3 text-sm outline-none"
                />
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Nota per lo chef (opzionale)"
                  maxLength={120}
                  className="h-11 w-full rounded-xl bg-paper px-3 text-sm outline-none"
                />
              </div>

              <button
                onClick={sendOrderList}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-basil text-base font-semibold text-white disabled:opacity-40"
              >
                <Send className="size-4" /> Invia richiesta allo chef ({selectedList.length})
              </button>
            </div>
          )}
        </section>
      )}

      <section className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ['richieste', 'Per richiesta'],
              ['prodotti', 'Stato merce per prodotto'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`h-11 rounded-xl text-sm font-bold ${
                view === v ? 'bg-basil text-white' : 'bg-white ring-1 ring-ink/10'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className={`grid grid-cols-3 gap-2 ${view === 'prodotti' ? 'hidden' : ''}`}>
          <StatusTabBtn
            active={statusTab === 'inviata'}
            onClick={() => setStatusTab('inviata')}
            icon={<ClipboardList className="size-6" />}
            label="Da ordinare"
            count={counts.inviata}
            alert
          />
          <StatusTabBtn
            active={statusTab === 'ordinata'}
            onClick={() => setStatusTab('ordinata')}
            icon={<CheckCheck className="size-6" />}
            label="Ordinato"
            count={counts.ordinata}
            fresh={newOrdered}
          />
          <StatusTabBtn
            active={statusTab === 'archiviata'}
            onClick={() => setStatusTab('archiviata')}
            icon={<Archive className="size-6" />}
            label="Archiviato"
            count={counts.archiviata}
          />
        </div>

        <label className="flex h-12 items-center gap-2 rounded-xl bg-white px-3 ring-1 ring-ink/10">
          <Search className="size-4 text-ink/50" />
          <input
            value={orderSearch}
            onChange={(e) => setOrderSearch(e.target.value)}
            placeholder="Cerca prodotto, fornitore, nota…"
            className="h-full flex-1 bg-transparent text-base outline-none"
          />
          {orderSearch && (
            <button onClick={() => setOrderSearch('')} aria-label="Cancella ricerca">
              <X className="size-4 text-ink/50" />
            </button>
          )}
        </label>

        {view === 'prodotti' && (
          <ProductOverview wait={productView.wait} done={productView.done} query={orderSearch} />
        )}

        {view === 'richieste' && (<>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {['tutti', ...(isChef ? [] : ['miei']), ...cookNames].map((c) => (
            <button
              key={c}
              onClick={() => setCookFilter(c)}
              className={`h-10 shrink-0 rounded-full px-4 text-sm font-semibold ${
                cookFilter === c ? 'bg-ink text-white' : 'bg-white ring-1 ring-ink/10'
              }`}
            >
              {c === 'tutti' ? 'Tutti i cuochi' : c === 'miei' ? 'Le mie' : c}
            </button>
          ))}
        </div>

        {isChef && statusTab === 'inviata' && visible.length > 0 && (
          <div className="space-y-2 rounded-2xl bg-white p-3 ring-1 ring-ink/10">
            <button
              onClick={() => setShowSummary((v) => !v)}
              className="flex h-11 w-full items-center justify-between text-left font-display text-base font-extrabold"
            >
              Riepilogo accorpato ({summary.length} prodotti)
              <span className="text-sm text-ink/50">{showSummary ? 'Chiudi' : 'Apri'}</span>
            </button>
            {showSummary && (
              <ul className="divide-y divide-ink/5">
                {summary.map((s) => (
                  <li key={`${s.supplier}|${s.name}|${s.unit}`} className="flex items-center gap-2 py-2 text-sm">
                    <span className="flex-1 font-medium">
                      {s.name}
                      <span className="block text-xs text-ink/50">
                        {s.supplier ? `${s.supplier} · ` : ''}{Array.from(s.cooks).join(', ')}
                      </span>
                    </span>
                    <span className="font-bold tabular-nums">
                      {Number(s.qty.toFixed(2))} {UNIT_LABEL[s.unit]}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <button
              onClick={shareSummary}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-paper text-sm font-bold"
            >
              <Share2 className="size-4" /> Condividi / copia lista per fornitore
            </button>
            <button
              onClick={bulkOrder}
              className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-basil text-base font-bold text-white"
            >
              <CheckCheck className="size-5" /> Segna tutte Ordinate ({visible.length})
            </button>
          </div>
        )}

        {shownOrders.length === 0 ? (
          <div className="py-12 text-center text-ink/60">
            <ShoppingBasket className="mx-auto mb-3 size-10 text-ink/40" />
            {orderSearch || cookFilter !== 'tutti'
              ? 'Nessun risultato con questi filtri.'
              : emptyText[statusTab]}
          </div>
        ) : (
          <ul className="space-y-3">
            {shownOrders.map((o) => (
              <OrderCard
                key={o.id}
                o={o}
                isChef={isChef}
                mine={o.operatorId === currentUser.id}
                onChange={changeStatus}
                onSave={saveEdit}
                onDelete={deleteOrder}
                onRepeat={repeatOrder}
              />
            ))}
          </ul>
        )}

        {isChef && statusTab === 'archiviata' && visible.length > 0 && (
          <button
            onClick={exportCsv}
            className="h-12 w-full rounded-xl bg-white font-semibold ring-1 ring-ink/10"
          >
            Esporta archivio (CSV)
          </button>
        )}
        {statusTab === 'archiviata' && visible.length > archiveShown && (
          <button
            onClick={() => setArchiveShown((n) => n + 30)}
            className="h-12 w-full rounded-xl bg-white font-semibold ring-1 ring-ink/10"
          >
            Mostra altri ({visible.length - archiveShown})
          </button>
        )}
        </>)}
      </section>

      {snack && (
        <div
          role="status"
          className="fixed inset-x-4 bottom-28 z-40 mx-auto flex max-w-sm items-center justify-between gap-3 rounded-xl bg-ink px-4 py-3 text-white shadow-lg"
        >
          <span className="text-sm font-medium">{snack.text}</span>
          {snack.undo && (
            <button
              onClick={snack.undo}
              className="shrink-0 rounded-lg bg-white/15 px-3 py-2 text-sm font-bold"
            >
              Annulla
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Sezione Account con PIN (solo Chef) ──────── */
function AccountsSection({ users, embedded = false }: { users: User[]; embedded?: boolean }) {
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [role, setRole] = useState<Role>('cuoco');
  const [editingPinId, setEditingPinId] = useState<string | null>(null);
  const [newPinValue, setNewPinValue] = useState('');
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  async function addUser() {
    const n = name.trim();
    if (!n || pin.length < 4) return;
    if (users.some((u) => u.name.toLowerCase() === n.toLowerCase())) {
      setToast('Nome già presente');
      return;
    }
    const err = await adminCall({ action: 'create', name: n, pin, role });
    if (err) {
      setToast(err);
      return;
    }
    setName('');
    setPin('');
    setRole('cuoco');
    setToast(`"${n}" creato con PIN`);
  }

  async function saveNewPin(userId: string) {
    if (newPinValue.length < 4) return;
    const err = await adminCall({ action: 'setPin', userId, pin: newPinValue });
    if (err) {
      setToast(err);
      return;
    }
    setEditingPinId(null);
    setNewPinValue('');
    setToast('PIN aggiornato');
  }

  async function removeUser(u: User) {
    if (!window.confirm(`Eliminare l'account di ${u.name}? Le sue richieste restano nello storico.`)) return;
    const err = await adminCall({ action: 'delete', userId: u.id });
    setToast(err ?? `"${u.name}" rimosso`);
  }

  async function toggleRole(u: User) {
    const next: Role = u.role === 'cuoco' ? 'chef' : 'cuoco';
    const err = await adminCall({ action: 'setRole', userId: u.id, role: next });
    if (err) setToast(err);
  }

  return (
    <div className={embedded ? '' : 'px-4'}>
      <h2 className="mb-1 font-display text-xl font-extrabold">Gestione Cuochi & PIN</h2>
      <p className="mb-4 text-sm text-ink/60">
        Crea i cuochi (e lo Chef) assegnando nome e PIN a 4 cifre per accedere e inviare le richieste.
      </p>

      <div className="mb-6 space-y-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-ink/10">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nome (es. Cuoco 1)"
          maxLength={40}
          className="h-12 w-full rounded-xl bg-paper px-4"
        />
        <div className="flex items-center gap-2 rounded-xl bg-paper px-4">
          <KeyRound className="size-4 text-ink/50" />
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            placeholder="PIN 4 cifre (es. 1234)"
            className="h-12 flex-1 bg-transparent font-display text-lg font-bold tracking-widest outline-none"
          />
        </div>
        <div className="flex gap-2">
          {(['cuoco', 'chef'] as Role[]).map((r) => (
            <button
              key={r}
              onClick={() => setRole(r)}
              className={`h-10 flex-1 rounded-xl text-sm font-semibold capitalize ${
                role === r ? 'bg-ink text-white' : 'bg-paper'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
        <button
          onClick={addUser}
          disabled={!name.trim() || pin.length < 4}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-basil font-semibold text-white disabled:opacity-40"
        >
          <UserPlus className="size-5" /> Crea account
        </button>
      </div>

      <ul className="space-y-2">
        {users.map((u) => (
          <li
            key={u.id}
            className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-ink/10"
          >
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-full bg-basil/15 text-lg font-bold text-basil">
                {u.name.charAt(0).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{u.name}</div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <button onClick={() => toggleRole(u)} className="font-medium text-basil underline">
                    {u.role === 'chef' ? 'Chef' : 'Cuoco'}
                  </button>
                  <span className="text-ink/40">·</span>
                  <span className="font-semibold text-ink/70">PIN impostato</span>
                  <button
                    onClick={() => {
                      setEditingPinId(editingPinId === u.id ? null : u.id);
                      setNewPinValue('');
                    }}
                    className="text-ink/50 underline"
                  >
                    cambia PIN
                  </button>
                </div>
              </div>
              <button
                onClick={() => removeUser(u)}
                className="grid size-10 place-items-center rounded-xl text-tomato"
                aria-label={`Elimina ${u.name}`}
              >
                <Trash2 className="size-5" />
              </button>
            </div>

            {editingPinId === u.id && (
              <div className="mt-3 flex gap-2 border-t border-ink/5 pt-3">
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={4}
                  value={newPinValue}
                  onChange={(e) => setNewPinValue(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder="Nuovo PIN"
                  className="h-10 flex-1 rounded-xl bg-paper px-3 font-mono font-bold tracking-widest"
                />
                <button
                  onClick={() => saveNewPin(u.id)}
                  disabled={newPinValue.length < 4}
                  className="h-10 rounded-xl bg-basil px-4 text-sm font-semibold text-white disabled:opacity-40"
                >
                  Salva PIN
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {toast && (
        <div
          role="status"
          className="fixed inset-x-4 bottom-28 mx-auto max-w-sm rounded-xl bg-ink px-4 py-3 text-center text-white shadow-lg"
        >
          {toast}
        </div>
      )}
    </div>
  );
}


/* ─── Impostazioni (solo Chef) ───────────────────────────── */
function SettingsCard({
  icon,
  title,
  hint,
  open,
  onToggle,
  children,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl bg-white shadow-sm ring-1 ring-ink/10">
      <button
        onClick={onToggle}
        className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-basil/15 text-basil">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block font-display text-lg font-extrabold">{title}</span>
          <span className="block text-xs text-ink/50">{hint}</span>
        </span>
        <span className="text-sm font-semibold text-ink/50">{open ? 'Chiudi' : 'Apri'}</span>
      </button>
      {open && <div className="border-t border-ink/5 p-4">{children}</div>}
    </section>
  );
}

function SettingsSection({ currentUser, users }: { currentUser: User; users: User[] }) {
  const [open, setOpen] = useState<'notifiche' | 'soglie' | 'account' | null>('notifiche');
  const toggle = (k: 'notifiche' | 'soglie' | 'account') => setOpen(open === k ? null : k);
  return (
    <div className="space-y-3 px-4">
      <h2 className="font-display text-2xl font-extrabold">Impostazioni</h2>
      <SettingsCard
        icon={<Bell className="size-5" />}
        title="Notifiche ad app chiusa"
        hint="Arrivano solo a te (Chef) su questo dispositivo"
        open={open === 'notifiche'}
        onToggle={() => toggle('notifiche')}
      >
        <NotifySettings me={currentUser} />
      </SettingsCard>
      <SettingsCard
        icon={<Lock className="size-5" />}
        title="Soglie minime di giacenza"
        hint="Solo tu le vedi e le modifichi"
        open={open === 'soglie'}
        onToggle={() => toggle('soglie')}
      >
        <ThresholdSettings />
      </SettingsCard>
      <SettingsCard
        icon={<Users className="size-5" />}
        title="Cuochi e PIN"
        hint="Crea, modifica ed elimina gli account"
        open={open === 'account'}
        onToggle={() => toggle('account')}
      >
        <AccountsSection users={users} embedded />
      </SettingsCard>
    </div>
  );
}

function CheckRow({ ok, label, hint }: { ok: boolean | null; label: string; hint?: string }) {
  return (
    <li className="flex items-start gap-2 py-2">
      <span
        className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-white ${
          ok === null ? 'bg-ink/30' : ok ? 'bg-basil' : 'bg-tomato'
        }`}
      >
        {ok ? <Check className="size-3.5" /> : ok === null ? null : <X className="size-3.5" />}
      </span>
      <span className="text-sm">
        <span className="font-semibold">{label}</span>
        {hint && <span className="block text-xs text-ink/50">{hint}</span>}
      </span>
    </li>
  );
}

function NotifySettings({ me }: { me: User }) {
  const supported =
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  const hasVapid = Boolean(import.meta.env.VITE_FIREBASE_VAPID_KEY);

  const [perm, setPerm] = useState<string>('Notification' in window ? Notification.permission : 'unsupported');
  const [reg, setReg] = useState<{ tail: string; at?: TS | null } | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [sound, setSound] = useState(localStorage.getItem('kitchenos-sound') !== 'off');

  async function refresh() {
    try {
      const snap = await getDoc(doc(db, 'pushTokens', me.id));
      const d = snap.exists() ? (snap.data() as { token?: string; updatedAt?: TS }) : null;
      setReg(d?.token ? { tail: String(d.token).slice(-6), at: d.updatedAt ?? null } : null);
    } catch {
      setReg(null);
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  async function enable() {
    setBusy(true);
    setMsg(null);
    try {
      if (!supported) {
        throw new Error(
          isIOS && !standalone
            ? 'Su iPhone aggiungi prima l’app alla Home (Condividi → Aggiungi a Home) e riaprila da lì.'
            : 'Questo browser non supporta le notifiche.',
        );
      }
      const p = await Notification.requestPermission();
      setPerm(p);
      if (p !== 'granted') {
        throw new Error('Permesso negato: attiva le notifiche di KitchenOS dalle impostazioni del telefono o del browser.');
      }
      if (!hasVapid) throw new Error('Manca la chiave VAPID: aggiungi VITE_FIREBASE_VAPID_KEY su Vercel e rifai il deploy.');
      const { registerPushToken } = await import('./firebase');
      const token = await registerPushToken();
      if (!token) throw new Error('Registrazione non riuscita. Riprova tra qualche secondo.');
      await setDoc(doc(db, 'pushTokens', me.id), {
        token,
        userId: me.id,
        userName: me.name,
        role: me.role,
        updatedAt: serverTimestamp(),
      });
      await refresh();
      setMsg({ ok: true, text: 'Fatto: questo dispositivo riceverà le notifiche ad app chiusa.' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Operazione non riuscita.' });
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      await deleteDoc(doc(db, 'pushTokens', me.id));
      await refresh();
      setMsg({ ok: true, text: 'Notifiche disattivate su questo account.' });
    } catch {
      setMsg({ ok: false, text: 'Non riuscito. Controlla la connessione.' });
    } finally {
      setBusy(false);
    }
  }

  // delay > 0: il server aspetta qualche secondo, così puoi chiudere l'app prima che parta la notifica.
  async function sendTest(delaySec: number) {
    setBusy(true);
    setMsg(null);
    try {
      const tok = await auth.currentUser?.getIdToken();
      const r = await fetch('/api/test-push', {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ delay: delaySec * 1000 }),
      });
      if (!r.ok) throw new Error((await r.text().catch(() => '')) || 'Invio non riuscito.');
      setMsg({
        ok: true,
        text: delaySec
          ? `Test avviato: chiudi subito l’app. Entro ${delaySec + 3} secondi dovrebbe comparire la notifica.`
          : 'Notifica inviata: dovrebbe comparire entro pochi secondi.',
      });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Invio non riuscito.' });
    } finally {
      setBusy(false);
    }
  }

  function toggleSound() {
    const next = !sound;
    setSound(next);
    localStorage.setItem('kitchenos-sound', next ? 'on' : 'off');
  }

  const btn = 'flex h-12 w-full items-center justify-center gap-2 rounded-xl text-sm font-bold disabled:opacity-40';
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink/70">
        Quando un cuoco invia una richiesta, solo il telefono dello Chef riceve la notifica, anche con l’app chiusa.
        Il token vale per <strong>un solo dispositivo</strong>: l’ultimo su cui attivi le notifiche.
      </p>

      <ul className="divide-y divide-ink/5 rounded-xl bg-paper px-3">
        <CheckRow ok={supported} label="Il dispositivo supporta le notifiche" hint={supported ? undefined : 'Su iPhone serve iOS 16.4+ e l’app aggiunta alla Home.'} />
        {isIOS && <CheckRow ok={standalone} label="App aperta dalla schermata Home" hint="Su iPhone le notifiche funzionano solo così." />}
        <CheckRow ok={perm === 'granted' ? true : perm === 'denied' ? false : null} label={`Permesso notifiche: ${perm === 'granted' ? 'consentito' : perm === 'denied' ? 'negato' : 'da richiedere'}`} />
        <CheckRow ok={hasVapid} label="Chiave VAPID configurata" hint={hasVapid ? undefined : 'Variabile VITE_FIREBASE_VAPID_KEY su Vercel.'} />
        <CheckRow
          ok={reg === undefined ? null : Boolean(reg)}
          label={reg ? `Dispositivo registrato (…${reg.tail})${reg.at ? ` · ${fmtTs(reg.at)}` : ''}` : 'Dispositivo registrato'}
          hint={reg === null ? 'Tocca "Attiva notifiche su questo dispositivo".' : undefined}
        />
      </ul>

      {msg && (
        <p role="status" className={`rounded-xl px-3 py-2.5 text-sm font-semibold ${msg.ok ? 'bg-basil/15 text-basil' : 'bg-tomato/15 text-tomato'}`}>
          {msg.text}
        </p>
      )}

      <div className="space-y-2">
        <button onClick={enable} disabled={busy} className={`${btn} bg-basil text-white`}>
          <Bell className="size-4" /> Attiva notifiche su questo dispositivo
        </button>
        <button onClick={() => sendTest(0)} disabled={busy || !reg} className={`${btn} bg-paper`}>
          Invia notifica di prova
        </button>
        <button onClick={() => sendTest(8)} disabled={busy || !reg} className={`${btn} bg-paper`}>
          Prova con app chiusa (parte dopo 8 secondi)
        </button>
        {reg && (
          <button onClick={disable} disabled={busy} className={`${btn} text-tomato ring-1 ring-tomato/30`}>
            Disattiva su questo account
          </button>
        )}
      </div>

      <div className="flex items-center justify-between rounded-xl bg-paper px-3 py-2.5">
        <div>
          <div className="text-sm font-semibold">Suono con l’app aperta</div>
          <div className="text-xs text-ink/50">Avviso sonoro per nuove richieste e ordini.</div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => playNotifySound(true)} className="h-10 rounded-lg bg-white px-3 text-xs font-bold ring-1 ring-ink/10">
            Prova
          </button>
          <button
            onClick={toggleSound}
            role="switch"
            aria-checked={sound}
            className={`h-10 w-16 rounded-full text-xs font-bold ${sound ? 'bg-basil text-white' : 'bg-ink/15 text-ink/60'}`}
          >
            {sound ? 'Attivo' : 'Spento'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ThresholdSettings() {
  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    return onSnapshot(
      query(itemsCol, orderBy('name')),
      (snap) => setItems(snap.docs.map((d) => toItem(d.id, d.data() as Record<string, any>))),
      () => setErr('Impossibile caricare i prodotti.'),
    );
  }, []);

  function setMin(i: Item, value: number) {
    const next = Math.max(0, Number(value.toFixed(2)));
    if (next === i.min) return;
    setErr('');
    updateDoc(doc(db, 'items', i.id), { min: next, updatedAt: serverTimestamp() }).catch(() =>
      setErr('Soglia non salvata. Controlla la connessione.'),
    );
    if (i.productId) updateDoc(doc(db, 'products', i.productId), { defaultMin: next }).catch(() => {});
  }

  const needle = q.trim().toLowerCase();
  const lowCount = items.filter(isLow).length;

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink/70">
        Sotto o uguale alla soglia il prodotto risulta da riordinare e parte l’avviso email. I cuochi non vedono questo valore.
      </p>
      <p className="text-sm font-semibold">
        {lowCount === 0 ? 'Nessun prodotto sotto scorta.' : `${lowCount} sotto scorta adesso.`}
      </p>
      <label className="flex h-11 items-center gap-2 rounded-xl bg-paper px-3">
        <Search className="size-4 text-ink/50" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Cerca prodotto"
          className="h-full flex-1 bg-transparent text-sm outline-none"
        />
      </label>
      {err && <p className="rounded-xl bg-tomato/15 px-3 py-2 text-sm font-semibold text-tomato">{err}</p>}

      {CATEGORIES.map((c) => {
        const rows = items.filter((i) => i.category === c.id && (!needle || i.name.toLowerCase().includes(needle)));
        if (rows.length === 0) return null;
        return (
          <div key={c.id}>
            <h3 className="mb-1 font-display text-base font-extrabold">
              {c.emoji} {c.label} <span className="text-xs font-bold text-ink/40">({rows.length})</span>
            </h3>
            <ul className="divide-y divide-ink/5 rounded-xl bg-paper px-3">
              {rows.map((i) => {
                const step = i.unit === 'kg' || i.unit === 'l' ? 0.5 : 1;
                return (
                  <li key={i.id} className="flex items-center gap-2 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">{i.name}</div>
                      <div className={`text-xs ${isLow(i) ? 'font-semibold text-tomato' : 'text-ink/50'}`}>
                        In giacenza: {i.quantity} {i.unit}
                      </div>
                    </div>
                    <button
                      aria-label={`Diminuisci soglia di ${i.name}`}
                      onClick={() => setMin(i, i.min - step)}
                      className="grid size-11 place-items-center rounded-xl bg-white ring-1 ring-ink/10"
                    >
                      <Minus className="size-4" />
                    </button>
                    <span className="w-12 text-center font-display text-xl font-extrabold tabular-nums">{i.min}</span>
                    <button
                      aria-label={`Aumenta soglia di ${i.name}`}
                      onClick={() => setMin(i, i.min + step)}
                      className="grid size-11 place-items-center rounded-xl bg-white ring-1 ring-ink/10"
                    >
                      <Plus className="size-4" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
