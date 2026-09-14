import { getAll } from '../db.js';
import { formatCurrency, formatDateNice } from '../format.js';
import { categoryStyle } from '../category-style.js';
import { matchCategoryForDescription } from '../merchant-rules.js';
import { parseAlert, resolveAccount, findExisting } from '../alerts.js';
import { pendingAlerts, addToInbox, dismissAlert, saveAlert } from '../alert-inbox.js';
import { showToast } from '../toast.js';

// Bank alerts you've shared or pasted, each shown as a draft to check and
// save. Nothing here counts towards any total until you tap Save.

const KIND_LABEL = {
  'card-spend': 'Card spend',
  'atm-withdrawal': 'Cash withdrawal',
  'upi-sent': 'UPI payment',
  'upi-credit': 'Money received',
  unknown: 'Bank alert · partly read',
};

let drafts = [];
let context = { accounts: [], categories: [] };

export async function render(container) {
  const [items, accounts, transactions, categories] = await Promise.all([
    pendingAlerts(),
    getAll('accounts'),
    getAll('transactions'),
    getAll('categories'),
  ]);
  context = { accounts, categories };

  drafts = [];
  for (const item of items) {
    const parsed = parseAlert(item.rawText);
    if (!parsed.ok) {
      drafts.push({ item, parsed });
      continue;
    }
    const account = resolveAccount(parsed, accounts, transactions);
    drafts.push({
      item,
      parsed,
      account,
      existing: findExisting(parsed, account ? account.id : null, transactions),
      categoryId: await matchCategoryForDescription(parsed.description),
    });
  }

  const ready = drafts.filter(isReady);

  // Everything sits inside a root that is rebuilt on each render. Listeners go
  // on that root, not on the shared view container - otherwise every re-render
  // would stack another handler (saving an alert twice) and the handlers would
  // keep firing on whatever screen is shown next.
  container.innerHTML = `<div class="inbox-root">
    ${
      drafts.length
        ? `<div class="inbox-head">
            <span>${drafts.length} alert${drafts.length === 1 ? '' : 's'} to check</span>
            ${ready.length > 1 ? `<button type="button" class="btn-tiny primary" id="inbox-save-all">Save ${ready.length} ready</button>` : ''}
          </div>
          ${drafts.map(draftTemplate).join('')}`
        : `<p class="import-intro">No alerts waiting. Share a bank SMS here and it shows up to check before it's saved — nothing counts until you tap Save.</p>`
    }

    <h3>Add an alert yourself</h3>
    <div class="totals-card">
      <button type="button" class="btn-secondary btn-block" id="inbox-paste">Paste from clipboard</button>
      <label class="field" style="margin-top:14px">
        <span>Or paste the message here</span>
        <textarea id="inbox-text" rows="4" placeholder="Spent Rs.329 On HDFC Bank Card 6671 At SWIGGY…"></textarea>
      </label>
      <button type="button" class="btn-tiny" id="inbox-read">Read it</button>
    </div>

    <h3>Sharing from your phone</h3>
    <ol class="setup-steps">
      <li>In Messages, long-press the bank SMS.</li>
      <li>Tap <strong>Share</strong> — if you don't see it, it's in the <strong>⋮</strong> menu.</li>
      <li>Pick <strong>Expenses</strong>. The app opens here with the alert ready to check.</li>
    </ol>
    <p class="muted-note">For an alert email, open it in Gmail, select the text, tap Share, then Expenses. If Expenses isn't in the share list, remove the app from your home screen and install it again from Chrome's menu — Android only adds it to the share list at install.</p>
  </div>`;

  wire(container.querySelector('.inbox-root'), container);
}

// Safe to save in one tap: fully read, account known, not already in the app.
function isReady(d) {
  return d.parsed.ok && d.parsed.confidence === 'exact' && d.account && !d.existing && d.parsed.direction;
}

function draftTemplate(d) {
  const { item, parsed } = d;
  if (!parsed.ok) {
    return `
      <div class="alert-card alert-unreadable" data-id="${item.id}">
        <p class="alert-kind">Couldn't read this one</p>
        <p class="muted-note">${escapeHtml(parsed.reason)}</p>
        <pre class="alert-raw-text">${escapeHtml(item.rawText)}</pre>
        <div class="alert-actions">
          <button type="button" class="btn-tiny alert-skip">Remove</button>
          <button type="button" class="btn-tiny primary alert-manual">Log it by hand</button>
        </div>
      </div>`;
  }

  const sign = parsed.direction === 'credit' ? '+' : parsed.direction === 'debit' ? '-' : '';
  const tone = parsed.direction === 'credit' ? 'in' : 'out';
  const partial = parsed.confidence !== 'exact';
  const recommendSkip = Boolean(d.existing);

  return `
    <div class="alert-card" data-id="${item.id}">
      <div class="alert-top">
        <span class="alert-kind">${KIND_LABEL[parsed.kind] || 'Bank alert'}${d.account ? ` · ${escapeHtml(d.account.label)}` : ''}</span>
        <span class="alert-amount ${tone}">${sign}${formatCurrency(parsed.amount)}</span>
      </div>
      ${existingNote(d.existing)}
      ${partial ? `<p class="alert-note">This wording is new to me, so I've read what I could. Check the amount, account and direction before saving.</p>` : ''}
      ${!d.account ? `<p class="alert-note">${parsed.last4 ? `No account ends in ${parsed.last4} yet — pick the one this belongs to and I'll remember it.` : 'Pick the account this came from.'}</p>` : ''}

      <label class="field">
        <span>What</span>
        <input type="text" class="al-desc" value="${escapeAttr(parsed.description)}">
      </label>

      <div class="alert-grid">
        <label class="field">
          <span>Date${parsed.time ? ` · ${parsed.time}` : ''}</span>
          <input type="date" class="al-date" value="${parsed.date || new Date().toISOString().slice(0, 10)}">
        </label>
        ${
          partial
            ? `<label class="field">
                <span>Amount</span>
                <input type="number" class="al-amount" step="0.01" min="0.01" value="${(parsed.amount / 100).toFixed(2)}">
              </label>`
            : ''
        }
      </div>

      <label class="field">
        <span>Account</span>
        <select class="al-account">
          <option value="">Pick the account</option>
          ${context.accounts
            .map((a) => `<option value="${a.id}" ${d.account && d.account.id === a.id ? 'selected' : ''}>${escapeHtml(a.label)}</option>`)
            .join('')}
        </select>
      </label>

      ${
        partial || !parsed.direction
          ? `<div class="direction-toggle small al-direction">
              <button type="button" class="dir-btn ${parsed.direction === 'debit' ? 'active' : ''}" data-dir="debit">Spent</button>
              <button type="button" class="dir-btn ${parsed.direction === 'credit' ? 'active' : ''}" data-dir="credit">Received</button>
            </div>`
          : ''
      }

      <label class="field">
        <span>Category</span>
        <select class="al-category">
          <option value="">Needs a category</option>
          ${context.categories
            .map((c) => `<option value="${c.id}" ${c.id === d.categoryId ? 'selected' : ''}>${categoryStyle(c.name).icon} ${escapeHtml(c.name)}</option>`)
            .join('')}
        </select>
      </label>

      <label class="checkbox-row">
        <input type="checkbox" class="al-transfer" ${parsed.suggestTransfer ? 'checked' : ''}>
        <span>Not spending — money moved (cash withdrawal, card bill payment)</span>
      </label>

      <details class="alert-original">
        <summary>Original message</summary>
        <pre class="alert-raw-text">${escapeHtml(item.rawText)}</pre>
      </details>

      <div class="alert-actions">
        <button type="button" class="btn-tiny ${recommendSkip ? 'primary' : ''} alert-skip">${recommendSkip ? 'Already there — skip' : 'Skip'}</button>
        <button type="button" class="btn-tiny ${recommendSkip ? '' : 'primary'} alert-save">${saveLabel(d.existing)}</button>
      </div>
    </div>`;
}

function existingNote(existing) {
  if (!existing) return '';
  const t = existing.transaction;
  const when = formatDateNice(t.date);
  if (existing.kind === 'same-alert') {
    return `<p class="alert-note warn">You've already added this exact alert (${when}).</p>`;
  }
  if (existing.kind === 'reference') {
    return `<p class="alert-note warn">Already in the app${t.source === 'statement' ? ' from your statement' : ''} — the reference number matches (${when}).</p>`;
  }
  return `<p class="alert-note warn">Probably already in the app: “${escapeHtml((t.rawDescription || '').slice(0, 40))}” on ${when}, same amount and account${
    t.source === 'statement' ? ', from your statement' : ''
  }.</p>`;
}

