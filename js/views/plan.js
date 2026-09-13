import { getAll, put, remove, newId, getSetting, setSetting } from '../db.js';
import { formatCurrency, formatSignedCurrency, ordinal } from '../format.js';
import { detectRecurring } from '../recurring.js';

let adding = false;

// Fixed commitments live in the `recurring` store alongside auto-detected
// bills; `source` tells them apart so detection never clobbers what you
// entered by hand.
const isFixed = (r) => r.source === 'fixed';

export async function render(container) {
  const [categories, recurring, transactions, income] = await Promise.all([
    getAll('categories'),
    getAll('recurring'),
    getAll('transactions'),
    getSetting('monthlyIncome', null),
  ]);

  const fixed = recurring.filter((r) => isFixed(r) && r.active !== false);
  const fixedTotal = fixed.reduce((s, r) => s + r.amount, 0);
  const fixedCategoryIds = new Set(fixed.map((r) => r.categoryId).filter(Boolean));

  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const thisMonth = transactions.filter((t) => t.date >= monthStart && !t.isTransfer);
  const variableSpent = thisMonth
    .filter((t) => t.direction === 'debit' && !fixedCategoryIds.has(t.categoryId))
    .reduce((s, t) => s + t.amount, 0);

  const suggestedIncome = suggestIncome(transactions, categories);
  const incomeValue = income != null ? income : suggestedIncome;
  const disposable = incomeValue != null ? incomeValue - fixedTotal : null;
  const left = disposable != null ? disposable - variableSpent : null;

  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft = Math.max(1, daysInMonth - now.getDate() + 1);
  const perDay = left != null ? Math.floor(left / daysLeft) : null;

  // Hide suggestions already covered by something fixed. Category match only
  // counts when both actually have one - otherwise a single uncategorised fixed
  // expense would silently hide every suggestion.
  const detected = (await detectRecurring()).filter(
    (d) =>
      !fixed.some(
        (f) =>
          f.label.toLowerCase() === d.label.toLowerCase() ||
          (f.categoryId && d.categoryId && f.categoryId === d.categoryId)
      )
  );

  container.innerHTML = `
    <p class="import-intro">Set what you earn and what's already committed each month, and this tells you what's genuinely free to spend.</p>

    <div class="totals-card">
      <label class="field">
        <span>Monthly income</span>
        <input type="number" id="plan-income" inputmode="decimal" step="1" placeholder="${suggestedIncome != null ? (suggestedIncome / 100).toFixed(0) : 'e.g. 80000'}" value="${incomeValue != null ? (incomeValue / 100).toFixed(0) : ''}">
      </label>
      ${
        income == null && suggestedIncome != null
          ? `<p class="muted-note">Suggested from what landed in your Income category recently. Change it if that's not typical.</p>`
          : ''
      }
      <div class="totals-row"><span>Income</span><span class="in">${incomeValue != null ? formatCurrency(incomeValue) : '—'}</span></div>
      <div class="totals-row"><span>Fixed commitments</span><span class="out">-${formatCurrency(fixedTotal)}</span></div>
      <div class="totals-row net"><span>Free each month</span><span>${disposable != null ? formatSignedCurrency(disposable) : '—'}</span></div>
    </div>

    ${
      left != null
        ? `<div class="totals-card">
            <div class="totals-row"><span>Spent so far this month<br><span class="muted-note">not counting fixed commitments</span></span><span class="out">-${formatCurrency(variableSpent)}</span></div>
            <div class="totals-row net"><span>Left to spend</span><span class="${left < 0 ? 'out' : 'in'}">${formatSignedCurrency(left)}</span></div>
            <div class="muted-note">${left < 0 ? `You're over by ${formatCurrency(Math.abs(left))} with ${daysLeft} day${daysLeft === 1 ? '' : 's'} to go.` : `About ${formatCurrency(perDay)} a day for the remaining ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`}</div>
          </div>`
        : ''
    }

    <h3>Fixed monthly commitments</h3>
    <p class="group-subtitle">Rent, EMIs, subscriptions - anything you owe every month regardless of how careful you are.</p>
    ${fixed.length ? `<div class="totals-card">${fixed.map((f) => fixedRow(f, categories)).join('')}</div>` : '<p class="empty">Nothing added yet.</p>'}
    ${adding ? fixedForm(categories) : '<button type="button" id="plan-add-btn" class="btn-secondary btn-block">Add a fixed expense</button>'}

    ${
      detected.length
        ? `<h3>Looks recurring</h3>
           <p class="group-subtitle">Spotted in your history. Add any that are genuinely fixed every month.</p>
           <div class="totals-card">
             ${detected
               .map(
                 (d) => `<div class="attention-row">
                   <span>${escapeHtml(d.label)}<br><span class="muted-note">${formatCurrency(d.amount)} · around the ${ordinal(d.dayOfMonth)}</span></span>
                   <button type="button" class="btn-tiny promote-detected" data-id="${d.id}">Add</button>
                 </div>`
               )
               .join('')}
           </div>`
        : ''
    }
  `;

  const incomeEl = container.querySelector('#plan-income');
  incomeEl.addEventListener('change', async () => {
    const raw = parseFloat(incomeEl.value);
    await setSetting('monthlyIncome', Number.isFinite(raw) ? Math.round(raw * 100) : null);
    render(container);
  });

  const addBtn = container.querySelector('#plan-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      adding = true;
      render(container);
    });
  }

  const form = container.querySelector('#fixed-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const label = form.querySelector('.ff-label').value.trim();
      const amount = Math.round(parseFloat(form.querySelector('.ff-amount').value) * 100);
      const day = parseInt(form.querySelector('.ff-day').value, 10);
      if (!label || !Number.isFinite(amount) || amount <= 0) return;
      await put('recurring', {
        id: `fixed-${newId()}`,
        label,
        amount,
        dayOfMonth: Number.isInteger(day) && day >= 1 && day <= 31 ? day : 1,
        categoryId: form.querySelector('.ff-category').value || null,
        accountId: null,
        active: true,
        source: 'fixed',
      });
      adding = false;
      render(container);
    });
    form.querySelector('.ff-cancel').addEventListener('click', () => {
      adding = false;
      render(container);
    });
  }

  container.querySelectorAll('.fixed-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await remove('recurring', btn.dataset.id);
      render(container);
    });
  });

  container.querySelectorAll('.promote-detected').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const d = detected.find((x) => x.id === btn.dataset.id);
      await put('recurring', {
        id: `fixed-${newId()}`,
        label: d.label,
        amount: d.amount,
        dayOfMonth: d.dayOfMonth,
        categoryId: d.categoryId,
        accountId: d.accountId,
        active: true,
        source: 'fixed',
      });
      render(container);
    });
  });
}

