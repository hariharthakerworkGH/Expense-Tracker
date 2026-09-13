import { getAll, remove } from '../db.js';
import { exportEncrypted, decryptBackup, restoreBackup } from '../backup.js';
import { formatDateNice } from '../format.js';
import { remindersEnabled, reminderDaysBefore, permissionState, enableReminders, disableReminders, refreshSchedule } from '../reminders.js';
import { setSetting } from '../db.js';
import { showToast } from '../toast.js';
import { getSyncConfig, saveSyncConfig, clearSyncConfig, syncNow, testToken, getSyncPassphrase, setSyncPassphrase } from '../sync.js';
import { cycleAwareEnabled } from '../budgets.js';
import { CYCLE_SETTING_KEY } from '../spending-month.js';

export async function render(container) {
  const sync = await getSyncConfig();
  const syncPass = await getSyncPassphrase();
  const cycleAware = await cycleAwareEnabled();
  const enabled = await remindersEnabled();
  const permission = permissionState();
  const daysBefore = await reminderDaysBefore();

  container.innerHTML = `
    <h3>Sync across your devices</h3>
    <p class="group-subtitle">Your data lives in this browser only. Sync keeps your phone and laptop in step through one secret GitHub Gist of your own — encrypted here first, so GitHub only ever stores ciphertext.</p>
    <div class="totals-card">
      ${
        sync.configured
          ? `<div class="attention-row">
              <span>Connected${sync.login ? ` as ${escapeHtml(sync.login)}` : ''}<br><span class="muted-note" id="sync-last">${
                sync.lastSync ? `Last synced ${timeAgo(sync.lastSync)}` : 'Not synced yet'
              }</span></span>
              <button type="button" class="btn-tiny primary" id="sync-now">Sync now</button>
            </div>
            <p id="sync-status" class="status" hidden></p>
            ${
              sync.gistId
                ? `<p class="muted-note">Gist: <code>${escapeHtml(sync.gistId)}</code> — secret, but anyone with the link could fetch the file. It's useless without your passphrase.</p>`
                : ''
            }
            <button type="button" class="btn-tiny danger" id="sync-disconnect">Disconnect sync</button>`
          : `<ol class="setup-steps">
              <li>Open <strong>github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens</strong>.</li>
              <li>Click <strong>Generate new token</strong>. Give it any name and an expiry you're happy with.</li>
              <li>Under <strong>Account permissions</strong>, set <strong>Gists</strong> to <strong>Read and write</strong>. Nothing else is needed.</li>
              <li>Generate it, copy the token, and paste it below.</li>
            </ol>
            <label class="field">
              <span>GitHub token</span>
              <input type="password" id="sync-token" placeholder="github_pat_…" autocomplete="off">
            </label>
            <label class="field">
              <span>Passphrase to encrypt with</span>
              <input type="password" id="sync-pass" placeholder="Use the same one on every device" autocomplete="new-password">
            </label>
            <p class="muted-note">Use the <strong>same passphrase on every device</strong> — it's the only thing that can open the file, and there's no recovery if you forget it.</p>
            <button type="button" class="btn-primary" id="sync-connect">Connect</button>
            <p id="sync-connect-status" class="status" hidden></p>`
      }
    </div>
    ${
      sync.configured && !syncPass
        ? `<div class="totals-card warn-card">
            <label class="field">
              <span>Passphrase needed on this device</span>
              <input type="password" id="sync-pass-again" placeholder="The passphrase you set up sync with" autocomplete="off">
            </label>
            <button type="button" class="btn-secondary btn-block" id="sync-pass-save">Save and sync</button>
          </div>`
        : ''
    }

    <h3>How months are counted</h3>
    <div class="totals-card">
      <div class="attention-row">
        <span>Count card spending by billing cycle<br><span class="muted-note">${
          cycleAware
            ? 'On — a card purchase after its statement day counts towards next month, matching when you actually get billed.'
            : 'Off — everything is counted by calendar date, even if the bill lands next month.'
        }</span></span>
        <button type="button" class="btn-tiny ${cycleAware ? '' : 'primary'}" id="cycle-toggle">${cycleAware ? 'Turn off' : 'Turn on'}</button>
      </div>
    </div>

    <h3>Bill reminders</h3>
    <p class="group-subtitle">A notification before a card bill or fixed commitment is due. Everything is worked out on this phone - nothing is sent anywhere.</p>
    <div class="totals-card">
      ${
        permission === 'unsupported'
          ? '<p class="muted-note">This browser doesn\'t support notifications.</p>'
          : permission === 'denied'
            ? '<p class="muted-note">Notifications are blocked for this app in your browser settings. You\'ll need to allow them there first.</p>'
            : `
        <div class="attention-row">
          <span>Remind me about bills<br><span class="muted-note" id="reminder-state">${enabled ? 'On' : 'Off'}</span></span>
          <button type="button" class="btn-tiny ${enabled ? '' : 'primary'}" id="reminder-toggle">${enabled ? 'Turn off' : 'Turn on'}</button>
        </div>
        <label class="field" style="margin-top:14px">
          <span>How many days before</span>
          <select id="reminder-days">
            ${[1, 2, 3, 5, 7].map((d) => `<option value="${d}" ${d === daysBefore ? 'selected' : ''}>${d} day${d === 1 ? '' : 's'} before</option>`).join('')}
          </select>
        </label>
        <p class="muted-note">Your phone can only wake this app on its own once it's installed to the home screen and you use it regularly. Otherwise the reminder appears the next time you open it - and the bill is always waiting on the Summary either way.</p>`
      }
    </div>

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

    <h3>Categories</h3>
    <p class="group-subtitle">Rename, add or remove the categories you sort spending into.</p>
    <button type="button" id="go-categories" class="btn-secondary btn-block">Manage categories</button>

    <h3>Import history</h3>
    <p class="group-subtitle">Undo an import if you loaded the wrong file or imported the same statement twice.</p>
    <div id="import-history"></div>
  `;

  wireSync(container);

  container.querySelector('#cycle-toggle').addEventListener('click', async () => {
    await setSetting(CYCLE_SETTING_KEY, !cycleAware);
    showToast(cycleAware ? 'Counting by calendar date' : 'Counting by billing cycle');
    render(container);
  });

  const reminderToggle = container.querySelector('#reminder-toggle');
  if (reminderToggle) {
    reminderToggle.addEventListener('click', async () => {
      if (await remindersEnabled()) {
        await disableReminders();
        showToast('Bill reminders off');
      } else {
        const result = await enableReminders(Number(container.querySelector('#reminder-days').value));
        if (!result.ok) {
          showToast(result.reason === 'denied' ? 'Your browser blocked notifications' : "Couldn't turn on reminders");
        } else {
          showToast(result.background ? 'Reminders on, in the background' : 'Reminders on');
        }
      }
      render(container);
    });

    container.querySelector('#reminder-days').addEventListener('change', async (e) => {
      await setSetting('reminderDaysBefore', Number(e.target.value));
      await refreshSchedule();
    });
  }

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

  container.querySelector('#go-categories').addEventListener('click', () => {
    container.dispatchEvent(new CustomEvent('navigate', { bubbles: true, detail: { view: 'categories' } }));
  });

  await renderImportHistory(container);
}

function wireSync(container) {
  const connectBtn = container.querySelector('#sync-connect');
  if (connectBtn) {
    connectBtn.addEventListener('click', async () => {
      const token = container.querySelector('#sync-token').value.trim();
      const passphrase = container.querySelector('#sync-pass').value;
      const statusEl = container.querySelector('#sync-connect-status');
      if (!token) return showStatus(statusEl, 'Paste your GitHub token first.', true);
      if (passphrase.length < 8) return showStatus(statusEl, 'Use a passphrase of at least 8 characters.', true);

      showStatus(statusEl, 'Checking the token…', false);
      const check = await testToken(token);
      if (!check.ok) return showStatus(statusEl, check.reason, true);

      await saveSyncConfig({ token });
      await setSyncPassphrase(passphrase);
      try {
        showStatus(statusEl, `Connected as ${check.login}. Syncing…`, false);
        const result = await syncNow(passphrase, { onProgress: (m) => showStatus(statusEl, m, false) });
        showToast(`Synced ${result.counts.transactions} transactions`);
        render(container);
      } catch (err) {
        showStatus(statusEl, err.message, true);
      }
    });
  }

  const nowBtn = container.querySelector('#sync-now');
  if (nowBtn) {
    nowBtn.addEventListener('click', async () => {
      const statusEl = container.querySelector('#sync-status');
      const passphrase = await getSyncPassphrase();
      if (!passphrase) return showStatus(statusEl, 'Enter your passphrase below first.', true);
      nowBtn.disabled = true;
      try {
        const result = await syncNow(passphrase, { onProgress: (m) => showStatus(statusEl, m, false) });
        const { added, updated, deleted } = result.pulled;
        showStatus(
          statusEl,
          added || updated || deleted
            ? `Brought in ${added} new, ${updated} updated, ${deleted} removed.`
            : 'Already up to date.',
          false
        );
        render(container);
      } catch (err) {
        showStatus(statusEl, err.message, true);
      } finally {
        nowBtn.disabled = false;
      }
    });
  }

  const passSave = container.querySelector('#sync-pass-save');
  if (passSave) {
    passSave.addEventListener('click', async () => {
      const value = container.querySelector('#sync-pass-again').value;
      if (value.length < 8) return;
      await setSyncPassphrase(value);
      render(container);
    });
  }

  const disconnectBtn = container.querySelector('#sync-disconnect');
  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', async () => {
      if (!confirm('Stop syncing on this device?\n\nYour data stays here and the gist stays on GitHub — this only forgets the token and passphrase.')) return;
      await clearSyncConfig();
      await setSyncPassphrase(null);
      render(container);
    });
  }
}

function timeAgo(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} day${Math.round(hours / 24) === 1 ? '' : 's'} ago`;
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
