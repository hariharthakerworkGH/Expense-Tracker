import { openDB, getAll, put } from './db.js';
import { CASH_ACCOUNT_ID } from './config.js';
import * as addView from './views/add.js';
import * as categoriesView from './views/categories.js';
import * as summaryView from './views/summary.js';
import * as transactionsView from './views/transactions.js';
import * as accountsView from './views/accounts.js';
import * as importView from './views/import.js';
import * as settingsView from './views/settings.js';

const SEED_CATEGORIES = [
  { id: 'cat-food', name: 'Food & Dining', parentId: null },
  { id: 'cat-groceries', name: 'Groceries', parentId: null },
  { id: 'cat-transport', name: 'Transport', parentId: null },
  { id: 'cat-bills', name: 'Bills & Utilities', parentId: null },
  { id: 'cat-rent', name: 'Rent', parentId: null },
  { id: 'cat-shopping', name: 'Shopping', parentId: null },
  { id: 'cat-entertainment', name: 'Entertainment', parentId: null },
  { id: 'cat-health', name: 'Health', parentId: null },
  { id: 'cat-income', name: 'Income', parentId: null },
  { id: 'cat-transfer', name: 'Transfer', parentId: null },
  { id: 'cat-other', name: 'Other', parentId: null },
];

const SEED_ACCOUNT = { id: CASH_ACCOUNT_ID, label: 'Cash', type: 'cash', issuer: null, last4: null };

const views = {
  summary: { title: 'Summary', module: summaryView },
  add: { title: 'Add', module: addView },
  transactions: { title: 'Transactions', module: transactionsView },
  accounts: { title: 'Accounts', module: accountsView },
  categories: { title: 'Categories', module: categoriesView },
  import: { title: 'Import Statement', module: importView },
  settings: { title: 'Backup & Settings', module: settingsView },
};

async function seedIfNeeded() {
  const [categories, accounts] = await Promise.all([getAll('categories'), getAll('accounts')]);
  if (categories.length === 0) {
    for (const c of SEED_CATEGORIES) await put('categories', c);
  }
  if (accounts.length === 0) {
    await put('accounts', SEED_ACCOUNT);
  }
}

async function showView(name, params = {}) {
  const view = views[name];
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  document.getElementById('view-title').textContent = view.title;
  const container = document.getElementById('view-container');
  container.innerHTML = '';
  await view.module.render(container, params);
  history.replaceState(null, '', `#${name}`);
  // Switching tabs must land at the top - otherwise a screen you'd scrolled
  // down on leaves the NEXT screen opening mid-scroll, looking stuck/broken.
  window.scrollTo(0, 0);
}

// The nav's real height depends on the device's font scaling and safe-area
// inset, so measure it instead of guessing - otherwise it sits on top of the
// last rows of content.
function syncNavHeight() {
  const nav = document.querySelector('.bottom-nav');
  if (!nav) return;
  document.documentElement.style.setProperty('--nav-height', `${nav.offsetHeight}px`);
}

async function init() {
  await openDB();
  await seedIfNeeded();

  syncNavHeight();
  window.addEventListener('resize', syncNavHeight);
  window.addEventListener('orientationchange', syncNavHeight);

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });

  document.getElementById('settings-btn').addEventListener('click', () => showView('settings'));

  document.addEventListener('navigate', (e) => {
    const { view, ...params } = e.detail;
    showView(view, params);
  });

  const startView = (location.hash || '#summary').slice(1);
  showView(views[startView] ? startView : 'summary');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.error('SW registration failed', err));
  }
}

init();