function fixedRow(f, categories) {
  const cat = categories.find((c) => c.id === f.categoryId);
  return `
    <div class="attention-row">
      <span>${escapeHtml(f.label)}<br><span class="muted-note">${cat ? escapeHtml(cat.name) + ' · ' : ''}due around the ${ordinal(f.dayOfMonth)}</span></span>
      <span class="fixed-row-right">
        <span class="out">${formatCurrency(f.amount)}</span>
        <button type="button" class="icon-btn fixed-delete" data-id="${f.id}" aria-label="Remove">✕</button>
      </span>
    </div>
  `;
}

function fixedForm(categories) {
  return `
    <form class="totals-card" id="fixed-form">
      <label class="field">
        <span>What is it</span>
        <input type="text" class="ff-label" placeholder="e.g. House rent" required>
      </label>
      <label class="field">
        <span>Amount each month</span>
        <input type="number" class="ff-amount" inputmode="decimal" step="0.01" min="0.01" placeholder="40000" required>
      </label>
      <label class="field">
        <span>Day of month it's due</span>
        <input type="number" class="ff-day" min="1" max="31" placeholder="1">
      </label>
      <label class="field">
        <span>Category <span class="muted">(so this spend isn't counted twice)</span></span>
        <select class="ff-category">
          <option value="">None</option>
          ${categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </label>
      <button type="submit" class="btn-primary">Add</button>
      <button type="button" class="btn-tiny ff-cancel btn-block">Cancel</button>
    </form>
  `;
}

// A rough read on typical income: the average of whatever landed in the
// Income category over the last few months. Only a starting point.
function suggestIncome(transactions, categories) {
  const incomeCat = categories.find((c) => c.name.toLowerCase() === 'income');
  if (!incomeCat) return null;
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth() - 3, 1).toISOString().slice(0, 10);
  const credits = transactions.filter((t) => t.categoryId === incomeCat.id && t.direction === 'credit' && !t.isTransfer && t.date >= cutoff);
  if (credits.length === 0) return null;
  const months = new Set(credits.map((t) => t.date.slice(0, 7))).size || 1;
  return Math.round(credits.reduce((s, t) => s + t.amount, 0) / months);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}
