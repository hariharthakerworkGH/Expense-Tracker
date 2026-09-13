import { getAll, remove } from '../db.js';
import { exportEncrypted, decryptBackup, restoreBackup } from '../backup.js';
import { formatDateNice } from '../format.js';

export async function render(container) {
  container.innerHTML = `
    <h3>Backup</h3>
    <p class="group-subtitle">Your data lives only in this browser. If you clear site data or lose the phone, it's gone. A backup is encrypted with a passphrase before it's saved, so it's safe to keep in cloud storage or email.</p>
    <div class="totals-card">
      <label class="field">
        <span>Passphrase</span>
        <input type="password" id="backup-pass" placeholder="You'll need this exact phrase to restore" autocomplete="new-password">
      </label>
      <button type="button" id="backup-export-btn" class="btn-primary">Download encrypted backup</button>
      <p id="backup-status" class="status" hidden></p>
      <p class="muted-note">There's no way to recover the file without this passphrase - not even by me. Write it down somewhere safe.</p>
    </div>

    <h3>Restore</h3>
    <p class="group-subtitle">Replaces everything currently in the app with the contents of a backup file.</p>
    <div class="totals-card">
      <label class="field">
        <span>Backup file</span>
        <input type="file" id="restore-file" accept=".json,application/json">
      </label>
      <label class="field">
        <span>Passphrase</span>
        <input type="password" id="restore-pass" placeholder="The passphrase for that file" autocomplete="current-password">
      </label>
      <button type="button" id="restore-btn" class="btn-secondary btn-block">Restore from backup</button>
      <p id="restore-status" class="status" hidden></p>
    </div>

    <h3>Import history</h3>
    <p class="group-subtitle">Undo an import if you loaded the wrong file or imported the same statement twice.</p>
    <div id="import-history"></div>
  `;

  const passEl = container.querySelector('#backup-pass');
  const statusEl = container.querySelector('#backup-status');

  container.querySelector('#backup-export-btn').addEventListener('click', async () => {
    const passphrase = passEl.value;
    if (passphrase.length < 8) {
      showStatus(statusEl, 'Use a passphrase of at least 8 characters.', true);
      return;
    }
    try {
      showStatus(statusEl, 'Encrypting…', false);
      const { envelope, counts } = await exportEncrypted(passphrase);
      const blob = new Blob([JSON.stringify(envelope)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `expense-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      passEl.value = '';
      showStatus(statusEl, `Backed up ${counts.transactions} transactions and ${counts.accounts} accounts.`, false);
    } catch (err) {
      showStatus(statusEl, `Backup failed: ${err.message}`, true);
    }
  });

  const restoreStatus = container.querySelector('#restore-status');
  container.querySelector('#restore-btn').addEventListener('click', async () => {
    const file = container.querySelector('#restore-file').files[0];
    const passphrase = container.querySelector('#restore-pass').value;
    if (!file) return showStatus(restoreStatus, 'Choose a backup file first.', true);
    if (!passphrase) return showStatus(restoreStatus, 'Enter the passphrase for that file.', true);

    try {
      showStatus(restoreStatus, 'Decrypting…', false);
      const { data, createdAt, counts } = await decryptBackup(await file.text(), passphrase);
      const ok = confirm(
        `This backup is from ${formatDateNice(createdAt)} and holds ${counts.transactions} transactions.\n\n` +
          'Restoring REPLACES everything currently in the app. This cannot be undone.\n\nContinue?'
      );
      if (!ok) return showStatus(restoreStatus, 'Restore cancelled.', false);

      await restoreBackup(data);
      container.querySelector('#restore-pass').value = '';
      container.querySelector('#restore-file').value = '';
      showStatus(restoreStatus, `Restored ${counts.transactions} transactions. Reopen the app to see them.`, false);
    } catch (err) {
      showStatus(restoreStatus, err.message, true);
    }
  });

  await renderImportHistory(container);
}

async function renderImportHistory(container) {
  const el = container.querySelector('#import-history');
  const [batches, accounts, transactions] = await Promise.all([getAll('importBatches'), getAll('accounts'), getAll('transactions')]);

  if (batches.length === 0) {
    el.innerHTML = '<p class="empty">No statements imported yet.</p>';
    return;
  }

  const accountLabel = (id) => accounts.find((a) => a.id === id)?.label || 'Unknown account';
  const sorted = [...batches].sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1));

  el.innerHTML = `
    <div class="totals-card">
      ${sorted
        .map((b) => {
          const stillThere = transactions.filter((t) => t.importBatchId === b.id).length;
          return `
          <div class="upcoming-row">
            <div class="attention-row">
              <span>${escapeHtml(accountLabel(b.accountId))}<br><span class="muted-note">${formatDateNice(b.periodStart)} – ${formatDateNice(b.periodEnd)} · ${stillThere} of ${b.txCount} still here</span></span>
              <button type="button" class="btn-tiny undo-import" data-id="${b.id}" ${stillThere === 0 ? 'disabled' : ''}>Undo</button>
            </div>
          </div>`;
        })
        .join('')}
    </div>
  `;

  el.querySelectorAll('.undo-import').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const batchId = btn.dataset.id;
      const affected = transactions.filter((t) => t.importBatchId === batchId);
      const ok = confirm(
        `Remove the ${affected.length} transactions that came from this import?\n\n` +
          "Anything you'd logged by hand that this import replaced won't come back, and categories you set on these will be lost."
      );
      if (!ok) return;

      for (const t of affected) await remove('transactions', t.id);
      await remove('importBatches', batchId);
      await renderImportHistory(container);
    });
  });
}

function showStatus(el, message, isError) {
  el.hidden = false;
  el.textContent = message;
  el.classList.toggle('out', !!isError);
  el.classList.toggle('in', !isError);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}
