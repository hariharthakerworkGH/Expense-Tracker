import { get, put, remove, getAll, getSetting, setSetting } from './db.js';
import { financialSnapshot } from './planner.js';
import { spendByCategoryForMonth, cycleAwareEnabled } from './budgets.js';
import { currentMonthKey, previousMonthKey, monthLabel } from './spending-month.js';
import { extractMerchantKey } from './merchant-rules.js';
import { monthlyAmountOf, frequencyLabel, frequencyOf } from './frequency.js';

// Optional: ask Google's Gemini a question about your own figures.
//
// This is the one feature in the app that sends anything to a third party, so
// it is off until you add a key, and it never sends raw transactions. What
// goes out is a summary - monthly totals, category totals, your budgets and
// commitments - and you can see the exact payload before you ever use it.
// The key lives in `syncMeta`, which is device-local and never synced.

const MODEL = 'gemini-2.5-flash';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const MONTHS_OF_HISTORY = 6;

export async function getApiKey() {
  const row = await get('syncMeta', 'geminiKey');
  return row ? row.value : null;
}

export async function setApiKey(value) {
  if (!value) {
    await remove('syncMeta', 'geminiKey', { tombstone: false });
    return;
  }
  await put('syncMeta', { id: 'geminiKey', value }, { stamp: false });
}

export async function includeMerchants() {
  return (await getSetting('aiIncludeMerchants', true)) !== false;
}

export async function setIncludeMerchants(value) {
  await setSetting('aiIncludeMerchants', value);
}

const rupees = (minor) => Math.round(minor / 100);

// Everything the model gets to see. Built separately from the request so the
// UI can show it to you verbatim first - "trust me" is not a privacy policy.
export async function buildContext() {
  const [snapshot, accounts, transactions, categories, withMerchants, cycleAware] = await Promise.all([
    financialSnapshot(),
    getAll('accounts'),
    getAll('transactions'),
    getAll('categories'),
    includeMerchants(),
    cycleAwareEnabled(),
  ]);

  const catName = (id) => (id === 'uncategorized' ? 'Uncategorized' : categories.find((c) => c.id === id)?.name || 'Uncategorized');

  const months = [];
  let key = currentMonthKey();
  for (let i = 0; i < MONTHS_OF_HISTORY; i++) {
    const spent = spendByCategoryForMonth(transactions, accounts, key, cycleAware);
    if (spent.size > 0) {
      const byCategory = {};
      let total = 0;
      for (const [id, amount] of spent) {
        byCategory[catName(id)] = rupees(amount);
        total += amount;
      }
      months.push({ month: monthLabel(key), totalSpent: rupees(total), byCategory });
    }
    key = previousMonthKey(key);
  }

  const context = {
    currency: 'INR - every number below is in whole rupees',
    today: new Date().toISOString().slice(0, 10),
    howMonthsAreCounted: cycleAware
      ? 'Credit card spending after each card\'s statement day counts towards the following month, matching when it is billed.'
      : 'Everything is counted by calendar date.',
    monthlyIncome: snapshot.income != null ? rupees(snapshot.income) : null,
    fixedCommitments: snapshot.fixed.map((f) => ({
      what: f.label,
      amount: rupees(f.amount),
      howOften: frequencyLabel(frequencyOf(f)),
      costPerMonth: rupees(monthlyAmountOf(f)),
    })),
    freeEachMonth: snapshot.free != null ? rupees(snapshot.free) : null,
    thisMonthSoFar: {
      spent: rupees(snapshot.variableSpent),
      dayOfMonth: snapshot.daysElapsed,
      daysLeft: snapshot.daysLeft,
      projectedTotal: rupees(snapshot.projectedVariable),
    },
    budgets: Object.entries(snapshot.budgets).map(([id, limit]) => ({
      category: catName(id),
      monthlyLimit: rupees(limit),
      spentThisMonth: rupees(snapshot.spentMap.get(id) || 0),
    })),
    cards: accounts
      .filter((a) => a.type === 'card')
      .map((a) => ({ card: a.label, statementDay: a.billingCycleDay, amountDue: a.statementDue != null ? rupees(a.statementDue) : null })),
    monthlyHistory: months,
    uncategorisedShare: `${Math.round(snapshot.categoryAverages.uncategorizedShare * 100)}% of spending has no category yet`,
  };

  if (withMerchants) {
    const tally = new Map();
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 3);
    const from = cutoff.toISOString().slice(0, 10);
    for (const t of transactions) {
      if (t.isTransfer || t.direction !== 'debit' || t.date < from) continue;
      const k = extractMerchantKey(t.rawDescription);
      if (!k) continue;
      if (!tally.has(k)) tally.set(k, { name: t.rawDescription.slice(0, 40), visits: 0, total: 0 });
      const m = tally.get(k);
      m.visits++;
      m.total += t.amount;
    }
    context.topMerchants = [...tally.values()]
      .sort((a, b) => b.total - a.total)
      .slice(0, 15)
      .map((m) => ({ name: m.name, visits: m.visits, totalSpent: rupees(m.total) }));
  }

  return context;
}

const PREAMBLE = `You are a plain-spoken personal finance assistant. Below is a summary of one person's real finances, in Indian rupees.

Rules:
- Only use the numbers given. Never invent a figure, and say so plainly if the data doesn't answer the question.
- Amounts in rupees with Indian grouping, e.g. ₹1,17,037.
- Be concise and specific. Three short paragraphs at most, or a short list.
- No preamble, no disclaimers about being an AI, no suggestions to consult a financial advisor.
- If a lot of spending is uncategorised, say that it limits the answer.`;

export async function askGemini(question) {
  const key = await getApiKey();
  if (!key) throw new AiError('No Gemini key saved yet. Add one in Settings.');

  const context = await buildContext();
  const prompt = `${PREAMBLE}\n\nTHE DATA:\n${JSON.stringify(context, null, 1)}\n\nTHE QUESTION:\n${question}`;

  let res;
  try {
    res = await fetch(`${ENDPOINT}/${MODEL}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 800 },
      }),
    });
  } catch {
    throw new AiError("Couldn't reach Google. Check your connection - everything else in this app works offline, but this doesn't.");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const reason = body?.error?.message || '';
    if (res.status === 400 && /API key/i.test(reason)) throw new AiError('Google rejected that API key. Check you pasted all of it.');
    if (res.status === 403) throw new AiError("That key isn't allowed to use this model. Make sure you created it in Google AI Studio.");
    if (res.status === 429) throw new AiError("You've hit the free tier's rate limit. Wait a minute and try again.");
    if (res.status === 404) throw new AiError(`The model "${MODEL}" wasn't found for this key. Google may have renamed it.`);
    throw new AiError(`Google returned error ${res.status}${reason ? `: ${reason}` : ''}`);
  }

  const body = await res.json();
  const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if (!text) {
    const blocked = body?.promptFeedback?.blockReason;
    throw new AiError(blocked ? `Google blocked that request (${blocked}).` : 'Google sent back an empty answer. Try rewording the question.');
  }
  return text.trim();
}

export async function testApiKey(key) {
  try {
    const res = await fetch(`${ENDPOINT}/${MODEL}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with the single word: ok' }] }] }),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => null);
    const reason = body?.error?.message || `error ${res.status}`;
    if (res.status === 400 && /API key/i.test(reason)) return { ok: false, reason: 'Google rejected that key. Check you copied all of it.' };
    return { ok: false, reason };
  } catch {
    return { ok: false, reason: "Couldn't reach Google. Check your connection." };
  }
}

export class AiError extends Error {}