function saveLabel(existing) {
  if (!existing) return 'Save';
  return existing.kind === 'likely' ? "It's a different one — save" : 'Save anyway';
}

function wire(root, container) {
  // Guards against a double tap saving the same alert twice while the first
  // save is still writing.
  let busy = false;
  root.addEventListener('click', async (e) => {
    if (busy) return;
    const card = e.target.closest('.alert-card');

    const dirBtn = e.target.closest('.al-direction .dir-btn');
    if (dirBtn && card) {
      card.querySelectorAll('.al-direction .dir-btn').forEach((b) => b.classList.toggle('active', b === dirBtn));
      return;
    }

    if (e.target.closest('.alert-manual')) {
      container.dispatchEvent(new CustomEvent('navigate', { bubbles: true, detail: { view: 'add' } }));
      return;
    }

    busy = true;
    try {
      if (e.target.closest('.alert-skip') && card) {
        await dismissAlert(card.dataset.id);
        showToast('Removed from the list');
        await render(container);
        return;
      }

      if (e.target.closest('.alert-save') && card) {
        const draft = drafts.find((d) => d.item.id === card.dataset.id);
        if (!draft) return;
        const edits = readEdits(card, draft);
        if (edits.error) {
          showToast(edits.error);
          return;
        }
        await saveAlert(draft.item, edits);
        showToast(`Saved ${edits.direction === 'credit' ? '+' : '-'}${formatCurrency(edits.amount)}`);
        await render(container);
        return;
      }

      if (e.target.closest('#inbox-save-all')) {
        let saved = 0;
        for (const d of drafts.filter(isReady)) {
          const cardEl = root.querySelector(`.alert-card[data-id="${d.item.id}"]`);
          const edits = cardEl ? readEdits(cardEl, d) : null;
          if (edits && !edits.error) {
            await saveAlert(d.item, edits);
            saved++;
          }
        }
        showToast(`Saved ${saved} alert${saved === 1 ? '' : 's'}`);
        await render(container);
        return;
      }

      if (e.target.closest('#inbox-paste')) {
        let text = null;
        try {
          text = await navigator.clipboard.readText();
        } catch {
          showToast("Couldn't read the clipboard — paste into the box below");
          root.querySelector('#inbox-text').focus();
          return;
        }
        await ingest(container, text);
        return;
      }

      if (e.target.closest('#inbox-read')) {
        await ingest(container, root.querySelector('#inbox-text').value);
      }
    } finally {
      busy = false;
    }
  });
}

