const DB_NAME = 'expense-tracker';
const DB_VERSION = 3;

let dbPromise = null;

// Called after any write, so sync knows there is something to push.
let changeListener = null;
export function onLocalChange(fn) {
  changeListener = fn;
}
function notifyChanged(storeName) {
  // Sync bookkeeping writing to its own store must not re-trigger a sync.
  if (storeName === 'syncMeta') return;
  if (changeListener) changeListener(storeName);
}

// All six stores from the data model are created now, even though Phase 1
// only touches three, so later phases don't need a version-bump migration.
export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('accounts')) {
        db.createObjectStore('accounts', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('transactions')) {
        const store = db.createObjectStore('transactions', { keyPath: 'id' });
        store.createIndex('date', 'date');
        store.createIndex('accountId', 'accountId');
        store.createIndex('categoryId', 'categoryId');
      }
      if (!db.objectStoreNames.contains('categories')) {
        const store = db.createObjectStore('categories', { keyPath: 'id' });
        store.createIndex('parentId', 'parentId');
      }
      if (!db.objectStoreNames.contains('merchantRules')) {
        db.createObjectStore('merchantRules', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('recurring')) {
        db.createObjectStore('recurring', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('importBatches')) {
        db.createObjectStore('importBatches', { keyPath: 'id' });
      }
      // v2: simple key/value for things like expected monthly income.
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'id' });
      }
      // v3: sync support. `deletions` holds tombstones - without them a merge
      // from another device would resurrect everything you'd deleted here.
      // `syncMeta` holds the gist id, token and last-sync marker; it is
      // deliberately never itself synced.
      if (!db.objectStoreNames.contains('deletions')) {
        db.createObjectStore('deletions', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('syncMeta')) {
        db.createObjectStore('syncMeta', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(storeName, mode) {
  const db = await openDB();
  return db.transaction(storeName, mode).objectStore(storeName);
}

// Every write is stamped so a merge between two devices can tell which copy of
// a record is the newer one. `stamp: false` is for restore and sync, which are
// writing records that already carry their own timestamp - re-stamping them
// would make incoming data always look newest and defeat the merge.
export async function put(storeName, value, { stamp = true } = {}) {
  if (stamp) value.updatedAt = Date.now();
  const s = await store(storeName, 'readwrite');
  await reqToPromise(s.put(value));
  notifyChanged(storeName);
  return value;
}

export async function get(storeName, id) {
  const s = await store(storeName, 'readonly');
  return reqToPromise(s.get(id));
}

export async function getAll(storeName) {
  const s = await store(storeName, 'readonly');
  return reqToPromise(s.getAll());
}

export async function remove(storeName, id, { tombstone = true } = {}) {
  const s = await store(storeName, 'readwrite');
  await reqToPromise(s.delete(id));
  // Record that this was deleted here and when, so the next sync removes it on
  // your other device instead of sending it back.
  if (tombstone && storeName !== 'deletions' && storeName !== 'syncMeta') {
    const d = await store('deletions', 'readwrite');
    await reqToPromise(d.put({ id: `${storeName}:${id}`, store: storeName, recordId: id, deletedAt: Date.now() }));
  }
  notifyChanged(storeName);
}

export function newId() {
  return crypto.randomUUID();
}

export async function getSetting(key, fallback = null) {
  const row = await get('settings', key);
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  await put('settings', { id: key, value });
}
