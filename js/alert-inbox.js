import { get, getAll, put, remove, newId } from './db.js';
import { splitAlerts, parseAlert, alertFingerprint } from './alerts.js';
import { learnFromAssignment } from './merchant-rules.js';

// Alerts waiting for you to confirm them.
//
// They live in their own store, not among transactions, on purpose: every
// total in the app reads the transactions store directly, so a misread alert
// sitting there would already be skewing your spend before you'd seen it.
// Only once you tap Save does an alert become a real transaction.
//
// The inbox stays on the device it was shared to and is never synced. The
// transactions it produces are synced like any other.

const INBOX_STORE = 'alertInbox';

// Must match SHARE_CACHE in sw.js, which parks shared text here: the service
// worker can't reliably write to IndexedDB before the page has upgraded it.
const SHARE_CACHE = 'share-inbox';

export async function pendingAlerts() {
  const rows = await getAll(INBOX_STORE);
  return rows.sort((a, b) => a.receivedAt - b.receivedAt);
}

export async function pendingCount() {
  return (await getAll(INBOX_STORE)).length;
}

// Adds whatever text was shared or pasted, one inbox item per alert in it.
export async function addToInbox(text, via = 'paste', receivedAt = Date.now()) {
  const pieces = splitAlerts(text);
  for (let i = 0; i < pieces.length; i++) {
    // One millisecond apart, so alerts shared together are listed in the order
    // they arrived rather than in whatever order their random ids sort.
    await put(INBOX_STORE, { id: newId(), rawText: pieces[i], via, receivedAt: receivedAt + i }, { stamp: false });
  }
  return pieces.length;
}

// Moves anything the service worker received from the share sheet into the
// inbox. Called on every start; returns how many alerts arrived.
export async function collectSharedAlerts() {
  if (typeof caches === 'undefined') return 0;
  let added = 0;
  try {
    const cache = await caches.open(SHARE_CACHE);
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      const payload = response ? await response.json().catch(() => null) : null;
      if (payload && payload.text) added += await addToInbox(payload.text, 'share', payload.receivedAt || Date.now());
      // Deleted whether or not it parsed, so a malformed share can't jam the queue.
      await cache.delete(request);
    }
  } catch {
    // Cache Storage unavailable (private window): shares can't be received,
    // but pasting still works.
  }
  return added;
}

export async function dismissAlert(id) {
  await remove(INBOX_STORE, id, { tombstone: false });
}

// Turns a confirmed draft into a transaction. `edits` are what you changed on
// the confirm card; the parsed alert supplies everything else.
export async function saveAlert(item, edits) {
  const parsed = parseAlert(item.rawText);
  const transaction = {
    id: newId(),
    accountId: edits.accountId,
    date: edits.date,
    rawDescription: edits.description,
    amount: edits.amount,
    direction: edits.direction,
    categoryId: edits.categoryId || null,
    source: 'alert',
    importBatchId: null,
    isTransfer: Boolean(edits.isTransfer),
    notes: null,
    // Kept so the statement import can recognise this exact transaction later
    // (the UPI reference is printed on the statement too), and so the same
    // alert shared twice is caught.
    alertKey: parsed.ok ? alertFingerprint(parsed) : null,
    alertRef: parsed.ok ? parsed.ref : null,
  };
  // Your call on transfer-or-not sticks, and automatic detection won't undo it.
  if (edits.transferDecided) transaction.transferManual = true;

  await put('transactions', transaction);
  if (transaction.categoryId) await learnFromAssignment(transaction.rawDescription, transaction.categoryId);

  // Remember which account this card number belongs to, so the next alert
  // from it lands in the right place without asking.
  if (parsed.ok && parsed.last4 && edits.accountId) {
    // Read the account fresh rather than trusting the copy from when the
    // screen opened - a sync or statement import may have updated it since,
    // and writing the old copy back would undo that.
    const account = await get('accounts', edits.accountId);
    if (account && account.last4 !== parsed.last4) {
      const links = new Set(account.linkedLast4s || []);
      if (!links.has(parsed.last4)) {
        links.add(parsed.last4);
        await put('accounts', { ...account, linkedLast4s: [...links] });
      }
    }
  }

  await dismissAlert(item.id);
  return transaction;
}
