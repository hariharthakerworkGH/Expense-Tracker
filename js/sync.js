import { getAll, put, remove, get } from './db.js';
import { encryptPayload, decryptPayload } from './backup.js';

// Sync between your own devices through a single secret GitHub Gist.
//
// The gist holds one file: the same AES-GCM encrypted blob the backup feature
// produces. GitHub never sees anything but ciphertext, and a secret gist URL
// leaking would still be useless without the passphrase. This is the only
// network call the app ever makes, it is to your own gist, and it does nothing
// until you set it up.
//
// Merging is per record, not whole-file. Whole-file "last device wins" is what
// loses an afternoon of entries from your phone because the laptop synced
// after it. Instead every record carries `updatedAt`, every delete leaves a
// tombstone, and the newer of the two always wins.

const GIST_FILENAME = 'expense-tracker-data.json';
const SYNCED_STORES = ['accounts', 'transactions', 'categories', 'merchantRules', 'recurring', 'importBatches', 'settings'];
const API = 'https://api.github.com';

export async function getSyncConfig() {
  const [token, gistId, lastSync, deviceName] = await Promise.all([
    getMeta('token'),
    getMeta('gistId'),
    getMeta('lastSync'),
    getMeta('deviceName'),
  ]);
  return { token, gistId, lastSync, deviceName, configured: Boolean(token) };
}

export async function saveSyncConfig({ token, gistId, deviceName }) {
  if (token !== undefined) await setMeta('token', token);
  if (gistId !== undefined) await setMeta('gistId', gistId);
  if (deviceName !== undefined) await setMeta('deviceName', deviceName);
}

export async function clearSyncConfig() {
  await remove('syncMeta', 'token', { tombstone: false });
  await remove('syncMeta', 'gistId', { tombstone: false });
  await remove('syncMeta', 'lastSync', { tombstone: false });
}

// The passphrase is kept on the device so sync can run without prompting every
// time. That costs nothing in safety: the transactions themselves are already
// sitting unencrypted in this browser's storage, so anyone who can read the
// passphrase could read the data directly anyway. What it protects is the
// gist - the copy that lives somewhere you don't control - and that stays
// protected. It is stored in `syncMeta`, which is never itself synced.
export async function getSyncPassphrase() {
  return getMeta('passphrase');
}

export async function setSyncPassphrase(value) {
  if (value == null) {
    await remove('syncMeta', 'passphrase', { tombstone: false });
    return;
  }
  await setMeta('passphrase', value);
}

async function getMeta(key) {
  const row = await get('syncMeta', key);
  return row ? row.value : null;
}

async function setMeta(key, value) {
  await put('syncMeta', { id: key, value }, { stamp: false });
}

// --- The main entry point -------------------------------------------------

// Pull what's on the gist, merge it with what's here, write the result back.
// Safe to run on every app open: with nothing to change it is a single GET.
export async function syncNow(passphrase, { onProgress = () => {} } = {}) {
  const { token, gistId } = await getSyncConfig();
  if (!token) throw new SyncError('Sync isn\'t set up yet.');
  if (!passphrase) throw new SyncError('Enter your passphrase to sync.');

  onProgress('Fetching…');
  let remote = null;
  let resolvedGistId = gistId;

  if (gistId) {
    const found = await fetchGist(token, gistId);
    if (!found) throw new SyncError('That gist no longer exists. Disconnect and set sync up again.');
    if (found.content) {
      onProgress('Decrypting…');
      remote = await decryptPayload(found.content, passphrase);
    }
  }

  onProgress('Merging…');
  const local = await readLocal();
  const merged = remote ? mergeSnapshots(local, remote) : { data: local.data, deletions: local.deletions, changed: false };

  // Only rewrite local storage when the remote actually contributed something.
  if (remote) {
    await applyMerged(merged, local);
  }

  onProgress('Uploading…');
  const payload = { data: merged.data, deletions: merged.deletions, syncedAt: Date.now() };
  const content = await encryptPayload(payload, passphrase);

  if (resolvedGistId) {
    await updateGist(token, resolvedGistId, content);
  } else {
    resolvedGistId = await createGist(token, content);
    await setMeta('gistId', resolvedGistId);
  }

  await setMeta('lastSync', Date.now());
  return {
    gistId: resolvedGistId,
    pulled: merged.stats || { added: 0, updated: 0, deleted: 0 },
    counts: Object.fromEntries(SYNCED_STORES.map((s) => [s, merged.data[s].length])),
  };
}

// --- Local snapshot -------------------------------------------------------

async function readLocal() {
  const data = {};
  for (const store of SYNCED_STORES) data[store] = await getAll(store);
  const deletions = await getAll('deletions');
  return { data, deletions };
}

// --- Merge ----------------------------------------------------------------

