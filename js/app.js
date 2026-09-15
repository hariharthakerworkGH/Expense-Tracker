import { openDB, getAll, put, onLocalChange } from './db.js';
import { getSyncConfig, getSyncPassphrase, syncNow } from './sync.js';
import { CASH_ACCOUNT_ID } from './config.js';
import { detectTransfers } from './transfers.js';
import { showToast } from './toast.js';
import { versionStatus } from './version.js';
import * as addView from './views/add.js';
import * as categoriesView from './views/categories.js';
import * as summaryView from './views/summary.js';
import * as transactionsView from './views/transactions.js';
import * as accountsView from './views/accounts.js';
import * as importView from './views/import.js';
import * as settingsView from './views/settings.js';
import * as planView from './views/plan.js';
import * as recapView from './views/recap.js';
import * as coachView from './views/coach.js';
import * as inboxView from './views/inbox.js';
import { collectSharedAlerts } from './alert-inbox.js';
import { refreshSchedule, runDueReminders } from './reminders.js';

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
  plan: { title: 'Plan', module: planView },
  coach: { title: 'Coach', module: coachView },
  inbox: { title: 'Bank alerts', module: inboxView },
  recap: { title: 'Month in review', module: recapView },
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

let currentView = 'summary';

async function showView(name, params = {}, fromHistory = false) {
  const view = views[name];
  currentView = name;
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  document.getElementById('view-title').textContent = view.title;
  const container = document.getElementById('view-container');

  // Scroll to the top BEFORE swapping content, not after. Doing it afterwards
  // meant the new screen was painted at the old scroll position and then
  // yanked upwards - which is the jerk you see on every tab change.
  window.scrollTo(0, 0);

  container.innerHTML = '';
  await view.module.render(container, params);

  // Replace rather than push: the history stack stays two deep (see
  // wireBackButton) so back always means "go home", never "retrace twenty taps".
  if (!fromHistory) history.replaceState({ view: name, params }, '', urlFor(name));

  // A short fade covers the gap between the blank container and the finished
  // screen, so content arrives instead of popping. Opacity only - a transform
  // here would re-anchor the position:fixed bulk bar inside the container.
  container.classList.remove('view-enter');
  void container.offsetWidth; // restart the animation on a repeat visit
  container.classList.add('view-enter');
}

// Back from any screen returns to Summary. Back from Summary arms an exit: a
// second press within two seconds leaves the app, which is what Android users
// expect. The stack is deliberately kept two deep - a root sentinel plus the
// current screen - so someone who has tapped through fifteen screens still
// gets home in one press instead of pressing back fifteen times.
// Builds the address for a screen from the path alone. A bare '#summary' would
// keep whatever query string the page was opened with - after a share that is
// '?shared=1', which would reopen the alert inbox on every reload.
function urlFor(view) {
  return `${location.pathname}#${view}`;
}

let exitArmed = false;
function wireBackButton() {
  history.replaceState({ view: '__root__' }, '', urlFor('summary'));
  history.pushState({ view: 'summary', params: {} }, '', urlFor('summary'));

  window.addEventListener('popstate', () => {
    // We have just landed on the root sentinel. Put the current screen back on
    // top so there is always something to pop next time.
    if (currentView !== 'summary') {
      history.pushState({ view: 'summary', params: {} }, '', urlFor('summary'));
      showView('summary', {}, true);
      return;
    }
    if (exitArmed) {
      history.back();
      return;
    }
    exitArmed = true;
    showToast('Press back again to exit');
    history.pushState({ view: 'summary', params: {} }, '', urlFor('summary'));
    setTimeout(() => {
      exitArmed = false;
    }, 2000);
  });
}

// Sync runs on open so the other device's changes are already here before you
// start reading numbers, and again a few seconds after you change anything.
// The delay batches a burst of edits - categorising thirty rows is one upload,
// not thirty.
const PUSH_DELAY_MS = 4000;
const SAFE_TO_REFRESH = new Set(['summary', 'accounts', 'coach', 'recap', 'categories']);
let pushTimer = null;
let syncing = false;

