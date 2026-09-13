import { getAll, put, remove, newId, getSetting, setSetting } from '../db.js';
import { formatCurrency, formatSignedCurrency, ordinal } from '../format.js';
import { detectRecurring } from '../recurring.js';
import { categoryStyle } from '../category-style.js';
import { getBudgets, setBudget, budgetStatus, spendByCategory, monthStartISO } from '../budgets.js';
import { FREQUENCIES, DEFAULT_FREQUENCY, monthlyAmountOf, frequencyOf, frequencyShort, hasDueDate, toMonthly, toYearly } from '../frequency.js';

let adding = false;
let addingBudget = false;

// Fixed commitments live in the `recurring` store alongside auto-detected
// bills; `source` tells them apart so detection never clobbers what you
// entered by hand.
const isFixed = (r) => r.source === 'fixed';

export async function render(container) {
  const [categories, recurring, transactions, income, budgets] = await Promise.all([
    getAll('categories'),
    getAll('recurring'),
    getAll('transactions'),
    getSetting('monthlyIncome', null),
    getBudgets(),
  ]);

  const fixed = recurring.filter((r) => isFixed(r) && r.active !== false);
  // Each commitment is stored the way you entered it ("₹120 a day"); what the
  // budget needs is its monthly equivalent.
  const fixedTotal = fixed.reduce((s, r) => s + monthlyAmountOf(r), 0);
  const fixedCategoryIds = new Set(fixed.map((r) => r.categoryId).filter(Boolean));

  const now = new Date();
  const monthStart = monthStartISO(now);
  // Spending on a category that a fixed commitment already covers would be
  // counted twice - once in the commitment, once here.
  const spentMap = spendByCategory(transactions, monthStart);
  let variableSpent = 0;
  for (const [categoryId, amount] of spentMap) {
    if (fixedCategoryIds.has(categoryId)) continue;
    variableSpent += amount;
  }

  const suggestedIncome = suggestIncome(transactions, categories);
  const incomeValue = income != null ? income : suggestedIncome;
  const disposable = incomeValue != null ? incomeValue - fixedTotal : null;
  const left = disposable != null ? disposable - variableSpent : null;

  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft = Math.max(1, daysInMonth - now.getDate() + 1);
  const perDay = left != null ? Math.floor(left / daysLeft) : null;
  const usedPct = disposable > 0 ? Math.min(100, Math.round((variableSpent / disposable) * 100)) : 0;

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

  const budgetRows = budgetStatus(budgets, categories, transactions, monthStart);
  const budgetable = categories.filter((c) => !budgets[c.id] && !/income|transfer/i.test(c.name));

  container.innerHTML = `
    ${
      left != null
        ? `<div class="hero">
            <p class="hero-label">Left to spend</p>
            <p class="hero-amount ${left < 0 ? 'negative' : ''}">${formatSignedCurrency(left)}</p>
            <div class="hero-meter"><div class="hero-meter-fill ${left < 0 ? 'over' : ''}" style="width:${usedPct}%"></div></div>
            <p class="hero-sub">${
              left < 0
                ? `Over by ${formatCurrency(Math.abs(left))} with ${daysLeft} day${daysLeft === 1 ? '' : 's'} to go.`
                : `About ${formatCurrency(perDay)} a day for the remaining ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`
            }</p>
            <div class="hero-split">
              <div class="hero-stat"><span class="stat-label">Free each month</span><span class="stat-value">${formatCurrency(disposable)}</span></div>
              <div class="hero-stat"><span class="stat-label">Spent so far</span><span class="stat-value out">${formatCurrency(variableSpent)}</span></div>
            </div>
          </div>`
        : `<p class="import-intro">Put in what you earn and what's already committed each month, and this works out what's genuinely free to spend.</p>`
    }

    <h3>Income and commitments</h3>
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

    <h3>Fixed monthly commitments</h3>
    <p class="group-subtitle">Rent, EMIs, subscriptions - anything you owe every month regardless of how careful you are.</p>
    ${fixed.length ? `<div class="totals-card">${fixed.map((f) => fixedRow(f, categories)).join('')}</div>` : '<p class="empty">Nothing added yet.</p>'}
    ${adding ? fixedForm(categories) : '<button type="button" id="plan-add-btn" class="btn-secondary btn-block">Add a fixed expense</button>'}

    <h3>Budgets</h3>
    <p class="group-subtitle">A monthly ceiling for the categories you want to keep an eye on. You'll get a nudge on the Summary before you blow through one.</p>
    ${budgetRows.length ? budgetRows.map((b) => budgetCard(b)).join('') : '<p class="empty">No budgets set.</p>'}
    ${
      addingBudget
        ? budgetForm(budgetable)
        : budgetable.length
          ? '<button type="button" id="budget-add-btn" class="btn-secondary btn-block">Set a budget</button>'
          : ''
    }

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
    // Show what the entered figure works out to per month as it's typed - the
    // whole point of asking for a frequency is that you see the real cost.
    const amountEl = form.querySelector('.ff-amount');
    const freqEl = form.querySelector('.ff-frequency');
    const previewEl = form.querySelector('#ff-preview');
    const dayField = form.querySelector('.ff-day-field');

    const updatePreview = () => {
      const raw = parseFloat(amountEl.value);
      const freq = freqEl.value;
      dayField.hidden = !hasDueDate(freq);
      if (!Number.isFinite(raw) || raw <= 0 || freq === 'monthly') {
        previewEl.hidden = true;
        return;
      }
      const minor = Math.round(raw * 100);
      const monthly = toMonthly(minor, freq);
      const yearly = toYearly(minor, freq);
      previewEl.hidden = false;
      previewEl.innerHTML = `That's <strong>${formatCurrency(monthly)} a month</strong> — ${formatCurrency(yearly)} a year.`;
    };
    amountEl.addEventListener('input', updatePreview);
    freqEl.addEventListener('change', updatePreview);
    updatePreview();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const label = form.querySelector('.ff-label').value.trim();
      const amount = Math.round(parseFloat(amountEl.value) * 100);
      const day = parseInt(form.querySelector('.ff-day').value, 10);
      if (!label || !Number.isFinite(amount) || amount <= 0) return;
      await put('recurring', {
        id: `fixed-${newId()}`,
        label,
        amount,
        frequency: freqEl.value,
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

  const budgetAddBtn = container.querySelector('#budget-add-btn');
  if (budgetAddBtn) {
    budgetAddBtn.addEventListener('click', () => {
      addingBudget = true;
      render(container);
    });
  }

  const budgetFormEl = container.querySelector('#budget-form');
  if (budgetFormEl) {
    budgetFormEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      const categoryId = budgetFormEl.querySelector('.bf-category').value;
      const amount = Math.round(parseFloat(budgetFormEl.querySelector('.bf-amount').value) * 100);
      if (!categoryId || !Number.isFinite(amount) || amount <= 0) return;
      await setBudget(categoryId, amount);
      addingBudget = false;
      render(container);
    });
    budgetFormEl.querySelector('.bf-cancel').addEventListener('click', () => {
      addingBudget = false;
      render(container);
    });
  }

  container.querySelectorAll('.budget-remove').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await setBudget(btn.dataset.id, null);
      render(container);
    });
  });

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
        frequency: 'monthly',
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

