import { getAll, put, remove, newId } from '../db.js';

export async function render(container) {
  const categories = await getAll('categories');
  const topLevel = categories.filter((c) => !c.parentId);
  const childrenOf = (id) => categories.filter((c) => c.parentId === id);

  container.innerHTML = `
    <ul class="cat-list">
      ${topLevel.map((c) => renderCatRow(c, childrenOf(c.id))).join('')}
    </ul>
    <button type="button" id="add-cat-btn" class="btn-secondary">+ Add category</button>
  `;

  container.querySelectorAll('.cat-rename').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const cat = categories.find((c) => c.id === btn.dataset.id);
      const name = prompt('Rename category', cat.name);
      if (name && name.trim()) {
        cat.name = name.trim();
        await put('categories', cat);
        render(container);
      }
    });
  });

  container.querySelectorAll('.cat-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const [transactions, rules] = await Promise.all([getAll('transactions'), getAll('merchantRules')]);
      const affected = transactions.filter((t) => t.categoryId === id);
      const children = categories.filter((c) => c.parentId === id);

      const warning = [
        'Delete this category?',
        affected.length ? `${affected.length} transaction${affected.length === 1 ? '' : 's'} will go back to uncategorized.` : '',
        children.length ? `${children.length} sub-categor${children.length === 1 ? 'y' : 'ies'} will move up to the top level.` : '',
      ]
        .filter(Boolean)
        .join('\n');

      if (!confirm(warning)) return;

      // Clear the dangling reference everywhere, otherwise those transactions
      // read as "Uncategorized" in summaries but never show up in the
      // needs-review list, so they become invisible and unfixable.
      for (const t of affected) {
        t.categoryId = null;
        await put('transactions', t);
      }
      for (const c of children) {
        c.parentId = null;
        await put('categories', c);
      }
      for (const rule of rules.filter((r) => r.categoryId === id)) {
        await remove('merchantRules', rule.id);
      }

      await remove('categories', id);
      render(container);
    });
  });

  container.querySelector('#add-cat-btn').addEventListener('click', async () => {
    const name = prompt('Category name');
    if (!name || !name.trim()) return;
    const parentChoices = topLevel.map((c) => c.name).join(', ');
    const parentName = prompt(`Parent category (optional, leave blank for none).\nExisting: ${parentChoices}`);
    const parent = parentName ? categories.find((c) => c.name.toLowerCase() === parentName.trim().toLowerCase()) : null;
    await put('categories', { id: newId(), name: name.trim(), parentId: parent ? parent.id : null });
    render(container);
  });
}

function renderCatRow(cat, children) {
  return `
    <li class="cat-row">
      <div class="cat-row-main">
        <span class="cat-name">${escapeHtml(cat.name)}</span>
        <span class="cat-actions">
          <button type="button" class="icon-btn cat-rename" data-id="${cat.id}">Rename</button>
          <button type="button" class="icon-btn cat-delete" data-id="${cat.id}">Delete</button>
        </span>
      </div>
      ${children.length ? `<ul class="cat-children">${children.map((ch) => renderCatRow(ch, [])).join('')}</ul>` : ''}
    </li>
  `;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}
