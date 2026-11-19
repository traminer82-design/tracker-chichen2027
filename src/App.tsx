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
  updateDoc,
} from 'firebase/firestore';
import {
  BookOpen,
  Check,
  ChefHat,
  LogOut,
  Minus,
  Package,
  Plus,
  Search,
  Send,
  Share2,
  ShoppingBasket,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { db } from './firebase';

/* ─── Tipi ─────────────────────────────────────────────── */
type Role = 'operatore' | 'responsabile';
type Category = 'carne' | 'pesce' | 'verdure' | 'latticini' | 'pasticceria' | 'altro';

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
  productId?: string;
};
type Draft = {
  id?: string;
  name: string;
  quantity: number;
  unit: string;
  min: number;
  category: Category;
  productId?: string;
};
type OrderLine = { itemId: string; name: string; quantity: number; unit: string; category: Category };
type Order = {
  id: string;
  operatorId: string;
  operatorName: string;
  lines: OrderLine[];
  note: string;
  status: 'pending' | 'received' | 'done';
  createdAt?: { seconds: number };
};

const UNITS = ['pz', 'kg', 'l', 'conf.'];
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

/* ─── Suono notifica ───────────────────────────────────── */
function playNotifySound() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    o.frequency.value = 880;
    o.type = 'sine';
    g.gain.setValueAtTime(0.25, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
    o.start(ctx.currentTime);
    o.stop(ctx.currentTime + 0.4);
    // secondo beep
    setTimeout(() => {
      const o2 = ctx.createOscillator();
      const g2 = ctx.createGain();
      o2.connect(g2);
      g2.connect(ctx.destination);
      o2.frequency.value = 1174;
      o2.type = 'sine';
      g2.gain.setValueAtTime(0.25, ctx.currentTime);
      g2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
      o2.start(ctx.currentTime);
      o2.stop(ctx.currentTime + 0.35);
    }, 180);
  } catch {
    /* silenzioso se non supportato */
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

function showBrowserNotification(title: string, body: string) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/favicon.ico', tag: 'kitchenos-order' });
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then((p) => {
      if (p === 'granted') new Notification(title, { body, icon: '/favicon.ico', tag: 'kitchenos-order' });
    });
  }
}

