// Bump this on every deploy that changes any cached file, otherwise
// installed phones keep serving the old version from cache.
//
// Keep the number identical to APP_VERSION in js/version.js. The app compares
// the two at runtime to tell the user when they are looking at a stale copy,
// so they must move together.
const CACHE_NAME = 'expense-tracker-v28';

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
  './js/version.js',
  './js/alerts.js',
  './js/alert-inbox.js',
  './js/free-to-spend.js',
  './js/commitments.js',
  './js/parsers/hdfc-card-current-text.js',
  './js/parsers/icici-credit-card-current.js',
  './js/views/inbox.js',
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
      // cache: 'reload' goes to the server for every file. Without it the
      // browser's own HTTP cache can answer - GitHub Pages lets it keep files
      // for 10 minutes - and a new version would be installed holding copies
      // of the previous version's files: "Version 22" running version-21 code.
      .then((cache) => cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

// Bank alerts shared into the app wait here until the page picks them up.
// Must match SHARE_CACHE in js/alert-inbox.js, and must survive the old-cache
// cleanup below or a share arriving during an update would be thrown away.
const SHARE_CACHE = 'share-inbox';

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME && k !== SHARE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Something shared to the app from Android's share sheet. This has to be
  // handled here and never reach the network: GitHub Pages can't accept a
  // POST, and letting it through would send the bank alert's text - amount,
  // card digits, merchant - to GitHub's servers.
  if (event.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(event.request));
    return;
  }

  if (event.request.method !== 'GET') return;

  // Only the app's own files are served from the cache. Requests to anywhere
  // else - above all the GitHub API that sync talks to - must go straight to
  // the network untouched. Caching them meant sync kept reading the first copy
  // of your gist it ever fetched, so changes from your other device never
  // arrived and each device overwrote the gist with a merge against old data.
  if (url.origin !== self.location.origin) return;

  // Page loads can carry a query string (the app is reopened at ./?shared=1
  // after a share). Match those to the cached page regardless, so it opens
  // offline and the request never goes to the network.
  const matchOptions = event.request.mode === 'navigate' ? { ignoreSearch: true } : undefined;

  event.respondWith(
    caches.match(event.request, matchOptions).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          // Never keep an error page: a 404 cached once would be served forever.
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});

// Parks the shared text in the share cache, then reopens the app, which moves
// it into the alert inbox. Nothing is parsed here - the page owns that logic,
// so there is one parser, not two that can disagree.
async function receiveShare(request) {
  try {
    const form = await request.formData();
    const title = String(form.get('title') || '').trim();
    const text = String(form.get('text') || '').trim();
    const link = String(form.get('url') || '').trim();
    // Some apps repeat the start of the message as the title; don't double it.
    const parts = [title && !text.includes(title) ? title : '', text, link].filter(Boolean);
    if (parts.length) {
      const cache = await caches.open(SHARE_CACHE);
      const key = new URL(`./__shared__/${Date.now()}-${Math.random().toString(36).slice(2)}`, self.registration.scope).href;
      await cache.put(
        new Request(key),
        new Response(JSON.stringify({ text: parts.join('\n'), receivedAt: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }
  } catch (e) {
    // A malformed share still opens the app; there's just nothing to pick up.
  }
  // 303 turns the POST into a plain page load of the app.
  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}

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
