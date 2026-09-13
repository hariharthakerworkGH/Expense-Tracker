const DB_NAME = 'expense-tracker';
const DB_VERSION = 2;

let dbPromise = null;

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

export async function put(storeName, value) {
  const s = await store(storeName, 'readwrite');
  await reqToPromise(s.put(value));
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

export async function remove(storeName, id) {
  const s = await store(storeName, 'readwrite');
  await reqToPromise(s.delete(id));
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