async function ingest(container, text) {
  if (!text || !text.trim()) {
    showToast('Nothing to read yet');
    return;
  }
  const n = await addToInbox(text, 'paste');
  showToast(`${n} alert${n === 1 ? '' : 's'} added to check`);
  await render(container);
}

function readEdits(card, draft) {
  const { parsed } = draft;
  const accountId = card.querySelector('.al-account').value;
  const account = context.accounts.find((a) => a.id === accountId);
  if (!account) return { error: 'Pick the account first' };

  const activeDir = card.querySelector('.al-direction .dir-btn.active');
  const direction = activeDir ? activeDir.dataset.dir : parsed.direction;
  if (!direction) return { error: 'Choose Spent or Received' };

  const amountInput = card.querySelector('.al-amount');
  const amount = amountInput ? Math.round(parseFloat(amountInput.value) * 100) : parsed.amount;
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'Check the amount' };

  const date = card.querySelector('.al-date').value;
  if (!date) return { error: 'Pick a date' };

  const isTransfer = card.querySelector('.al-transfer').checked;
  return {
    accountId,
    direction,
    amount,
    date,
    description: card.querySelector('.al-desc').value.trim() || parsed.description,
    categoryId: card.querySelector('.al-category').value || null,
    isTransfer,
    // Only a decision you actually made should block automatic detection later.
    transferDecided: isTransfer || isTransfer !== parsed.suggestTransfer,
  };
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

function escapeAttr(str) {
  return escapeHtml(str);
}
