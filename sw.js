// Bump this on every deploy that changes any cached file, otherwise
// installed phones keep serving the old version from cache.
const CACHE_NAME = 'expense-tracker-v9';

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
  './js/reconciliation.js',
  './js/recurring.js',
  './js/anomalies.js',
  './js/pdf-text.js',
  './js/merchant-rules.js',
  './js/transfers.js',
  './js/views/add.js',
  './js/views/categories.js',
  './js/views/summary.js',
  './js/views/transactions.js',
  './js/views/accounts.js',
  './js/views/import.js',
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
