import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  increment,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {
  Check,
  ChefHat,
  KeyRound,
  Lock,
  LogOut,
  Minus,
  Package,
  Plus,
  Search,
  Send,
  Share2,
  ShoppingBasket,
  Snowflake,
  Trash2,
  UserPlus,
  Users,
  Volume2,
  X,
} from 'lucide-react';
import { db } from './firebase';

/* ─── Tipi ─────────────────────────────────────────────── */
type Role = 'operatore' | 'responsabile';
type Category = 'carne' | 'pesce' | 'verdure' | 'latticini' | 'pasticceria' | 'altro';
type StorageZone = 'cella_congelamento' | 'magazzino';
type OrderUnit = 'kg' | 'l' | 'cartoni' | 'pezzi';

type User = { id: string; name: string; role: Role; pin: string };
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
  status: 'pending' | 'received' | 'done';
  createdAt?: { seconds: number };
};

const STOCK_UNITS = ['kg', 'l', 'cartoni', 'pezzi', 'conf.'];
const ORDER_UNITS: OrderUnit[] = ['kg', 'l', 'cartoni', 'pezzi'];

const CATEGORIES: { id: Category; label: string; emoji: string }[] = [
  { id: 'carne', label: 'Carne', emoji: '🥩' },
  { id: 'pesce', label: 'Pesce', emoji: '🐟' },
  { id: 'verdure', label: 'Verdure', emoji: '🥬' },
  { id: 'latticini', label: 'Latticini', emoji: '🧀' },
  { id: 'pasticceria', label: 'Pasticceria', emoji: '🥐' },
  { id: 'altro', label: 'Altro', emoji: '📦' },
];

const itemsCol = collection(db, 'items');
const usersCol = collection(db, 'users');
const ordersCol = collection(db, 'orders');
const productsCol = collection(db, 'products');

const isLow = (i: Item) => i.quantity <= i.min;
const STORAGE_KEY = 'kitchenos-user-id';

function normalizeOrderUnit(u?: string): OrderUnit {
  if (!u) return 'kg';
  const low = u.toLowerCase().trim();
  if (low === 'l' || low === 'lt' || low === 'litri') return 'l';
  if (low === 'cartoni' || low === 'cartone' || low === 'ct' || low === 'crt') return 'cartoni';
  if (low === 'pezzi' || low === 'pz' || low === 'pezzo') return 'pezzi';
  return 'kg';
}