function budgetCard(b) {
  const { icon, color } = categoryStyle(b.name);
  const width = Math.min(100, Math.round(b.pct * 100));
  return `
    <div class="budget-card" style="--chip-color:${color}">
      <div class="budget-head">
        <span class="budget-name"><span class="cat-chip" style="--chip-color:${color}">${icon}</span>${escapeHtml(b.name)}</span>
        <span class="budget-nums">${formatCurrency(b.spent)} <span class="muted">/ ${formatCurrency(b.limit)}</span></span>
      </div>
      <div class="budget-meter"><div class="budget-fill ${b.state === 'ok' ? '' : b.state}" style="width:${width}%"></div></div>
      <div class="budget-head">
        <span class="budget-note">${
          b.state === 'over'
            ? `Over by ${formatCurrency(-b.left)}`
            : `${formatCurrency(b.left)} left this month`
        }</span>
        <button type="button" class="icon-btn budget-remove" data-id="${b.categoryId}">Remove</button>
      </div>
    </div>
  `;
}

function budgetForm(categories) {
  return `
    <form class="totals-card" id="budget-form">
      <label class="field">
        <span>Category</span>
        <select class="bf-category" required>
          ${categories.map((c) => `<option value="${c.id}">${categoryStyle(c.name).icon} ${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </label>
      <label class="field">
        <span>Monthly limit</span>
        <input type="number" class="bf-amount" inputmode="decimal" step="0.01" min="0.01" placeholder="8000" required>
      </label>
      <button type="submit" class="btn-primary">Set budget</button>
      <button type="button" class="btn-tiny bf-cancel btn-block" style="margin-top:10px">Cancel</button>
    </form>
  `;
}

function fixedRow(f, categories) {
  const cat = categories.find((c) => c.id === f.categoryId);
  const { icon, color } = categoryStyle(cat?.name || f.label);
  const freq = frequencyOf(f);
  const monthly = monthlyAmountOf(f);
  const isMonthly = freq === 'monthly';

  // For anything that isn't already monthly, show both figures: what you
  // actually pay, and what it costs you per month. The second number is the
  // one people never work out for themselves.
  const detail = isMonthly
    ? `${cat ? escapeHtml(cat.name) + ' · ' : ''}due around the ${ordinal(f.dayOfMonth)}`
    : `${formatCurrency(f.amount)} ${frequencyShort(freq)}${hasDueDate(freq) ? ` · around the ${ordinal(f.dayOfMonth)}` : ''}${cat ? ` · ${escapeHtml(cat.name)}` : ''}`;

  return `
    <div class="attention-row">
      <span class="breakdown-label">
        <span class="cat-chip" style="--chip-color:${color}">${icon}</span>
        <span>${escapeHtml(f.label)}<br><span class="muted-note">${detail}</span></span>
      </span>
      <span class="fixed-row-right">
        <span class="out">${formatCurrency(monthly)}${isMonthly ? '' : '<span class="muted freq-per-month">/mo</span>'}</span>
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
        <input type="text" class="ff-label" placeholder="e.g. House rent, or morning chai" required>
      </label>
      <label class="field">
        <span>Amount each time</span>
        <input type="number" class="ff-amount" inputmode="decimal" step="0.01" min="0.01" placeholder="40000" required>
      </label>
      <label class="field">
        <span>How often</span>
        <select class="ff-frequency">
          ${Object.entries(FREQUENCIES)
            .map(([key, f]) => `<option value="${key}" ${key === DEFAULT_FREQUENCY ? 'selected' : ''}>${f.label}</option>`)
            .join('')}
        </select>
      </label>
      <p class="freq-preview" id="ff-preview" hidden></p>
      <label class="field ff-day-field">
        <span>Day of month it's due</span>
        <input type="number" class="ff-day" min="1" max="31" placeholder="1">
      </label>
      <label class="field">
        <span>Category <span class="muted">(so this spend isn't counted twice)</span></span>
        <select class="ff-category">
          <option value="">None</option>
          ${categories.map((c) => `<option value="${c.id}">${categoryStyle(c.name).icon} ${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </label>
      <button type="submit" class="btn-primary">Add</button>
      <button type="button" class="btn-tiny ff-cancel btn-block" style="margin-top:10px">Cancel</button>
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