function typingInView() {
  const view = document.getElementById('view-container');
  if (!view) return false;
  if (view.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return true;
  return [...view.querySelectorAll('input:not([type=checkbox]):not([type=radio]), textarea')].some((el) => el.value !== el.defaultValue);
}

async function runSync({ silent = true } = {}) {
  if (syncing) return;
  const [{ configured }, passphrase] = await Promise.all([getSyncConfig(), getSyncPassphrase()]);
  if (!configured || !passphrase) return;
  syncing = true;
  setSyncIndicator('syncing');
  try {
    const result = await syncNow(passphrase);
    setSyncIndicator('ok');
    const { added, updated, deleted } = result.pulled;
    if (!silent && (added || updated || deleted)) {
      showToast(`Synced: ${added} new, ${updated} updated`);
    }
    // Bringing in another device's changes makes what's on screen stale - but
    // redrawing a screen you're filling in would throw away what you typed:
    // an amount on Add, an account picked for an alert, a whole statement
    // waiting for review on Import. Only screens with nothing to lose are
    // refreshed; the rest pick the changes up the next time they open.
    // Cards and Coach have small forms too (a statement day, "can I afford
    // this?"), so they're skipped while something on them has been typed into.
    if ((added || updated || deleted) && SAFE_TO_REFRESH.has(currentView) && !typingInView()) await showView(currentView, {}, true);
  } catch (err) {
    setSyncIndicator('error', err.message);
  } finally {
    syncing = false;
  }
}

function setSyncIndicator(state, title = '') {
  const el = document.getElementById('sync-indicator');
  if (!el) return;
  el.hidden = state === 'ok';
  el.textContent = state === 'syncing' ? '↻' : '!';
  el.className = `sync-indicator ${state}`;
  el.title = state === 'error' ? title : 'Syncing…';
}

function wireSync() {
  onLocalChange(() => {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => runSync(), PUSH_DELAY_MS);
  });

  runSync({ silent: false });

  // Coming back to the app after it's been in the background is exactly when
  // the other device is most likely to have moved on.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') runSync({ silent: false });
  });
}

// Reuses the update banner for anything that needs you to act before the app
// can carry on. With no button label, the button is hidden.
function showNotice(message, buttonLabel = null) {
  const banner = document.getElementById('update-banner');
  const text = document.getElementById('update-banner-text');
  const btn = document.getElementById('update-banner-btn');
  if (!banner || !text || !btn) return;
  text.textContent = message;
  btn.hidden = !buttonLabel;
  if (buttonLabel) btn.textContent = buttonLabel;
  banner.hidden = false;
}

// Tells you, rather than leaving you to wonder, when the copy you are looking
// at has been superseded by one already downloaded in the background.
async function showUpdateBannerIfStale() {
  const status = await versionStatus();
  if (!status.stale) return;
  showNotice(`Version ${status.cached} is ready — you're still seeing version ${status.running}.`, 'Reload');
}

function wireUpdateBanner() {
  showUpdateBannerIfStale();

  if ('serviceWorker' in navigator) {
    // A new worker taking over mid-session means newer files are now cached.
    // Only meaningful if something was already controlling this page - on a
    // first-ever install there is no older version to be stale against.
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) showUpdateBannerIfStale();
    });
  }

  // Returning to the app is a natural moment to have picked up a new version.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') showUpdateBannerIfStale();
  });
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
  // Registered before anything else. The service worker is what catches a
  // shared bank alert on the phone; until it's running, a share would go
  // straight to GitHub. Waiting on the database and first render first only
  // widens that gap (for instance after clearing Chrome's site data).
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.error('SW registration failed', err));
  }

  // Wired first thing, so the banner's Reload works even if startup stalls
  // below - which is exactly when it's needed.
  const bannerBtn = document.getElementById('update-banner-btn');
  if (bannerBtn) bannerBtn.addEventListener('click', () => window.location.reload());

  // Both cases involve two copies of the app open at once during an update.
  document.addEventListener('db-blocked', () => {
    showNotice('Expenses is open in another tab or window with the older version. Close it and this one will continue.');
  });
  document.addEventListener('db-superseded', () => {
    showNotice('Expenses was updated in another window.', 'Reload');
  });

  await openDB();
  await seedIfNeeded();
  // Catches card-bill payments in statements imported before detection could
  // recognise them. Skips anything you've marked by hand, and does nothing
  // once everything is already classified.
  await detectTransfers();

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

  // A bank alert shared from the phone's share sheet reopens the app at
  // ?shared=1 with the text parked by the service worker. Pick it up before
  // anything renders and go straight to it.
  const openedFromShare = new URLSearchParams(location.search).has('shared');
  const sharedCount = await collectSharedAlerts();

  wireBackButton();
  if (openedFromShare || sharedCount > 0) {
    await showView('inbox');
  } else {
    await showView('summary', {}, true);
  }

  if ('serviceWorker' in navigator) {
    // Tapping a bill reminder should land on the screen it's about.
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'navigate' && views[e.data.view]) showView(e.data.view);
    });
  }

  // Reminders are recomputed on open (bills change when statements land) and
  // anything that came due while the app was closed is shown now.
  refreshSchedule()
    .then(() => runDueReminders())
    .catch(() => {});

  wireSync();
  wireUpdateBanner();
}

init();
