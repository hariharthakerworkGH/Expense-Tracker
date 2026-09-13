import { getAll, put, remove } from './db.js';

const STORES = ['accounts', 'transactions', 'categories', 'merchantRules', 'recurring', 'importBatches'];
const FORMAT = 'expense-tracker-backup';
const FORMAT_VERSION = 1;
const PBKDF2_ITERATIONS = 210000;

// Everything lives in one browser's IndexedDB, so a backup is the only thing
// standing between you and total loss if the phone dies or site data gets
// cleared. The file is encrypted with a passphrase-derived key before it
// ever leaves the device, so it's safe to put in cloud storage or email.
export async function exportEncrypted(passphrase) {
  const data = {};
  for (const store of STORES) {
    data[store] = await getAll(store);
  }

  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

  return {
    envelope: {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: toBase64(salt) },
      iv: toBase64(iv),
      data: toBase64(new Uint8Array(cipher)),
    },
    counts: Object.fromEntries(STORES.map((s) => [s, data[s].length])),
  };
}

export async function decryptBackup(fileText, passphrase) {
  let envelope;
  try {
    envelope = JSON.parse(fileText);
  } catch {
    throw new Error("That file isn't a backup file (it isn't valid JSON).");
  }
  if (envelope.format !== FORMAT) {
    throw new Error("That file isn't an Expense Tracker backup.");
  }
  if (envelope.formatVersion > FORMAT_VERSION) {
    throw new Error('That backup was made by a newer version of the app than this one.');
  }

  const salt = fromBase64(envelope.kdf.salt);
  const iv = fromBase64(envelope.iv);
  const key = await deriveKey(passphrase, salt, envelope.kdf.iterations);

  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, fromBase64(envelope.data));
  } catch {
    // AES-GCM authentication failing means either the wrong passphrase or a
    // corrupted file; there's no way to tell which, so say both.
    throw new Error('Could not decrypt - wrong passphrase, or the file is damaged.');
  }

  const data = JSON.parse(new TextDecoder().decode(plaintext));
  return {
    data,
    createdAt: envelope.createdAt,
    counts: Object.fromEntries(STORES.map((s) => [s, (data[s] || []).length])),
  };
}

// Replaces everything. The caller is responsible for confirming with the user
// first - there is no undo beyond restoring another backup.
export async function restoreBackup(data) {
  for (const store of STORES) {
    const existing = await getAll(store);
    for (const record of existing) {
      await remove(store, record.id);
    }
    for (const record of data[store] || []) {
      await put(store, record);
    }
  }
}

async function deriveKey(passphrase, salt, iterations = PBKDF2_ITERATIONS) {
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function toBase64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(str) {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