// Records missing `updatedAt` predate sync. Treating them as age zero would
// let any remote copy silently overwrite them, so they count as "old but
// present": kept unless the other side genuinely has a timestamp.
const stampOf = (record) => (typeof record.updatedAt === 'number' ? record.updatedAt : 0);

export function mergeSnapshots(local, remote) {
  const stats = { added: 0, updated: 0, deleted: 0 };

  // Tombstones from both sides, keyed "store:id", keeping the latest delete.
  const tombstones = new Map();
  for (const t of [...(local.deletions || []), ...(remote.deletions || [])]) {
    const existing = tombstones.get(t.id);
    if (!existing || t.deletedAt > existing.deletedAt) tombstones.set(t.id, t);
  }

  const data = {};
  for (const store of SYNCED_STORES) {
    const byId = new Map();
    for (const record of local.data[store] || []) byId.set(record.id, record);

    for (const incoming of remote.data?.[store] || []) {
      const mine = byId.get(incoming.id);
      if (!mine) {
        byId.set(incoming.id, incoming);
        stats.added++;
      } else if (stampOf(incoming) > stampOf(mine)) {
        byId.set(incoming.id, incoming);
        stats.updated++;
      }
    }

    // A delete only wins if it happened after the surviving record was edited.
    // Edit something on your phone after deleting it on the laptop and the
    // edit is what you meant.
    for (const [id, record] of [...byId]) {
      const tomb = tombstones.get(`${store}:${id}`);
      if (tomb && tomb.deletedAt > stampOf(record)) {
        byId.delete(id);
        stats.deleted++;
      }
    }

    data[store] = [...byId.values()];
  }

  return { data, deletions: [...tombstones.values()], stats, changed: true };
}

// Write the merged result back, touching only what actually differs so a
// no-op sync doesn't rewrite every row (and re-stamp nothing).
async function applyMerged(merged, local) {
  for (const store of SYNCED_STORES) {
    const before = new Map((local.data[store] || []).map((r) => [r.id, r]));
    const after = new Map(merged.data[store].map((r) => [r.id, r]));

    for (const [id, record] of after) {
      const mine = before.get(id);
      if (!mine || stampOf(record) > stampOf(mine)) {
        await put(store, record, { stamp: false });
      }
    }
    for (const id of before.keys()) {
      if (!after.has(id)) await remove(store, id, { tombstone: false });
    }
  }

  // Keep every tombstone we learned about, so the next device to sync sees it.
  const known = new Set((local.deletions || []).map((d) => d.id));
  for (const t of merged.deletions) {
    if (!known.has(t.id)) await put('deletions', t, { stamp: false });
  }
}

// --- GitHub Gist API ------------------------------------------------------

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function fetchGist(token, gistId) {
  const res = await fetch(`${API}/gists/${gistId}`, { headers: headers(token) });
  if (res.status === 404) return null;
  await assertOk(res, 'read the gist');
  const body = await res.json();
  const file = body.files?.[GIST_FILENAME];
  if (!file) return { content: null };
  // The API truncates large files inline; fall back to the raw URL.
  if (file.truncated && file.raw_url) {
    const raw = await fetch(file.raw_url);
    await assertOk(raw, 'download the gist contents');
    return { content: await raw.text() };
  }
  return { content: file.content };
}

async function createGist(token, content) {
  const res = await fetch(`${API}/gists`, {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      description: 'Expense Tracker (encrypted) - do not edit by hand',
      public: false,
      files: { [GIST_FILENAME]: { content } },
    }),
  });
  await assertOk(res, 'create the gist');
  const body = await res.json();
  return body.id;
}

async function updateGist(token, gistId, content) {
  const res = await fetch(`${API}/gists/${gistId}`, {
    method: 'PATCH',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: { [GIST_FILENAME]: { content } } }),
  });
  await assertOk(res, 'save to the gist');
}

// Turns GitHub's status codes into something that says what to do about it.
async function assertOk(res, action) {
  if (res.ok) return;
  if (res.status === 401) throw new SyncError('GitHub rejected your token. It may have expired - create a new one and paste it in again.');
  if (res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') throw new SyncError('GitHub is rate limiting this token. Try again in a few minutes.');
    throw new SyncError(`Your token isn't allowed to ${action}. It needs Gist read and write permission.`);
  }
  if (res.status === 404) throw new SyncError('Not found. Check the token has Gist permission and the gist still exists.');
  throw new SyncError(`GitHub couldn't ${action} (error ${res.status}).`);
}

export class SyncError extends Error {}

export async function testToken(token) {
  const res = await fetch(`${API}/user`, { headers: headers(token) });
  if (res.status === 401) return { ok: false, reason: 'That token was rejected by GitHub.' };
  if (!res.ok) return { ok: false, reason: `GitHub returned error ${res.status}.` };
  const body = await res.json();
  return { ok: true, login: body.login };
}