/* ─── Suono notifica (doppio squillo ad alto volume) ──── */
function playNotifySound() {
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
    icon: 'https://cdn-icons-png.flaticon.com/512/3652/3652191.png',
    badge: 'https://cdn-icons-png.flaticon.com/512/3652/3652191.png',
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
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [tab, setTab] = useState<'giacenza' | 'ordini' | 'account'>('giacenza');
  const [pendingOrdersCount, setPendingOrdersCount] = useState(0);
  const knownOrderIds = useRef<Set<string>>(new Set());
  const initialOrdersLoaded = useRef(false);

  useEffect(() => {
    const unsub = onSnapshot(query(usersCol, orderBy('name')), (snap) => {
      const list = snap.docs.map((d) => ({
        pin: '0000',
        ...(d.data() as Omit<User, 'id'>),
        id: d.id,
      }));
      setUsers(list);
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const found = list.find((u) => u.id === saved);
        if (found) setCurrentUser(found);
        else localStorage.removeItem(STORAGE_KEY);
      }
      setBooting(false);
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!currentUser || currentUser.role !== 'responsabile') {
      setPendingOrdersCount(0);
      initialOrdersLoaded.current = false;
      knownOrderIds.current.clear();
      return;
    }

    const unsub = onSnapshot(query(ordersCol, orderBy('createdAt', 'desc')), (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Order, 'id'>) }));
      const pending = list.filter((o) => o.status === 'pending');
      setPendingOrdersCount(pending.length);

      if (!initialOrdersLoaded.current) {
        list.forEach((o) => knownOrderIds.current.add(o.id));
        initialOrdersLoaded.current = true;
        return;
      }

      list.forEach((o) => {
        if (!knownOrderIds.current.has(o.id)) {
          knownOrderIds.current.add(o.id);
          if (o.status === 'pending') {
            playNotifySound();
            const summary = o.lines
              .map((l) => `${l.name} (${l.quantity} ${l.unit})`)
              .join(', ');
            showPushNotification(`Nuovo ordine da ${o.operatorName}`, summary);
          }
        }
      });
    });

    return unsub;
  }, [currentUser]);

  async function login(u: User) {
    localStorage.setItem(STORAGE_KEY, u.id);
    setCurrentUser(u);
    if ('Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
    if (u.role === 'responsabile') {
      try {
        const { registerPushToken } = await import('./firebase');
        if (typeof registerPushToken === 'function') {
          const token = await registerPushToken();
          if (token) {
            await setDoc(doc(db, 'pushTokens', u.id), {
              token,
              userId: u.id,
              userName: u.name,
              updatedAt: serverTimestamp(),
            });
          }
        }
      } catch {
        /* FCM opzionale se non ancora configurato con VAPID key */
      }
    }
  }

  function logout() {
    localStorage.removeItem(STORAGE_KEY);
    setCurrentUser(null);
    setTab('giacenza');
  }

  if (booting) {
    return <div className="grid min-h-dvh place-items-center text-ink/50">Caricamento…</div>;
  }

  if (!currentUser) {
    return <LoginScreen users={users} onLogin={login} />;
  }

  const isResp = currentUser.role === 'responsabile';

  return (
    <div className="mx-auto min-h-dvh max-w-xl pb-24 pt-4">
      <header className="mb-4 flex items-center justify-between px-4">
        <div>
          <h1 className="font-display text-3xl font-extrabold tracking-tight">KitchenOS</h1>
          <p className="text-sm text-ink/60">
            {currentUser.name} · {isResp ? 'Responsabile' : 'Operatore'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isResp && (
            <button
              onClick={() => {
                playNotifySound();
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

      {tab === 'giacenza' && <InventorySection currentUser={currentUser} />}
      {tab === 'ordini' && <OrdersSection currentUser={currentUser} />}
      {tab === 'account' && isResp && <AccountsSection users={users} />}

      {/* Bottom nav unificata: Giacenza, Ordini (con tutta la merce base), Account */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-ink/10 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-xl justify-around py-2">
          <NavBtn
            active={tab === 'giacenza'}
            onClick={() => setTab('giacenza')}
            icon={<Package className="size-5" />}
            label="Giacenza"
          />
          <NavBtn
            active={tab === 'ordini'}
            onClick={() => setTab('ordini')}
            icon={<ShoppingBasket className="size-5" />}
            label="Ordini"
            badge={isResp ? pendingOrdersCount : 0}
          />
          {isResp && (
            <NavBtn
              active={tab === 'account'}
              onClick={() => setTab('account')}
              icon={<Users className="size-5" />}
              label="Account"
            />
          )}
        </div>
      </nav>
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
function LoginScreen({ users, onLogin }: { users: User[]; onLogin: (u: User) => void }) {
  const [name, setName] = useState('Simone');
  const [pin, setPin] = useState('');
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [enteredPin, setEnteredPin] = useState('');
  const [pinError, setPinError] = useState(false);

  async function createFirst() {
    const n = name.trim();
    if (!n || pin.length < 4) return;
    const ref = await addDoc(usersCol, { name: n, role: 'responsabile', pin });
    onLogin({ id: ref.id, name: n, role: 'responsabile', pin });
  }

  function handleDigit(d: string) {
    if (!selectedUser || enteredPin.length >= 4) return;
    const next = enteredPin + d;
    setEnteredPin(next);
    setPinError(false);
    if (next.length === 4) {
      if (next === selectedUser.pin) {
        onLogin(selectedUser);
      } else {
        setPinError(true);
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
          <p className="mt-2 text-ink/60">Configura l&apos;account Responsabile</p>
        </div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nome Responsabile (es. Simone)"
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
          Crea account Responsabile
        </button>
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
        {pinError && <p className="text-center text-sm font-semibold text-tomato">PIN errato</p>}

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
              setPinError(false);
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
              setPinError(false);
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
              setPinError(false);
            }}
            className="flex h-14 w-full items-center gap-3 rounded-2xl bg-white px-4 text-left shadow-sm ring-1 ring-ink/10 active:bg-paper"
          >
            <span className="grid size-10 place-items-center rounded-full bg-basil/15 text-lg font-bold text-basil">
              {u.name.charAt(0).toUpperCase()}
            </span>
            <div className="flex-1">
              <div className="font-semibold">{u.name}</div>
              <div className="text-xs text-ink/50">
                {u.role === 'responsabile' ? 'Responsabile' : 'Operatore'}
              </div>
            </div>
            <Lock className="size-4 text-ink/30" />
          </button>
        ))}
      </ul>
      <p className="text-center text-sm text-ink/40">
        Gli operatori e i relativi PIN vengono creati dal Responsabile
      </p>
    </div>
  );
}

/* ─── Sezione Giacenza (Cella di congelamento + Magazzino) */
function InventorySection({ currentUser }: { currentUser: User }) {
  const isResp = currentUser.role === 'responsabile';
  const [items, setItems] = useState<Item[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [onlyLow, setOnlyLow] = useState(false);
  const [zoneFilter, setZoneFilter] = useState<'tutti' | StorageZone>('cella_congelamento');
  const [filterCat, setFilterCat] = useState<Category | 'tutti'>('tutti');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [toast, setToast] = useState('');

  useEffect(() => {
    return onSnapshot(query(itemsCol, orderBy('name')), (snap) => {
      setItems(
        snap.docs.map(
          (d) =>
            ({
              min: 1,
              unit: 'kg',
              quantity: 0,
              category: 'altro',
              zone: 'cella_congelamento',
              ...(d.data() as object),
              id: d.id,
            }) as Item,
        ),
      );
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    return onSnapshot(query(productsCol, orderBy('name')), (snap) => {
      setProducts(
        snap.docs.map(
          (d) =>
            ({
              category: 'altro',
              unit: 'kg',
              defaultMin: 1,
              ...(d.data() as object),
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

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (onlyLow ? low : zoneItems).filter((i) => {
      if (filterCat !== 'tutti' && i.category !== filterCat) return false;
      return i.name.toLowerCase().includes(q);
    });
  }, [zoneItems, low, onlyLow, search, filterCat]);

  const catalogSuggestions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    const inStock = new Set(items.map((i) => i.name.toLowerCase()));
    return products
      .filter((p) => p.name.toLowerCase().includes(q) && !inStock.has(p.name.toLowerCase()))
      .slice(0, 8);
  }, [products, items, search]);

  async function change(i: Item, delta: number) {
    const next = Math.max(0, Number((i.quantity + delta).toFixed(2)));
    if (next === i.quantity) return;
    await updateDoc(doc(db, 'items', i.id), {
      quantity: increment(Number((next - i.quantity).toFixed(2))),
      updatedAt: serverTimestamp(),
    });
    if (!isLow(i) && next <= i.min) {
      sendEmailAlert(i, next);
      setToast(`${i.name}: scorta bassa, avviso inviato`);
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

    const safeMin = isResp
      ? min
      : itemId
        ? items.find((x) => x.id === itemId)?.min ?? 1
        : 1;

    const data = {
      name: n,
      quantity,
      unit,
      min: safeMin,
      category,
      zone,
      productId: pid,
      updatedAt: serverTimestamp(),
    };
    if (itemId) await updateDoc(doc(db, 'items', itemId), data);
    else await addDoc(itemsCol, data);
  }

  async function save() {
    if (!draft || !draft.name.trim()) return;
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
  }

  async function addFromCatalog(p: Product) {
    const targetZone: StorageZone =
      zoneFilter === 'magazzino' ? 'magazzino' : 'cella_congelamento';
    await addDoc(itemsCol, {
      name: p.name,
      quantity: 0,
      unit: p.unit,
      min: p.defaultMin,
      category: p.category,
      zone: targetZone,
      productId: p.id,
      updatedAt: serverTimestamp(),
    });
    setSearch('');
    setToast(`"${p.name}" aggiunto in ${targetZone === 'cella_congelamento' ? 'Cella' : 'Magazzino'}`);
  }

  async function remove() {
    if (!draft?.id) return;
    await deleteDoc(doc(db, 'items', draft.id));
    setDraft(null);
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

  return (
    <div className="px-4">
      <div className="mb-3 grid grid-cols-3 gap-2 rounded-2xl bg-white p-1.5 shadow-sm ring-1 ring-ink/10">
        {[
          { id: 'cella_congelamento' as const, label: '❄️ Cella Congel.' },
          { id: 'magazzino' as const, label: '📦 Magazzino' },
          { id: 'tutti' as const, label: 'Tutto' },
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
        {low.length === 0
          ? 'Tutto in scorta.'
          : `${low.length} ${low.length === 1 ? 'prodotto sotto scorta' : 'prodotti sotto scorta'}.`}
      </p>

      <div className="sticky top-0 z-10 -mx-4 space-y-3 bg-paper/95 px-4 pb-3 pt-1 backdrop-blur">
        <label className="flex h-12 items-center gap-3 rounded-2xl bg-white px-4 shadow-sm ring-1 ring-ink/10">
          <Search className="size-5 text-ink/50" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cerca o aggiungi prodotto in cella"
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
            onClick={() => setFilterCat('tutti')}
            className={`shrink-0 rounded-full px-3 py-1.5 text-sm font-semibold ${
              filterCat === 'tutti' ? 'bg-ink text-white' : 'bg-white ring-1 ring-ink/10'
            }`}
          >
            Tutti
          </button>
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              onClick={() => setFilterCat(c.id)}
              className={`shrink-0 rounded-full px-3 py-1.5 text-sm font-semibold ${
                filterCat === c.id ? 'bg-ink text-white' : 'bg-white ring-1 ring-ink/10'
              }`}
            >
              {c.emoji} {c.label}
            </button>
          ))}
        </div>

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
      </div>

      {loading ? (
        <p className="py-16 text-center text-ink/50">Caricamento…</p>
      ) : shown.length === 0 ? (
        <div className="py-16 text-center text-ink/60">
          <Snowflake className="mx-auto mb-3 size-10 text-basil/60" />
          {zoneItems.length === 0
            ? 'Nessun prodotto stoccato qui. Tocca "Aggiungi" per inserire.'
            : onlyLow && !search
              ? 'Nessun prodotto sotto scorta.'
              : 'Nessun risultato.'}
        </div>
      ) : (
        <ul className="mt-2 space-y-2.5">
          {shown.map((i) => {
            const cat = CATEGORIES.find((c) => c.id === i.category);
            return (
              <li
                key={i.id}
                className={`flex items-center gap-2 rounded-2xl bg-white p-2.5 pl-3 shadow-sm ring-1 ${
                  isLow(i) ? 'ring-tomato/50' : 'ring-ink/10'
                }`}
              >
                <button className="min-w-0 flex-1 text-left" onClick={() => setDraft({ ...i })}>
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm">{cat?.emoji}</span>
                    <span className="truncate text-base font-semibold">{i.name}</span>
                  </div>
                  <div className={`text-xs ${isLow(i) ? 'font-semibold text-tomato' : 'text-ink/50'}`}>
                    {i.quantity === 0
                      ? `Finito · ${i.unit}`
                      : isLow(i)
                        ? `Sotto scorta (min ${i.min} ${i.unit})`
                        : `${i.unit} · min ${i.min}`}
                  </div>
                </button>
                <button
                  aria-label={`Togli uno a ${i.name}`}
                  onClick={() => change(i, -1)}
                  className="grid size-12 place-items-center rounded-xl bg-paper active:bg-ink/10"
                >
                  <Minus className="size-5" />
                </button>
                <span className="w-12 text-center font-display text-2xl font-extrabold tabular-nums">
                  {i.quantity}
                </span>
                <button
                  aria-label={`Aggiungi uno a ${i.name}`}
                  onClick={() => change(i, 1)}
                  className="grid size-12 place-items-center rounded-xl bg-basil text-white active:bg-basil/80"
                >
                  <Plus className="size-5" />
                </button>
              </li>
            );
          })}
        </ul>
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
          onClick={() =>
            setDraft({
              name: search.trim(),
              quantity: 1,
              unit: 'kg',
              min: 1,
              category: 'altro',
              zone: zoneFilter === 'magazzino' ? 'magazzino' : 'cella_congelamento',
            })
          }
          className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-basil font-semibold text-basil"
        >
          <Plus className="size-5" /> Nuovo prodotto &quot;{search.trim()}&quot;
        </button>
      )}

      <button
        onClick={() =>
          setDraft({
            name: '',
            quantity: 1,
            unit: 'kg',
            min: 1,
            category: 'altro',
            zone: zoneFilter === 'magazzino' ? 'magazzino' : 'cella_congelamento',
          })
        }
        className="fixed bottom-20 left-1/2 z-20 flex h-14 -translate-x-1/2 items-center gap-2 rounded-full bg-ink px-7 text-base font-semibold text-white shadow-lg active:scale-95"
      >
        <Plus className="size-5" /> Aggiungi
      </button>

      {toast && (
        <div
          role="status"
          className="fixed inset-x-4 bottom-36 mx-auto max-w-sm rounded-xl bg-ink px-4 py-3 text-center text-white shadow-lg"
        >
          {toast}
        </div>
      )}

      {draft && (
        <ItemSheet
          draft={draft}
          setDraft={setDraft}
          canEditMin={isResp}
          onSave={save}
          onDelete={remove}
          onClose={() => setDraft(null)}
        />
      )}
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
  onSave,
  onDelete,
  onClose,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  canEditMin: boolean;
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
              label="Sotto scorta (Responsabile)"
              value={draft.min}
              onChange={(n) => setDraft({ ...draft, min: n })}
            />
            <p className="mt-1 text-xs text-ink/50">
              Sotto o uguale a questa soglia il prodotto viene segnalato da riordinare.
            </p>
          </div>
        ) : (
          <div className="flex items-center justify-between rounded-2xl bg-paper px-4 py-3 text-sm text-ink/60">
            <span className="flex items-center gap-1.5 font-medium">
              <Lock className="size-4" /> Soglia sotto scorta
            </span>
            <span className="font-bold text-ink">
              {draft.min} {draft.unit} (solo Responsabile)
            </span>
          </div>
        )}

        <button
          onClick={onSave}
          disabled={!draft.name.trim()}
          className="h-12 w-full rounded-2xl bg-basil text-base font-semibold text-white disabled:opacity-40"
        >
          Salva
        </button>

        {draft.id && (
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

/* ─── Sezione Ordini + Merce Base unificata ─────────────── */
type BaseCatalogRow = {
  key: string;
  productId?: string;
  name: string;
  category: Category;
  defaultUnit: OrderUnit;
  stockQty?: number;
  stockUnit?: string;
  low?: boolean;
};

function OrdersSection({ currentUser }: { currentUser: User }) {
  const isResp = currentUser.role === 'responsabile';
  const [orders, setOrders] = useState<Order[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [draftLines, setDraftLines] = useState<Record<string, { qty: number; unit: OrderUnit }>>({});
  const [search, setSearch] = useState('');
  const [note, setNote] = useState('');
  const [filterCat, setFilterCat] = useState<Category | 'tutti'>('tutti');
  const [filterOperator, setFilterOperator] = useState<string>('tutti');
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState('');

  // Aggiunta rapido nuovo prodotto alla merce base
  const [newName, setNewName] = useState('');
  const [newCat, setNewCat] = useState<Category>('altro');
  const [newUnit, setNewUnit] = useState<OrderUnit>('kg');

  useEffect(() => {
    return onSnapshot(query(ordersCol, orderBy('createdAt', 'desc')), (snap) => {
      let list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Order, 'id'>) }));
      if (!isResp) {
        list = list.filter((o) => o.operatorId === currentUser.id);
      }
      setOrders(list);
    });
  }, [currentUser.id, isResp]);

  useEffect(() => {
    return onSnapshot(query(itemsCol, orderBy('name')), (snap) => {
      setItems(
        snap.docs.map(
          (d) =>
            ({
              min: 1,
              unit: 'kg',
              quantity: 0,
              category: 'altro',
              zone: 'cella_congelamento',
              ...(d.data() as object),
              id: d.id,
            }) as Item,
        ),
      );
    });
  }, []);

  useEffect(() => {
    return onSnapshot(query(productsCol, orderBy('name')), (snap) => {
      setProducts(
        snap.docs.map(
          (d) =>
            ({
              category: 'altro',
              unit: 'kg',
              defaultMin: 1,
              ...(d.data() as object),
              id: d.id,
            }) as Product,
        ),
      );
    });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // Elenco unificato di tutta la merce base (prodotti in catalogo + eventuali giacenze)
  const allBaseProducts = useMemo<BaseCatalogRow[]>(() => {
    const map = new Map<string, BaseCatalogRow>();
    products.forEach((p) => {
      const k = p.name.trim().toLowerCase();
      map.set(k, {
        key: k,
        productId: p.id,
        name: p.name,
        category: p.category,
        defaultUnit: normalizeOrderUnit(p.unit),
      });
    });
    items.forEach((i) => {
      const k = i.name.trim().toLowerCase();
      const prev = map.get(k);
      map.set(k, {
        key: k,
        productId: prev?.productId,
        name: i.name,
        category: i.category || prev?.category || 'altro',
        defaultUnit: prev?.defaultUnit ?? normalizeOrderUnit(i.unit),
        stockQty: i.quantity,
        stockUnit: i.unit,
        low: isLow(i),
      });
    });
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, 'it'));
  }, [products, items]);

  const filteredBaseProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allBaseProducts.filter((p) => {
      if (filterCat !== 'tutti' && p.category !== filterCat) return false;
      return !q || p.name.toLowerCase().includes(q);
    });
  }, [allBaseProducts, filterCat, search]);

  // Aggiunge subito il prodotto alla lista d'ordine con "+"
  function addToOrderList(row: BaseCatalogRow) {
    setDraftLines((prev) => {
      const existing = prev[row.key];
      if (!existing) {
        return {
          ...prev,
          [row.key]: { qty: 1, unit: row.defaultUnit || 'kg' },
        };
      }
      return {
        ...prev,
        [row.key]: {
          qty: Number((existing.qty + 1).toFixed(2)),
          unit: existing.unit,
        },
      };
    });
  }

  function updateDraftQty(key: string, qty: number) {
    setDraftLines((prev) => {
      const existing = prev[key];
      if (!existing) return prev;
      if (qty <= 0) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return {
        ...prev,
        [key]: { ...existing, qty: Number(qty.toFixed(2)) },
      };
    });
  }

  function updateDraftUnit(key: string, unit: OrderUnit) {
    setDraftLines((prev) => {
      const existing = prev[key];
      if (!existing) return prev;
      return {
        ...prev,
        [key]: { ...existing, unit },
      };
    });
  }

  function removeDraftLine(key: string) {
    setDraftLines((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  // Crea un nuovo prodotto nella merce base e lo aggiunge subito alla lista d'ordine
  async function createBaseAndAdd() {
    const n = newName.trim();
    if (!n) return;
    const existing = products.find((p) => p.name.toLowerCase() === n.toLowerCase());
    if (!existing) {
      await addDoc(productsCol, {
        name: n,
        category: newCat,
        unit: newUnit,
        defaultMin: 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
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
    setToast(`"${n}" aggiunto alla lista`);
  }

  async function deleteBaseProduct(row: BaseCatalogRow) {
    if (!isResp || !row.productId) return;
    await deleteDoc(doc(db, 'products', row.productId));
    removeDraftLine(row.key);
    setToast(`"${row.name}" rimosso dalla merce base`);
  }

  const compiledEntries = useMemo(() => {
    return Object.entries(draftLines)
      .filter(([, v]) => v.qty > 0)
      .map(([key, v]) => {
        const prod = allBaseProducts.find((p) => p.key === key);
        return {
          productKey: key,
          name: prod?.name ?? key,
          category: prod?.category ?? ('altro' as Category),
          quantity: v.qty,
          unit: v.unit,
        };
      });
  }, [draftLines, allBaseProducts]);

  async function sendFullListToResponsible() {
    if (compiledEntries.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      const lines: OrderLine[] = compiledEntries.map((e) => ({
        productKey: e.productKey,
        name: e.name,
        quantity: e.quantity,
        unit: e.unit,
        category: e.category,
      }));

      await addDoc(ordersCol, {
        operatorId: currentUser.id,
        operatorName: currentUser.name,
        lines,
        note: note.trim(),
        status: 'pending',
        createdAt: serverTimestamp(),
      });

      fetch('/api/notify-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operatorName: currentUser.name,
          lines,
        }),
      }).catch(() => {});

      setDraftLines({});
      setNote('');
      setToast('Lista inviata al Responsabile');
    } finally {
      setSubmitting(false);
    }
  }

  async function setStatus(id: string, status: Order['status']) {
    await updateDoc(doc(db, 'orders', id), { status });
  }

  const operatorsInOrders = useMemo(() => {
    const names = Array.from(new Set(orders.map((o) => o.operatorName)));
    return names.sort((a, b) => a.localeCompare(b, 'it'));
  }, [orders]);

  const visibleOrders = useMemo(() => {
    if (!isResp || filterOperator === 'tutti') return orders;
    return orders.filter((o) => o.operatorName === filterOperator);
  }, [orders, isResp, filterOperator]);

  const pendingCount = orders.filter((o) => o.status === 'pending').length;

  return (
    <div className="space-y-6 px-4">
      {/* 1. COMPILAZIONE LISTA DA TUTTA LA MERCE BASE */}
      <section className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-ink/10">
        <div className="mb-3">
          <h2 className="font-display text-xl font-extrabold">Merce Base & Lista Ordine</h2>
          <p className="text-xs text-ink/60">
            Tocca <strong>+</strong> sul prodotto, imposta quantità e scegli <strong>kg</strong>,{' '}
            <strong>l</strong>, <strong>cartoni</strong> o <strong>pezzi</strong>, poi invia tutta la
            lista al responsabile.
          </p>
        </div>

        {/* Aggiunta veloce nuovo prodotto nella merce base */}
        <div className="mb-3 space-y-2 rounded-2xl bg-paper p-3">
          <div className="flex gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Nuovo prodotto base (es. Panna fresca)"
              maxLength={60}
              className="h-10 flex-1 rounded-xl bg-white px-3 text-sm outline-none ring-1 ring-ink/10"
            />
            <button
              onClick={createBaseAndAdd}
              disabled={!newName.trim()}
              className="flex h-10 shrink-0 items-center gap-1 rounded-xl bg-basil px-3.5 text-sm font-bold text-white disabled:opacity-40"
            >
              <Plus className="size-4" /> Aggiungi
            </button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1">
              {CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setNewCat(c.id)}
                  className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                    newCat === c.id ? 'bg-ink text-white' : 'bg-white text-ink/70'
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
                  className={`rounded-lg px-2 py-1 text-xs font-bold ${
                    newUnit === u ? 'bg-basil text-white' : 'bg-white text-ink/70'
                  }`}
                >
                  {u}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Ricerca e filtri categoria */}
        <label className="mb-2 flex h-11 items-center gap-2 rounded-xl bg-paper px-3">
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

        <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1">
          <button
            onClick={() => setFilterCat('tutti')}
            className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${
              filterCat === 'tutti' ? 'bg-ink text-white' : 'bg-paper text-ink/70'
            }`}
          >
            Tutti ({allBaseProducts.length})
          </button>
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              onClick={() => setFilterCat(c.id)}
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${
                filterCat === c.id ? 'bg-ink text-white' : 'bg-paper text-ink/70'
              }`}
            >
              {c.emoji} {c.label}
            </button>
          ))}
        </div>

        {/* Catalogo merce base con + per aggiungere alla lista */}
        <div className="max-h-72 space-y-1.5 overflow-y-auto pr-0.5">
          {filteredBaseProducts.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink/50">
              Nessun prodotto trovato. Aggiungilo sopra per inserirlo nella merce base.
            </p>
          ) : (
            filteredBaseProducts.map((row) => {
              const inList = draftLines[row.key];
              const cat = CATEGORIES.find((c) => c.id === row.category);
              return (
                <div
                  key={row.key}
                  className={`flex items-center justify-between gap-2 rounded-2xl p-2.5 ring-1 ${
                    inList ? 'bg-basil/10 ring-basil/40' : 'bg-paper ring-transparent'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span>{cat?.emoji}</span>
                      <span className="truncate text-sm font-semibold">{row.name}</span>
                    </div>
                    <div className="text-[11px] text-ink/50">
                      {cat?.label}
                      {row.stockQty !== undefined
                        ? ` · Cella: ${row.stockQty} ${row.stockUnit}`
                        : ''}
                    </div>
                  </div>

                  {inList && (
                    <span className="rounded-full bg-basil px-2.5 py-0.5 text-xs font-bold text-white tabular-nums">
                      {inList.qty} {inList.unit}
                    </span>
                  )}

                  {isResp && row.productId && (
                    <button
                      onClick={() => deleteBaseProduct(row)}
                      aria-label={`Elimina ${row.name} dalla merce base`}
                      className="grid size-9 place-items-center rounded-xl bg-white text-tomato/80"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  )}

                  <button
                    onClick={() => addToOrderList(row)}
                    aria-label={`Aggiungi ${row.name} alla lista`}
                    className="grid size-9 shrink-0 place-items-center rounded-xl bg-basil text-white shadow-xs active:scale-95"
                  >
                    <Plus className="size-4" />
                  </button>
                </div>
              );
            })
          )}
        </div>

        {/* Lista compilata dall'operatore con quantità e unità (kg / l / cartoni / pezzi) */}
        {compiledEntries.length > 0 && (
          <div className="mt-4 space-y-2.5 border-t border-ink/10 pt-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-extrabold">
                Lista da inviare ({compiledEntries.length})
              </h3>
              <button
                onClick={() => setDraftLines({})}
                className="text-xs font-semibold text-tomato underline"
              >
                Svuota lista
              </button>
            </div>

            <ul className="space-y-2">
              {compiledEntries.map((line) => (
                <li
                  key={line.productKey}
                  className="rounded-2xl bg-paper p-3 ring-1 ring-ink/10"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-bold">{line.name}</span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => updateDraftQty(line.productKey, line.quantity - 1)}
                        className="grid size-8 place-items-center rounded-lg bg-white"
                      >
                        <Minus className="size-3.5" />
                      </button>
                      <input
                        type="number"
                        inputMode="decimal"
                        min={0.1}
                        step="0.5"
                        value={line.quantity}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          updateDraftQty(line.productKey, Number.isFinite(v) ? v : 0);
                        }}
                        className="h-8 w-16 rounded-lg bg-white text-center font-display text-sm font-extrabold tabular-nums outline-none ring-1 ring-ink/10"
                      />
                      <button
                        onClick={() => updateDraftQty(line.productKey, line.quantity + 1)}
                        className="grid size-8 place-items-center rounded-lg bg-white"
                      >
                        <Plus className="size-3.5" />
                      </button>
                      <button
                        onClick={() => removeDraftLine(line.productKey)}
                        aria-label={`Rimuovi ${line.name}`}
                        className="grid size-8 place-items-center rounded-lg text-tomato"
                      >
                        <X className="size-4" />
                      </button>
                    </div>
                  </div>

                  {/* Selettore unità di misura: kg / l / cartoni / pezzi */}
                  <div className="mt-2 grid grid-cols-4 gap-1.5">
                    {ORDER_UNITS.map((u) => (
                      <button
                        key={u}
                        onClick={() => updateDraftUnit(line.productKey, u)}
                        className={`h-8 rounded-lg text-xs font-bold ${
                          line.unit === u
                            ? 'bg-ink text-white'
                            : 'bg-white text-ink/70 ring-1 ring-ink/10'
                        }`}
                      >
                        {u}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>

            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note per il responsabile (opzionale)"
              maxLength={120}
              className="h-11 w-full rounded-xl bg-paper px-3 text-sm outline-none ring-1 ring-ink/10"
            />

            <button
              onClick={sendFullListToResponsible}
              disabled={submitting}
              className="flex h-13 w-full items-center justify-center gap-2 rounded-2xl bg-basil text-base font-bold text-white shadow-md active:scale-[0.99] disabled:opacity-50"
            >
              <Send className="size-5" /> Invia lista al responsabile ({compiledEntries.length})
            </button>
          </div>
        )}
      </section>

      {/* 2. STORICO ORDINI RICEVUTI / INVIATI */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="font-display text-xl font-extrabold">
              {isResp ? 'Ordini ricevuti dal team' : 'Le mie liste inviate'}
            </h2>
            {isResp && pendingCount > 0 && (
              <p className="text-sm font-semibold text-tomato">{pendingCount} in attesa</p>
            )}
          </div>
        </div>

        {isResp && operatorsInOrders.length > 0 && (
          <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
            <button
              onClick={() => setFilterOperator('tutti')}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${
                filterOperator === 'tutti' ? 'bg-ink text-white' : 'bg-white ring-1 ring-ink/10'
              }`}
            >
              Tutti ({orders.length})
            </button>
            {operatorsInOrders.map((op) => (
              <button
                key={op}
                onClick={() => setFilterOperator(op)}
                className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${
                  filterOperator === op ? 'bg-ink text-white' : 'bg-white ring-1 ring-ink/10'
                }`}
              >
                {op}
              </button>
            ))}
          </div>
        )}

        {visibleOrders.length === 0 ? (
          <div className="rounded-2xl bg-white py-10 text-center text-sm text-ink/60 ring-1 ring-ink/10">
            <ShoppingBasket className="mx-auto mb-2 size-8 text-ink/40" />
            {isResp
              ? 'Nessun ordine ricevuto ancora.'
              : 'Non hai ancora inviato alcuna lista.'}
          </div>
        ) : (
          <ul className="space-y-3">
            {visibleOrders.map((o) => (
              <li key={o.id} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-ink/10">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div>
                    <div className="text-base font-bold">
                      {isResp ? `Operatore: ${o.operatorName}` : 'Lista inviata'}
                    </div>
                    <div className="text-xs text-ink/50">
                      {o.createdAt
                        ? new Date(o.createdAt.seconds * 1000).toLocaleString('it-IT', {
                            day: '2-digit',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : 'Invio in corso…'}
                    </div>
                  </div>
                  <StatusBadge status={o.status} />
                </div>
                <ul className="mb-2 divide-y divide-ink/5">
                  {o.lines.map((l, idx) => {
                    const cat = CATEGORIES.find((c) => c.id === l.category);
                    return (
                      <li key={idx} className="flex items-center gap-2 py-1.5 text-sm">
                        <span>{cat?.emoji}</span>
                        <span className="flex-1 font-medium">{l.name}</span>
                        <span className="rounded-lg bg-paper px-2.5 py-0.5 font-bold tabular-nums">
                          {l.quantity} {l.unit}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                {o.note && <p className="mb-2 text-sm italic text-ink/60">&ldquo;{o.note}&rdquo;</p>}
                {isResp && o.status === 'pending' && (
                  <button
                    onClick={() => setStatus(o.id, 'received')}
                    className="mt-2 flex h-10 w-full items-center justify-center gap-1 rounded-xl bg-basil text-sm font-semibold text-white"
                  >
                    <Check className="size-4" /> Preso in carico
                  </button>
                )}
                {isResp && o.status === 'received' && (
                  <button
                    onClick={() => setStatus(o.id, 'done')}
                    className="mt-2 flex h-10 w-full items-center justify-center gap-1 rounded-xl bg-ink text-sm font-semibold text-white"
                  >
                    <Check className="size-4" /> Segna completato
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

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

function StatusBadge({ status }: { status: Order['status'] }) {
  const map = {
    pending: { label: 'In attesa', cls: 'bg-tomato/15 text-tomato' },
    received: { label: 'In carico', cls: 'bg-amber-100 text-amber-800' },
    done: { label: 'Completato', cls: 'bg-basil/15 text-basil' },
  };
  const m = map[status];
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${m.cls}`}>{m.label}</span>
  );
}

/* ─── Sezione Account con PIN (solo Responsabile) ──────── */
function AccountsSection({ users }: { users: User[] }) {
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [role, setRole] = useState<Role>('operatore');
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
    await addDoc(usersCol, { name: n, role, pin });
    setName('');
    setPin('');
    setRole('operatore');
    setToast(`Operatore "${n}" creato con PIN`);
  }

  async function saveNewPin(userId: string) {
    if (newPinValue.length < 4) return;
    await updateDoc(doc(db, 'users', userId), { pin: newPinValue });
    setEditingPinId(null);
    setNewPinValue('');
    setToast('PIN aggiornato');
  }

  async function removeUser(u: User) {
    if (users.filter((x) => x.role === 'responsabile').length <= 1 && u.role === 'responsabile') {
      setToast('Serve almeno un responsabile');
      return;
    }
    await deleteDoc(doc(db, 'users', u.id));
    setToast(`"${u.name}" rimosso`);
  }

  async function toggleRole(u: User) {
    const next: Role = u.role === 'operatore' ? 'responsabile' : 'operatore';
    if (u.role === 'responsabile' && users.filter((x) => x.role === 'responsabile').length <= 1) {
      setToast('Serve almeno un responsabile');
      return;
    }
    await updateDoc(doc(db, 'users', u.id), { role: next });
  }

  return (
    <div className="px-4">
      <h2 className="mb-1 font-display text-xl font-extrabold">Gestione Operatori & PIN</h2>
      <p className="mb-4 text-sm text-ink/60">
        Crea gli operatori assegnando nome e PIN a 4 cifre per accedere e inviare gli ordini.
      </p>

      <div className="mb-6 space-y-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-ink/10">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nome operatore"
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
          {(['operatore', 'responsabile'] as Role[]).map((r) => (
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
          <UserPlus className="size-5" /> Crea operatore
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
                    {u.role === 'responsabile' ? 'Responsabile' : 'Operatore'}
                  </button>
                  <span className="text-ink/40">·</span>
                  <span className="font-mono font-semibold text-ink/70">PIN: {u.pin}</span>
                  <button
                    onClick={() => {
                      setEditingPinId(editingPinId === u.id ? null : u.id);
                      setNewPinValue(u.pin);
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
