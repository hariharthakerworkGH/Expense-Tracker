import { getAll, getSetting, setSetting } from './db.js';
import { cardBillDue } from './account-metrics.js';
import { formatCurrency } from './format.js';
import { frequencyOf, hasDueDate, nextOccurrence } from './frequency.js';

// Bill reminders without a server.
//
// The app computes *what* to remind you about and stores it; the service
// worker only has to check dates and show the notification. That split means
// there's no duplicated bill logic in the worker, and no data ever leaves the
// phone. Delivery happens through Periodic Background Sync where the browser
// supports it (installed PWAs on Android), and otherwise the next time you
// open the app - which is stated plainly in Settings rather than pretending
// otherwise.

const SYNC_TAG = 'bill-reminders';
const DEFAULT_DAYS_BEFORE = 3;

export async function remindersEnabled() {
  return (await getSetting('remindersEnabled', false)) === true;
}

export async function reminderDaysBefore() {
  return (await getSetting('reminderDaysBefore', DEFAULT_DAYS_BEFORE)) || DEFAULT_DAYS_BEFORE;
}

function notificationsSupported() {
  return typeof Notification !== 'undefined' && 'serviceWorker' in navigator;
}

export function permissionState() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export async function enableReminders(daysBefore = DEFAULT_DAYS_BEFORE) {
  if (!notificationsSupported()) return { ok: false, reason: 'unsupported' };
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: permission };

  await setSetting('remindersEnabled', true);
  await setSetting('reminderDaysBefore', daysBefore);
  await refreshSchedule();
  await registerPeriodicSync();
  return { ok: true, background: await periodicSyncActive() };
}

export async function disableReminders() {
  await setSetting('remindersEnabled', false);
  await setSetting('reminderSchedule', []);
  if ('serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    if (reg && reg.periodicSync) await reg.periodicSync.unregister(SYNC_TAG).catch(() => {});
  }
}

async function registerPeriodicSync() {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  if (!reg || !reg.periodicSync) return;
  try {
    await reg.periodicSync.register(SYNC_TAG, { minInterval: 12 * 60 * 60 * 1000 });
  } catch {
    // Browsers refuse this unless the app is installed and used regularly.
    // The on-open path still works, so there is nothing to report.
  }
}

async function periodicSyncActive() {
  if (!('serviceWorker' in navigator)) return false;
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  if (!reg || !reg.periodicSync) return false;
  const tags = await reg.periodicSync.getTags().catch(() => []);
  return tags.includes(SYNC_TAG);
}

// Rebuilds the list of things worth a notification: card bills that are still
// unpaid, and fixed monthly commitments. Ids include the due date so a new
// statement produces a new reminder rather than reusing a spent one.
export async function refreshSchedule() {
  if (!(await remindersEnabled())) return [];
  const daysBefore = await reminderDaysBefore();
  const [accounts, recurring] = await Promise.all([getAll('accounts'), getAll('recurring')]);
  const schedule = [];

  for (const account of accounts) {
    const bill = cardBillDue(account);
    if (!bill || bill.paid || !bill.dueDate) continue;
    schedule.push({
      id: `bill-${account.id}-${bill.dueDate}`,
      title: `${account.label} bill due`,
      body: `${formatCurrency(bill.amount)} due on ${niceDate(bill.dueDate)}.`,
      notifyOn: shiftDays(bill.dueDate, -daysBefore),
      dueDate: bill.dueDate,
    });
  }

  const today = new Date();
  for (const r of recurring) {
    if (r.source !== 'fixed' || r.active === false) continue;
    // Reminding you daily that you buy chai daily helps nobody - only things
    // that fall due on a particular date are worth a notification.
    if (!hasDueDate(frequencyOf(r))) continue;
    const due = nextOccurrence(r.dayOfMonth, today);
    schedule.push({
      id: `fixed-${r.id}-${due}`,
      title: `${r.label} is due`,
      body: `${formatCurrency(r.amount)} on ${niceDate(due)}.`,
      notifyOn: shiftDays(due, -daysBefore),
      dueDate: due,
    });
  }

  await setSetting('reminderSchedule', schedule);
  // Forget records of reminders whose due date has passed, so the list can't
  // grow without bound.
  const sent = await getSetting('remindersSent', []);
  const live = new Set(schedule.map((s) => s.id));
  await setSetting('remindersSent', sent.filter((id) => live.has(id)));
  return schedule;
}

// Shows anything that has come due since the last time the app was open.
export async function runDueReminders() {
  if (!(await remindersEnabled())) return 0;
  if (permissionState() !== 'granted') return 0;
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  if (!reg) return 0;

  const [schedule, sent] = await Promise.all([getSetting('reminderSchedule', []), getSetting('remindersSent', [])]);
  const today = todayISO();
  const sentSet = new Set(sent);
  let shown = 0;

  for (const item of schedule) {
    if (sentSet.has(item.id) || item.notifyOn > today || item.dueDate < today) continue;
    await reg.showNotification(item.title, {
      body: item.body,
      tag: item.id,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      data: { view: 'accounts' },
    });
    sentSet.add(item.id);
    shown++;
  }

  if (shown) await setSetting('remindersSent', [...sentSet]);
  return shown;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shiftDays(iso, delta) {
  const d = new Date(iso);
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function niceDate(iso) {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