/* ─── App principale ───────────────────────────────────── */
export default function App() {
  const [users, setUsers] = useState<User[]>([]);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [tab, setTab] = useState<'giacenza' | 'ordini' | 'catalogo' | 'account'>('giacenza');

  // carica utenti e ripristina sessione
  useEffect(() => {
    const unsub = onSnapshot(query(usersCol, orderBy('name')), (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<User, 'id'>) }));
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

  function login(u: User) {
    localStorage.setItem(STORAGE_KEY, u.id);
    setCurrentUser(u);
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  function logout() {
    localStorage.removeItem(STORAGE_KEY);
    setCurrentUser(null);
    setTab('giacenza');
  }

  if (booting) {
    return (
      <div className="grid min-h-dvh place-items-center text-ink/50">
        Caricamento…
      </div>
    );
  }

  if (!currentUser) {
    return <LoginScreen users={users} onLogin={login} />;
  }

  return (
    <div className="mx-auto min-h-dvh max-w-xl pb-24 pt-4">
      <header className="mb-4 flex items-center justify-between px-4">
        <div>
          <h1 className="font-display text-3xl font-extrabold tracking-tight">KitchenOS</h1>
          <p className="text-sm text-ink/60">
            {currentUser.name} · {currentUser.role === 'responsabile' ? 'Responsabile' : 'Operatore'}
          </p>
        </div>
        <button
          onClick={logout}
          className="flex h-11 items-center gap-2 rounded-full bg-white px-4 text-sm font-semibold ring-1 ring-ink/10"
        >
          <LogOut className="size-4" /> Esci
        </button>
      </header>

      {tab === 'giacenza' && <InventorySection currentUser={currentUser} />}
      {tab === 'ordini' && <OrdersSection currentUser={currentUser} />}
      {tab === 'catalogo' && <CatalogSection />}
      {tab === 'account' && currentUser.role === 'responsabile' && (
        <AccountsSection users={users} />
      )}

      {/* Bottom nav */}
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
          />
          <NavBtn
            active={tab === 'catalogo'}
            onClick={() => setTab('catalogo')}
            icon={<BookOpen className="size-5" />}
            label="Catalogo"
          />
          {currentUser.role === 'responsabile' && (
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
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-0.5 px-4 py-1 text-xs font-semibold ${
        active ? 'text-basil' : 'text-ink/50'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

/* ─── Login ────────────────────────────────────────────── */
function LoginScreen({ users, onLogin }: { users: User[]; onLogin: (u: User) => void }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('operatore');

  async function createFirst() {
    const n = name.trim();
    if (!n) return;
    const ref = await addDoc(usersCol, { name: n, role });
    onLogin({ id: ref.id, name: n, role });
  }

  // Nessun utente: crea il primo (diventa responsabile di default)
  if (users.length === 0) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6">
        <div className="text-center">
          <ChefHat className="mx-auto mb-3 size-14 text-basil" />
          <h1 className="font-display text-3xl font-extrabold">KitchenOS</h1>
          <p className="mt-2 text-ink/60">Crea il primo account (responsabile)</p>
        </div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Il tuo nome"
          maxLength={40}
          className="h-14 rounded-2xl bg-white px-4 text-lg ring-1 ring-ink/10"
          autoFocus
        />
        <button
          onClick={createFirst}
          disabled={!name.trim()}
          className="h-14 rounded-2xl bg-basil text-lg font-semibold text-white disabled:opacity-40"
        >
          Inizia
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6">
      <div className="text-center">
        <ChefHat className="mx-auto mb-3 size-14 text-basil" />
        <h1 className="font-display text-3xl font-extrabold">KitchenOS</h1>
        <p className="mt-2 text-ink/60">Seleziona il tuo account</p>
      </div>
      <ul className="space-y-2">
        {users.map((u) => (
          <button
            key={u.id}
            onClick={() => onLogin(u)}
            className="flex h-14 w-full items-center gap-3 rounded-2xl bg-white px-4 text-left shadow-sm ring-1 ring-ink/10 active:bg-paper"
          >
            <span className="grid size-10 place-items-center rounded-full bg-basil/15 text-lg font-bold text-basil">
              {u.name.charAt(0).toUpperCase()}
            </span>
            <div>
              <div className="font-semibold">{u.name}</div>
              <div className="text-xs text-ink/50">
                {u.role === 'responsabile' ? 'Responsabile' : 'Operatore'}
              </div>
            </div>
          </button>
        ))}
      </ul>
      <p className="text-center text-sm text-ink/40">
        Gli account vengono creati dal responsabile nell&apos;app
      </p>
    </div>
  );
}

/* ─── Sezione Giacenza (inventario) ────────────────────── */
function InventorySection({ currentUser }: { currentUser: User }) {
  void currentUser;
  const [items, setItems] = useState<Item[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [onlyLow, setOnlyLow] = useState(false);
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
              unit: 'pz',
              quantity: 0,
              category: 'altro',
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
              unit: 'pz',
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

  const low = useMemo(() => items.filter(isLow), [items]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (onlyLow ? low : items).filter((i) => {
      if (filterCat !== 'tutti' && i.category !== filterCat) return false;
      return i.name.toLowerCase().includes(q);
    });
  }, [items, low, onlyLow, search, filterCat]);

  // Prodotti del catalogo non ancora in giacenza, filtrati dalla ricerca
  const catalogSuggestions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    const inStock = new Set(items.map((i) => i.name.toLowerCase()));
    return products
      .filter((p) => p.name.toLowerCase().includes(q) && !inStock.has(p.name.toLowerCase()))
      .slice(0, 8);
  }, [products, items, search]);

  async function change(i: Item, delta: number) {
    const next = Math.max(0, i.quantity + delta);
    if (next === i.quantity) return;
    await updateDoc(doc(db, 'items', i.id), {
      quantity: increment(next - i.quantity),
      updatedAt: serverTimestamp(),
    });
    if (!isLow(i) && next <= i.min) {
      sendEmailAlert(i, next);
      setToast(`${i.name}: scorta bassa, avviso inviato`);
    }
  }

  /** Salva in giacenza e aggiorna lo storico prodotti condiviso. */
  async function saveToCatalogAndStock(
    name: string,
    category: Category,
    unit: string,
    min: number,
    quantity: number,
    itemId?: string,
    productId?: string,
  ) {
    const n = name.trim();
    if (!n) return;

    // 1) Aggiorna / crea nello storico (catalogo)
    let pid = productId;
    const existing = products.find((p) => p.name.toLowerCase() === n.toLowerCase());
    if (existing) {
      pid = existing.id;
      await updateDoc(doc(db, 'products', existing.id), {
        name: n,
        category,
        unit,
        defaultMin: min,
        updatedAt: serverTimestamp(),
      });
    } else {
      const ref = await addDoc(productsCol, {
        name: n,
        category,
        unit,
        defaultMin: min,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      pid = ref.id;
    }

    // 2) Aggiorna / crea in giacenza
    const data = {
      name: n,
      quantity,
      unit,
      min,
      category,
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
      draft.id,
      draft.productId,
    );
    setDraft(null);
    setSearch('');
  }

  /** Aggiunge in giacenza un prodotto già presente nel catalogo (1 tap). */
  async function addFromCatalog(p: Product) {
    await addDoc(itemsCol, {
      name: p.name,
      quantity: 0,
      unit: p.unit,
      min: p.defaultMin,
      category: p.category,
      productId: p.id,
      updatedAt: serverTimestamp(),
    });
    setSearch('');
    setToast(`"${p.name}" aggiunto in giacenza`);
  }

  async function remove() {
    if (!draft?.id) return;
    await deleteDoc(doc(db, 'items', draft.id));
    setDraft(null);
  }

  async function shareList() {
    const text = 'Lista della spesa:\n' + low.map((i) => `- ${i.name}`).join('\n');
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
      <p className="mb-3 text-ink/60">
        {low.length === 0
          ? 'Tutto in scorta.'
          : `${low.length} ${low.length === 1 ? 'prodotto da riordinare' : 'prodotti da riordinare'}.`}
      </p>

      <div className="sticky top-0 z-10 -mx-4 space-y-3 bg-paper/95 px-4 pb-3 pt-1 backdrop-blur">
        <label className="flex h-12 items-center gap-3 rounded-2xl bg-white px-4 shadow-sm ring-1 ring-ink/10">
          <Search className="size-5 text-ink/50" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cerca o aggiungi un prodotto"
            className="h-full flex-1 bg-transparent text-base outline-none"
          />
          {search && (
            <button aria-label="Cancella" onClick={() => setSearch('')}>
              <X className="size-5 text-ink/50" />
            </button>
          )}
        </label>

        {/* Filtri categoria */}
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
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
            { label: `Tutti (${items.length})`, value: false },
            { label: `Da riordinare (${low.length})`, value: true },
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
          <ShoppingBasket className="mx-auto mb-3 size-10" />
          {items.length === 0
            ? 'Nessun prodotto. Tocca "Aggiungi" per iniziare.'
            : onlyLow && !search
              ? 'Niente da riordinare.'
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
                      ? 'Finito'
                      : isLow(i)
                        ? `Scorta bassa (min ${i.min})`
                        : i.unit}
                  </div>
                </button>
                <button
                  aria-label={`Togli uno a ${i.name}`}
                  onClick={() => change(i, -1)}
                  className="grid size-12 place-items-center rounded-xl bg-paper active:bg-ink/10"
                >
                  <Minus className="size-5" />
                </button>
                <span className="w-10 text-center font-display text-2xl font-extrabold tabular-nums">
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

      {/* Suggerimenti dallo storico catalogo (prodotti già usati da qualcuno) */}
      {search.trim() && catalogSuggestions.length > 0 && (
        <div className="mt-3 space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink/40">Dallo storico</p>
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
                  + in giacenza
                </span>
              </button>
            );
          })}
        </div>
      )}

      {search.trim() && !exact && !exactInCatalog && (
        <button
          onClick={() =>
            setDraft({ name: search.trim(), quantity: 1, unit: 'pz', min: 1, category: 'altro' })
          }
          className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-basil font-semibold text-basil"
        >
          <Plus className="size-5" /> Nuovo prodotto &quot;{search.trim()}&quot;
        </button>
      )}

      <button
        onClick={() => setDraft({ name: '', quantity: 1, unit: 'pz', min: 1, category: 'altro' })}
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
        <ItemSheet draft={draft} setDraft={setDraft} onSave={save} onDelete={remove} onClose={() => setDraft(null)} />
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
  onSave,
  onDelete,
  onClose,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  onSave: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [confirmDel, setConfirmDel] = useState(false);
  return (
    <div className="fixed inset-0 z-40 flex items-end bg-ink/40" onClick={onClose}>
      <div
        className="mx-auto w-full max-w-xl space-y-4 rounded-t-3xl bg-white p-5 pb-10"
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
          placeholder="Nome (es. Farina 00)"
          maxLength={60}
          className="h-12 w-full rounded-xl bg-paper px-4 text-base"
        />

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

        <Stepper label="Quantità" value={draft.quantity} onChange={(n) => setDraft({ ...draft, quantity: n })} />
        <div className="flex gap-2">
          {UNITS.map((u) => (
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
        <div>
          <Stepper label="Avvisami sotto" value={draft.min} onChange={(n) => setDraft({ ...draft, min: n })} />
          <p className="mt-1 text-sm text-ink/50">
            Sotto o uguale a questa quantità il prodotto va da riordinare.
          </p>
        </div>
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
            <Trash2 className="size-5" /> {confirmDel ? 'Tocca ancora per eliminare' : 'Elimina prodotto'}
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── Sezione Ordini ───────────────────────────────────── */
function OrdersSection({ currentUser }: { currentUser: User }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [note, setNote] = useState('');
  const [filterCat, setFilterCat] = useState<Category | 'tutti'>('tutti');
  const [toast, setToast] = useState('');
  const knownIds = useRef<Set<string>>(new Set());
  const isResp = currentUser.role === 'responsabile';

  // Ascolta ordini (tutti, filtrati lato client per evitare indici compositi)
  useEffect(() => {
    return onSnapshot(query(ordersCol, orderBy('createdAt', 'desc')), (snap) => {
      let list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Order, 'id'>) }));
      if (!isResp) {
        list = list.filter((o) => o.operatorId === currentUser.id);
      }
      // Notifica solo il responsabile per nuovi ordini pending
      if (isResp) {
        list.forEach((o) => {
          if (o.status === 'pending' && !knownIds.current.has(o.id)) {
            if (knownIds.current.size > 0) {
              // non al primo caricamento
              playNotifySound();
              showBrowserNotification(
                'Nuovo ordine',
                `${o.operatorName}: ${o.lines.map((l) => l.name).join(', ')}`,
              );
              setToast(`Nuovo ordine da ${o.operatorName}`);
            }
            knownIds.current.add(o.id);
          } else {
            knownIds.current.add(o.id);
          }
        });
      }
      setOrders(list);
    });
  }, [currentUser.id, isResp]);

  // Items per creare ordine
  useEffect(() => {
    return onSnapshot(query(itemsCol, orderBy('name')), (snap) => {
      setItems(
        snap.docs.map(
          (d) =>
            ({
              min: 1,
              unit: 'pz',
              quantity: 0,
              category: 'altro',
              ...(d.data() as object),
              id: d.id,
            }) as Item,
        ),
      );
    });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const lowItems = useMemo(() => items.filter(isLow), [items]);
  const orderable = useMemo(() => {
    const base = lowItems.length > 0 ? lowItems : items;
    if (filterCat === 'tutti') return base;
    return base.filter((i) => i.category === filterCat);
  }, [items, lowItems, filterCat]);

  function toggleLine(item: Item) {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[item.id]) delete next[item.id];
      else next[item.id] = Math.max(1, item.min - item.quantity + 1) || 1;
      return next;
    });
  }

  function setQty(id: string, qty: number) {
    setSelected((prev) => ({ ...prev, [id]: Math.max(1, qty) }));
  }

  async function submitOrder() {
    const lines: OrderLine[] = Object.entries(selected).map(([itemId, quantity]) => {
      const it = items.find((i) => i.id === itemId)!;
      return {
        itemId,
        name: it.name,
        quantity,
        unit: it.unit,
        category: it.category,
      };
    });
    if (lines.length === 0) return;
    await addDoc(ordersCol, {
      operatorId: currentUser.id,
      operatorName: currentUser.name,
      lines,
      note: note.trim(),
      status: 'pending',
      createdAt: serverTimestamp(),
    });
    setSelected({});
    setNote('');
    setShowNew(false);
    setToast('Ordine inviato al responsabile');
  }

  async function setStatus(id: string, status: Order['status']) {
    await updateDoc(doc(db, 'orders', id), { status });
  }

  const pendingCount = orders.filter((o) => o.status === 'pending').length;

  return (
    <div className="px-4">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="font-display text-xl font-extrabold">
            {isResp ? 'Ordini ricevuti' : 'I miei ordini'}
          </h2>
          {isResp && pendingCount > 0 && (
            <p className="text-sm font-semibold text-tomato">{pendingCount} in attesa</p>
          )}
        </div>
        {!isResp && (
          <button
            onClick={() => setShowNew(true)}
            className="flex h-11 items-center gap-2 rounded-full bg-basil px-4 text-sm font-semibold text-white"
          >
            <Send className="size-4" /> Nuovo ordine
          </button>
        )}
      </div>

      {orders.length === 0 ? (
        <div className="py-16 text-center text-ink/60">
          <ShoppingBasket className="mx-auto mb-3 size-10" />
          {isResp ? 'Nessun ordine ancora.' : 'Non hai ancora inviato ordini.'}
        </div>
      ) : (
        <ul className="space-y-3">
          {orders.map((o) => {
            const catGroups = CATEGORIES.filter((c) => o.lines.some((l) => l.category === c.id));
            return (
              <li key={o.id} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-ink/10">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold">
                      {isResp ? o.operatorName : 'Il tuo ordine'}
                    </div>
                    <div className="text-xs text-ink/50">
                      {o.createdAt
                        ? new Date(o.createdAt.seconds * 1000).toLocaleString('it-IT', {
                            day: '2-digit',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : '…'}
                    </div>
                  </div>
                  <StatusBadge status={o.status} />
                </div>
                <ul className="mb-2 space-y-1">
                  {o.lines.map((l, idx) => {
                    const cat = CATEGORIES.find((c) => c.id === l.category);
                    return (
                      <li key={idx} className="flex items-center gap-2 text-sm">
                        <span>{cat?.emoji}</span>
                        <span className="flex-1">{l.name}</span>
                        <span className="font-semibold tabular-nums">
                          {l.quantity} {l.unit}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                {o.note && <p className="mb-2 text-sm italic text-ink/60">&ldquo;{o.note}&rdquo;</p>}
                {isResp && o.status === 'pending' && (
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => setStatus(o.id, 'received')}
                      className="flex h-9 flex-1 items-center justify-center gap-1 rounded-xl bg-basil text-sm font-semibold text-white"
                    >
                      <Check className="size-4" /> Preso in carico
                    </button>
                  </div>
                )}
                {isResp && o.status === 'received' && (
                  <button
                    onClick={() => setStatus(o.id, 'done')}
                    className="mt-2 flex h-9 w-full items-center justify-center gap-1 rounded-xl bg-ink text-sm font-semibold text-white"
                  >
                    <Check className="size-4" /> Completato
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Modal nuovo ordine (operatore) */}
      {showNew && (
        <div className="fixed inset-0 z-40 flex items-end bg-ink/40" onClick={() => setShowNew(false)}>
          <div
            className="mx-auto flex max-h-[85dvh] w-full max-w-xl flex-col rounded-t-3xl bg-white"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-ink/10 p-4">
              <h2 className="font-display text-xl font-extrabold">Nuovo ordine</h2>
              <button onClick={() => setShowNew(false)}>
                <X className="size-6" />
              </button>
            </div>

            <div className="flex gap-2 overflow-x-auto px-4 pt-3 pb-1">
              <button
                onClick={() => setFilterCat('tutti')}
                className={`shrink-0 rounded-full px-3 py-1.5 text-sm font-semibold ${
                  filterCat === 'tutti' ? 'bg-ink text-white' : 'bg-paper'
                }`}
              >
                Tutti
              </button>
              {CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setFilterCat(c.id)}
                  className={`shrink-0 rounded-full px-3 py-1.5 text-sm font-semibold ${
                    filterCat === c.id ? 'bg-ink text-white' : 'bg-paper'
                  }`}
                >
                  {c.emoji} {c.label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-2">
              <p className="mb-2 text-sm text-ink/50">
                {lowItems.length > 0
                  ? 'Prodotti sotto scorta (seleziona quelli da ordinare)'
                  : 'Seleziona i prodotti da ordinare'}
              </p>
              {orderable.length === 0 ? (
                <p className="py-8 text-center text-ink/50">Nessun prodotto in questa categoria</p>
              ) : (
                <ul className="space-y-2">
                  {orderable.map((i) => {
                    const sel = selected[i.id];
                    const cat = CATEGORIES.find((c) => c.id === i.category);
                    return (
                      <li
                        key={i.id}
                        className={`flex items-center gap-3 rounded-xl p-3 ring-1 ${
                          sel ? 'bg-basil/10 ring-basil/40' : 'bg-paper ring-transparent'
                        }`}
                      >
                        <button className="min-w-0 flex-1 text-left" onClick={() => toggleLine(i)}>
                          <div className="flex items-center gap-1.5">
                            <span>{cat?.emoji}</span>
                            <span className="font-semibold">{i.name}</span>
                          </div>
                          <div className="text-xs text-ink/50">
                            In magazzino: {i.quantity} {i.unit}
                            {isLow(i) && <span className="ml-1 text-tomato">· sotto scorta</span>}
                          </div>
                        </button>
                        {sel ? (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => setQty(i.id, sel - 1)}
                              className="grid size-9 place-items-center rounded-lg bg-white"
                            >
                              <Minus className="size-4" />
                            </button>
                            <span className="w-8 text-center font-bold tabular-nums">{sel}</span>
                            <button
                              onClick={() => setQty(i.id, sel + 1)}
                              className="grid size-9 place-items-center rounded-lg bg-white"
                            >
                              <Plus className="size-4" />
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => toggleLine(i)}
                            className="grid size-9 place-items-center rounded-lg bg-white"
                          >
                            <Plus className="size-4" />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="space-y-3 border-t border-ink/10 p-4">
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Nota (opzionale)"
                maxLength={120}
                className="h-11 w-full rounded-xl bg-paper px-3 text-sm"
              />
              <button
                onClick={submitOrder}
                disabled={Object.keys(selected).length === 0}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-basil text-base font-semibold text-white disabled:opacity-40"
              >
                <Send className="size-5" /> Invia ordine ({Object.keys(selected).length})
              </button>
            </div>
          </div>
        </div>
      )}

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

/* ─── Sezione Catalogo / Storico derrate ────────────────── */
function CatalogSection() {
  const [products, setProducts] = useState<Product[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [search, setSearch] = useState('');
  const [filterCat, setFilterCat] = useState<Category | 'tutti'>('tutti');
  const [draft, setDraft] = useState<{
    id?: string;
    name: string;
    category: Category;
    unit: string;
    defaultMin: number;
  } | null>(null);
  const [toast, setToast] = useState('');

  useEffect(() => {
    return onSnapshot(query(productsCol, orderBy('name')), (snap) => {
      setProducts(
        snap.docs.map(
          (d) =>
            ({
              category: 'altro',
              unit: 'pz',
              defaultMin: 1,
              ...(d.data() as object),
              id: d.id,
            }) as Product,
        ),
      );
    });
  }, []);

  useEffect(() => {
    return onSnapshot(query(itemsCol, orderBy('name')), (snap) => {
      setItems(
        snap.docs.map(
          (d) =>
            ({
              min: 1,
              unit: 'pz',
              quantity: 0,
              category: 'altro',
              ...(d.data() as object),
              id: d.id,
            }) as Item,
        ),
      );
    });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (filterCat !== 'tutti' && p.category !== filterCat) return false;
      return !q || p.name.toLowerCase().includes(q);
    });
  }, [products, search, filterCat]);

  const inStockNames = useMemo(
    () => new Set(items.map((i) => i.name.toLowerCase())),
    [items],
  );

  async function saveProduct() {
    if (!draft || !draft.name.trim()) return;
    const n = draft.name.trim();
    const data = {
      name: n,
      category: draft.category,
      unit: draft.unit,
      defaultMin: draft.defaultMin,
      updatedAt: serverTimestamp(),
    };
    if (draft.id) {
      await updateDoc(doc(db, 'products', draft.id), data);
    } else {
      const exists = products.some((p) => p.name.toLowerCase() === n.toLowerCase());
      if (exists) {
        setToast('Prodotto già presente nello storico');
        return;
      }
      await addDoc(productsCol, { ...data, createdAt: serverTimestamp() });
    }
    setDraft(null);
    setToast('Storico aggiornato');
  }

  async function removeProduct(id: string) {
    await deleteDoc(doc(db, 'products', id));
    setToast('Rimosso dallo storico');
  }

  async function addToStock(p: Product) {
    if (inStockNames.has(p.name.toLowerCase())) {
      setToast('Già in giacenza');
      return;
    }
    await addDoc(itemsCol, {
      name: p.name,
      quantity: 0,
      unit: p.unit,
      min: p.defaultMin,
      category: p.category,
      productId: p.id,
      updatedAt: serverTimestamp(),
    });
    setToast(`"${p.name}" aggiunto in giacenza`);
  }

  return (
    <div className="px-4">
      <h2 className="mb-1 font-display text-xl font-extrabold">Catalogo / Storico</h2>
      <p className="mb-4 text-sm text-ink/60">
        Elenco condiviso delle derrate. Una volta inserito, il prodotto appare a tutti e non serve
        più digitarlo a mano.
      </p>

      <label className="mb-3 flex h-12 items-center gap-3 rounded-2xl bg-white px-4 shadow-sm ring-1 ring-ink/10">
        <Search className="size-5 text-ink/50" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Cerca nello storico"
          className="h-full flex-1 bg-transparent outline-none"
        />
        {search && (
          <button onClick={() => setSearch('')}>
            <X className="size-5 text-ink/50" />
          </button>
        )}
      </label>

      <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
        <button
          onClick={() => setFilterCat('tutti')}
          className={`shrink-0 rounded-full px-3 py-1.5 text-sm font-semibold ${
            filterCat === 'tutti' ? 'bg-ink text-white' : 'bg-white ring-1 ring-ink/10'
          }`}
        >
          Tutti ({products.length})
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

      {shown.length === 0 ? (
        <div className="py-12 text-center text-ink/50">
          <BookOpen className="mx-auto mb-3 size-10" />
          {products.length === 0
            ? 'Storico vuoto. Aggiungi prodotti dalla Giacenza: verranno salvati qui automaticamente.'
            : 'Nessun risultato.'}
        </div>
      ) : (
        <ul className="space-y-2">
          {shown.map((p) => {
            const cat = CATEGORIES.find((c) => c.id === p.category);
            const stocked = inStockNames.has(p.name.toLowerCase());
            return (
              <li
                key={p.id}
                className="flex items-center gap-2 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-ink/10"
              >
                <button
                  className="min-w-0 flex-1 text-left"
                  onClick={() =>
                    setDraft({
                      id: p.id,
                      name: p.name,
                      category: p.category,
                      unit: p.unit,
                      defaultMin: p.defaultMin,
                    })
                  }
                >
                  <div className="flex items-center gap-1.5">
                    <span>{cat?.emoji}</span>
                    <span className="truncate font-semibold">{p.name}</span>
                  </div>
                  <div className="text-xs text-ink/50">
                    {p.unit} · min. {p.defaultMin}
                    {stocked ? ' · in giacenza' : ''}
                  </div>
                </button>
                {!stocked && (
                  <button
                    onClick={() => addToStock(p)}
                    className="rounded-full bg-basil/15 px-3 py-1.5 text-xs font-semibold text-basil"
                  >
                    + Giacenza
                  </button>
                )}
                <button
                  onClick={() => removeProduct(p.id)}
                  className="grid size-9 place-items-center rounded-xl text-tomato"
                  aria-label={`Elimina ${p.name}`}
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <button
        onClick={() =>
          setDraft({ name: search.trim(), category: 'altro', unit: 'pz', defaultMin: 1 })
        }
        className="fixed bottom-20 left-1/2 z-20 flex h-14 -translate-x-1/2 items-center gap-2 rounded-full bg-ink px-7 text-base font-semibold text-white shadow-lg active:scale-95"
      >
        <Plus className="size-5" /> Nuovo nello storico
      </button>

      {draft && (
        <div className="fixed inset-0 z-40 flex items-end bg-ink/40" onClick={() => setDraft(null)}>
          <div
            className="mx-auto w-full max-w-xl space-y-4 rounded-t-3xl bg-white p-5 pb-10"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display text-xl font-extrabold">
                {draft.id ? 'Modifica prodotto' : 'Nuovo nello storico'}
              </h3>
              <button onClick={() => setDraft(null)}>
                <X className="size-6" />
              </button>
            </div>
            <input
              autoFocus
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Nome prodotto"
              maxLength={60}
              className="h-12 w-full rounded-xl bg-paper px-4"
            />
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
            <div className="flex gap-2">
              {UNITS.map((u) => (
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
            <Stepper
              label="Soglia minima predefinita"
              value={draft.defaultMin}
              onChange={(n) => setDraft({ ...draft, defaultMin: n })}
            />
            <button
              onClick={saveProduct}
              disabled={!draft.name.trim()}
              className="h-12 w-full rounded-2xl bg-basil font-semibold text-white disabled:opacity-40"
            >
              Salva nello storico
            </button>
          </div>
        </div>
      )}

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

/* ─── Sezione Account (solo responsabile) ──────────────── */
function AccountsSection({ users }: { users: User[] }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('operatore');
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  async function addUser() {
    const n = name.trim();
    if (!n) return;
    if (users.some((u) => u.name.toLowerCase() === n.toLowerCase())) {
      setToast('Nome già presente');
      return;
    }
    await addDoc(usersCol, { name: n, role });
    setName('');
    setRole('operatore');
    setToast(`Account "${n}" creato`);
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
      <h2 className="mb-1 font-display text-xl font-extrabold">Gestione account</h2>
      <p className="mb-4 text-sm text-ink/60">
        Crea account con solo il nome. Gli operatori inviano ordini, il responsabile li riceve con notifica.
      </p>

      <div className="mb-6 space-y-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-ink/10">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nome operatore / responsabile"
          maxLength={40}
          className="h-12 w-full rounded-xl bg-paper px-4"
        />
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
          disabled={!name.trim()}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-basil font-semibold text-white disabled:opacity-40"
        >
          <UserPlus className="size-5" /> Crea account
        </button>
      </div>

      <ul className="space-y-2">
        {users.map((u) => (
          <li
            key={u.id}
            className="flex items-center gap-3 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-ink/10"
          >
            <span className="grid size-10 place-items-center rounded-full bg-basil/15 text-lg font-bold text-basil">
              {u.name.charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{u.name}</div>
              <button
                onClick={() => toggleRole(u)}
                className="text-xs font-medium text-basil underline"
              >
                {u.role === 'responsabile' ? 'Responsabile' : 'Operatore'} · cambia ruolo
              </button>
            </div>
            <button
              onClick={() => removeUser(u)}
              className="grid size-10 place-items-center rounded-xl text-tomato"
              aria-label={`Elimina ${u.name}`}
            >
              <Trash2 className="size-5" />
            </button>
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
