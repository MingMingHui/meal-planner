/**
 * shopping.js
 * ----------------------------------------------------------------------------
 * Purpose: Builds and renders the shopping list — auto-populated from the
 *          active meal plan's recipes, grouped by category, with manual
 *          add/check/delete, export, print and share support.
 * Inputs:  Recipe objects (from recipes.js) and the persisted list in
 *          storage.js.
 * Outputs: Renders #view-shopping; mutates the stored shopping list.
 * Depends on: storage.js, data.js (ingredient categories), ui.js, share.js.
 * ----------------------------------------------------------------------------
 */

import Storage from './storage.js';
import { getIngredientDB } from './data.js';
import { ICONS, escapeHTML, fmt, toast, el } from './ui.js';
import { shareContent } from './share.js';

const CATEGORY_ORDER = ['Vegetables', 'Protein', 'Fruit', 'Dairy', 'Grains', 'Condiments', 'Frozen', 'Miscellaneous'];

/** Adds a recipe's ingredients to the persisted shopping list, merging quantities for repeated items. */
export function addRecipeToShoppingList(recipe) {
  const ingredientDB = getIngredientDB();
  const list = Storage.getShoppingList();
  const items = [...list.items];

  // AI-generated meals may only have free-text ingredient lines (no ingredient-DB ids).
  // Add those as uncategorized manual items so the list still gets populated.
  if ((!recipe.ingredients || !recipe.ingredients.length) && recipe.ingredientsText?.length) {
    recipe.ingredientsText.forEach(text => {
      items.push({
        id: `text_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        refId: null, name: text, qty: 1, unit: '', category: 'Miscellaneous', checked: false, fromRecipe: recipe.name,
      });
    });
    Storage.saveShoppingList({ items });
    return;
  }

  (recipe.ingredients || []).forEach(line => {
    const ing = ingredientDB.find(i => i.id === line.id);
    if (!ing) return;
    const existing = items.find(it => it.refId === line.id && !it.checked);
    if (existing) {
      existing.qty += line.qty;
    } else {
      items.push({
        id: `${line.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        refId: line.id,
        name: ing.name,
        qty: line.qty,
        unit: ing.unit === 'pc' ? 'pc' : ing.unit,
        category: ing.category,
        checked: false,
        fromRecipe: recipe.name,
      });
    }
  });

  Storage.saveShoppingList({ items });
}

function addManualItem(name, category) {
  const list = Storage.getShoppingList();
  const items = [...list.items, {
    id: `manual_${Date.now()}`,
    refId: null,
    name,
    qty: 1,
    unit: '',
    category: category || 'Miscellaneous',
    checked: false,
    fromRecipe: null,
  }];
  Storage.saveShoppingList({ items });
}

export function renderShoppingView() {
  const container = document.getElementById('view-shopping');
  const list = Storage.getShoppingList();

  container.innerHTML = `
    <div class="card" style="margin-bottom:var(--space-5); display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end; justify-content:space-between;">
      <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end;">
        <div class="field"><label for="new-item-name">Add item</label><input id="new-item-name" placeholder="e.g. Olive oil" /></div>
        <div class="field"><label for="new-item-cat">Category</label>
          <select id="new-item-cat">${CATEGORY_ORDER.map(c => `<option value="${c}">${c}</option>`).join('')}</select>
        </div>
        <button class="btn btn-primary" id="add-item-btn">${ICONS.shopping} Add</button>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn btn-ghost btn-sm" id="export-json-btn">Export JSON</button>
        <button class="btn btn-ghost btn-sm" id="export-text-btn">Export text</button>
        <button class="btn btn-ghost btn-sm" id="print-btn">Print</button>
        <button class="btn btn-danger btn-sm" id="clear-checked-btn">Clear checked</button>
      </div>
    </div>
    <div class="card" style="margin-bottom:var(--space-5);">
      <div class="card-title"><h3>Share this list</h3></div>
      <div class="share-row" id="shopping-share"></div>
    </div>
    <div id="shopping-groups"></div>
  `;

  container.querySelector('#add-item-btn').addEventListener('click', () => {
    const nameInput = container.querySelector('#new-item-name');
    const catSelect = container.querySelector('#new-item-cat');
    const name = nameInput.value.trim();
    if (!name) { toast('Enter an item name first.', 'error'); return; }
    addManualItem(name, catSelect.value);
    nameInput.value = '';
    renderShoppingView();
  });

  container.querySelector('#export-json-btn').addEventListener('click', () => downloadFile('shopping-list.json', JSON.stringify(Storage.getShoppingList(), null, 2), 'application/json'));
  container.querySelector('#export-text-btn').addEventListener('click', () => downloadFile('shopping-list.txt', buildTextList(Storage.getShoppingList()), 'text/plain'));
  container.querySelector('#print-btn').addEventListener('click', () => printList(Storage.getShoppingList()));
  container.querySelector('#clear-checked-btn').addEventListener('click', () => {
    const current = Storage.getShoppingList();
    Storage.saveShoppingList({ items: current.items.filter(i => !i.checked) });
    toast('Checked items cleared.', 'success');
    renderShoppingView();
  });

  shareContent(container.querySelector('#shopping-share'), {
    title: 'My shopping list',
    text: buildTextList(list),
  });

  renderGroups(container, Storage.getShoppingList());
}

function renderGroups(container, list) {
  const groupsEl = container.querySelector('#shopping-groups');
  if (!list.items.length) {
    groupsEl.innerHTML = `<div class="empty-state">${ICONS.empty}<p>Your shopping list is empty. Add meals from the Meal Planner or an item above.</p></div>`;
    return;
  }

  const byCategory = {};
  list.items.forEach(item => {
    const cat = CATEGORY_ORDER.includes(item.category) ? item.category : 'Miscellaneous';
    (byCategory[cat] = byCategory[cat] || []).push(item);
  });

  groupsEl.innerHTML = CATEGORY_ORDER.filter(c => byCategory[c]?.length).map(cat => `
    <div class="card shop-group">
      <h4>${escapeHTML(cat)}</h4>
      ${byCategory[cat].map(item => `
        <div class="shop-item ${item.checked ? 'checked' : ''}" data-id="${escapeHTML(item.id)}">
          <input type="checkbox" ${item.checked ? 'checked' : ''} aria-label="Mark ${escapeHTML(item.name)} as bought" />
          <label>${escapeHTML(item.name)}${item.fromRecipe ? `<span class="small"> · for ${escapeHTML(item.fromRecipe)}</span>` : ''}</label>
          <span class="qty">${item.unit ? `${fmt(item.qty)} ${escapeHTML(item.unit)}` : ''}</span>
          <button aria-label="Delete ${escapeHTML(item.name)}">${ICONS.trash}</button>
        </div>
      `).join('')}
    </div>
  `).join('');

  groupsEl.querySelectorAll('.shop-item').forEach(row => {
    const id = row.dataset.id;
    row.querySelector('input[type=checkbox]').addEventListener('change', (e) => {
      const current = Storage.getShoppingList();
      const item = current.items.find(i => i.id === id);
      if (item) item.checked = e.target.checked;
      Storage.saveShoppingList(current);
      row.classList.toggle('checked', e.target.checked);
    });
    row.querySelector('button').addEventListener('click', () => {
      const current = Storage.getShoppingList();
      Storage.saveShoppingList({ items: current.items.filter(i => i.id !== id) });
      row.remove();
    });
  });
}

function buildTextList(list) {
  const byCategory = {};
  list.items.forEach(item => {
    const cat = CATEGORY_ORDER.includes(item.category) ? item.category : 'Miscellaneous';
    (byCategory[cat] = byCategory[cat] || []).push(item);
  });
  let out = 'Shopping List — Health Meal Planning Agent\n\n';
  CATEGORY_ORDER.filter(c => byCategory[c]?.length).forEach(cat => {
    out += `${cat}\n`;
    byCategory[cat].forEach(i => { out += `  [${i.checked ? 'x' : ' '}] ${i.name}${i.unit ? ` — ${i.qty} ${i.unit}` : ''}\n`; });
    out += '\n';
  });
  return out;
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast(`Downloaded ${filename}`, 'success');
}

function printList(list) {
  const win = window.open('', '_blank', 'width=480,height=640');
  if (!win) { toast('Please allow pop-ups to print.', 'error'); return; }
  const text = buildTextList(list).replace(/\n/g, '<br>');
  win.document.write(`<html><head><title>Shopping List</title><style>body{font-family:sans-serif; padding:24px; white-space:pre-wrap;}</style></head><body>${text}</body></html>`);
  win.document.close();
  win.focus();
  win.print();
}
