// Bump this on every deploy that changes any cached file, otherwise
// installed phones keep serving the old version from cache.
const CACHE_NAME = 'expense-tracker-v16';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/config.js',
  './js/format.js',
  './js/billing-cycle.js',
  './js/account-metrics.js',
  './js/backup.js',
  './js/reconciliation.js',
  './js/recurring.js',
  './js/anomalies.js',
  './js/pdf-text.js',
  './js/merchant-rules.js',
  './js/transfers.js',
  './js/splits.js',
  './js/budgets.js',
  './js/category-style.js',
  './js/reminders.js',
  './js/toast.js',
  './js/frequency.js',
  './js/planner.js',
  './js/sync.js',
  './js/spending-month.js',
  './js/views/coach.js',
  './js/views/add.js',
  './js/views/categories.js',
  './js/views/summary.js',
  './js/views/transactions.js',
  './js/views/accounts.js',
  './js/views/import.js',
  './js/views/settings.js',
  './js/views/plan.js',
  './js/views/recap.js',
  './js/parsers/registry.js',
  './js/parsers/hdfc-bank-savings.js',
  './js/parsers/hdfc-bank-savings-netbanking.js',
  './js/parsers/hdfc-credit-card.js',
  './js/parsers/icici-amazon-pay-credit-card.js',
  './js/vendor/pdf.min.js',
  './js/vendor/pdf.worker.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});

/* ---------------------------------------------------------------------------
   Bill reminders.

   The app works out what you should be reminded about and writes it to the
   `settings` store (see js/reminders.js). All the worker does is check dates
   and show the notification, so there is no second copy of the billing logic
   here to drift out of step.
   --------------------------------------------------------------------------- */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('expense-tracker');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readSetting(db, key, fallback) {
  return new Promise((resolve) => {
    if (!db.objectStoreNames.contains('settings')) return resolve(fallback);
    const req = db.transaction('settings').objectStore('settings').get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : fallback);
    req.onerror = () => resolve(fallback);
  });
}

async function writeSetting(db, key, value) {
  return new Promise((resolve) => {
    const tx = db.transaction('settings', 'readwrite');
    tx.objectStore('settings').put({ id: key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function showDueReminders() {
  const db = await openDB().catch(() => null);
  if (!db) return;
  if (!(await readSetting(db, 'remindersEnabled', false))) return;

  const schedule = await readSetting(db, 'reminderSchedule', []);
  const sent = new Set(await readSetting(db, 'remindersSent', []));
  const today = todayISO();
  let changed = false;

  for (const item of schedule) {
    if (sent.has(item.id) || item.notifyOn > today || item.dueDate < today) continue;
    await self.registration.showNotification(item.title, {
      body: item.body,
      tag: item.id,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      data: { view: 'accounts' },
    });
    sent.add(item.id);
    changed = true;
  }

  if (changed) await writeSetting(db, 'remindersSent', [...sent]);
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'bill-reminders') event.waitUntil(showDueReminders());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const view = event.notification.data && event.notification.data.view;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.postMessage({ type: 'navigate', view: view || 'summary' });
          return client.focus();
        }
      }
      return self.clients.openWindow(`./#${view || 'summary'}`);
    })
  );
});
