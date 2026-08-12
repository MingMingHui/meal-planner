/**
 * recipes.js
 * ----------------------------------------------------------------------------
 * Purpose: Loads the local recipe/ingredient database, filters it against a
 *          user's profile (diet, allergies, dislikes), builds a full day's
 *          meal plan (offline-capable, rule-based), and renders the Meal
 *          Planner + Recipe Generator views. AI generation (ai.js) is used
 *          as an enhancement layer, with the local database as a reliable
 *          offline fallback — this is what keeps the app usable without an
 *          API key or when the network/AI provider fails.
 * Inputs:  Profile object (storage.js shape), calculated targets (nutrition.js).
 * Outputs: Renders DOM into #view-planner / #view-recipes; persists the
 *          active plan via storage.js.
 * Depends on: storage.js, nutrition.js, ai.js, ui.js, data/*.json (fetched).
 * ----------------------------------------------------------------------------
 */

import Storage from './storage.js';
import { calcRecipeNutrition, calcFullProfile } from './nutrition.js';
import { generateAIRecipe, generateAIMealPlan, hasAPIKey } from './ai.js';
import { ICONS, escapeHTML, fmt, toast, openModal, closeModal, el } from './ui.js';
import { addRecipeToShoppingList } from './shopping.js';
import { shareContent } from './share.js';
import { loadAppData, getIngredientDB as _getIngredientDB, getRecipeDB as _getRecipeDB } from './data.js';
import { exportRecipePDF, exportMealPlanPDF } from './pdf.js';

export const loadRecipeData = loadAppData;
function ingredientArr() { return _getIngredientDB(); }
function recipeArr() { return _getRecipeDB(); }
export function getIngredientDB() { return _getIngredientDB(); }
export function getRecipeDB() { return _getRecipeDB(); }

const DIET_COMPAT = {
  'no-preference': () => true,
  vegetarian: (r) => r.dietTags.includes('vegetarian') || r.dietTags.includes('vegan'),
  vegan: (r) => r.dietTags.includes('vegan'),
  halal: (r) => r.dietTags.includes('halal-friendly') || (!r.allergens.includes('pork')),
  'gluten-free': (r) => r.dietTags.includes('gluten-free'),
  pescatarian: (r) => !r.ingredients.some(i => ['minced_beef', 'chicken_breast', 'chicken_thigh'].includes(i.id)),
  keto: (r) => true, // no keto-specific dataset yet; macro filtering handled by scaling
};

function textMatchesList(name, list) {
  if (!list || !list.length) return false;
  const lower = name.toLowerCase();
  return list.some(term => term && lower.includes(term.toLowerCase().trim()));
}

export function filterRecipesForProfile(profile, mealSlot) {
  const dietCheck = DIET_COMPAT[profile.dietPreference] || DIET_COMPAT['no-preference'];
  return recipeArr().filter(r => {
    if (mealSlot && !r.mealType.includes(mealSlot)) return false;
    if (!dietCheck(r)) return false;
    if (profile.allergies?.length && r.allergens.some(a => profile.allergies.includes(a))) return false;
    if (textMatchesList(r.name, profile.dislikedFoods)) return false;
    return true;
  });
}

function scoreRecipe(recipe, profile) {
  let score = 0;
  if (recipe.goalTags?.includes(profile.goal)) score += 3;
  if (textMatchesList(recipe.name, profile.favoriteFoods)) score += 4;
  if (recipe.malaysian) score += 1;
  if (profile.cookingSkill === 'beginner' && recipe.difficulty === 'Easy') score += 1;
  if (profile.cookingSkill === 'advanced' && recipe.difficulty === 'Hard') score += 1;
  score += Math.random(); // small jitter so plans vary between regenerations
  return score;
}

/** Scales a recipe's ingredient quantities so its total kcal approximates targetKcal. */
export function scaleRecipeToCalories(recipe, targetKcal) {
  const base = calcRecipeNutrition(recipe, ingredientArr());
  const baseTotalKcal = base.total.kcal || 1;
  const factor = Math.max(0.4, Math.min(2.2, targetKcal / baseTotalKcal));
  const scaled = {
    ...recipe,
    servings: 1,
    ingredients: recipe.ingredients.map(i => ({ ...i, qty: +(i.qty * factor).toFixed(1) })),
  };
  const nutrition = calcRecipeNutrition(scaled, ingredientArr());
  return { recipe: scaled, nutrition: nutrition.perServing, scaleFactor: +factor.toFixed(2) };
}

const SLOT_DISTRIBUTION = {
  3: [{ slot: 'breakfast', pct: 0.28 }, { slot: 'lunch', pct: 0.37 }, { slot: 'dinner', pct: 0.35 }],
  4: [{ slot: 'breakfast', pct: 0.25 }, { slot: 'lunch', pct: 0.32 }, { slot: 'snack', pct: 0.10 }, { slot: 'dinner', pct: 0.33 }],
  5: [{ slot: 'breakfast', pct: 0.22 }, { slot: 'snack', pct: 0.08 }, { slot: 'lunch', pct: 0.30 }, { slot: 'snack', pct: 0.10 }, { slot: 'dinner', pct: 0.30 }],
};

/** Builds a full local (offline-capable) day plan matching the calorie target. */
export function buildLocalMealPlan(profile, targets) {
  if (!recipeArr().length) {
    // Recipe database hasn't loaded (still fetching, or a network failure occurred).
    return { meals: [], generatedAt: new Date().toISOString(), source: 'local', error: 'Recipe database is not loaded yet.' };
  }
  const mealsPerDay = Math.min(5, Math.max(3, profile.mealsPerDay || 3));
  const distribution = SLOT_DISTRIBUTION[mealsPerDay] || SLOT_DISTRIBUTION[3];
  const usedIds = new Set();
  const meals = distribution.map(({ slot, pct }) => {
    let pool = filterRecipesForProfile(profile, slot).filter(r => !usedIds.has(r.id));
    if (!pool.length) pool = filterRecipesForProfile(profile, slot); // allow repeats if pool exhausted
    if (!pool.length) pool = recipeArr().filter(r => !usedIds.has(r.id)); // last resort: ignore slot
    if (!pool.length) pool = recipeArr();
    pool = [...pool].sort((a, b) => scoreRecipe(b, profile) - scoreRecipe(a, profile));
    const chosen = pool[0];
    if (!chosen) return null; // should not happen given the fallbacks above, but never crash the view
    usedIds.add(chosen.id);
    const targetKcal = Math.round(targets.calorieTarget * pct);
    const { recipe, nutrition, scaleFactor } = scaleRecipeToCalories(chosen, targetKcal);
    return { slot, recipe, nutrition, scaleFactor, sourceId: chosen.id };
  }).filter(Boolean);
  return { meals, generatedAt: new Date().toISOString(), source: 'local' };
}

function slotLabel(slot) {
  return { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' }[slot] || slot;
}

/* ============================== Rendering ============================== */

export function renderPlannerView() {
  const container = document.getElementById('view-planner');
  const profile = Storage.getProfile();
  const targets = calcFullProfile(profile);

  if (!targets) {
    container.innerHTML = emptyProfilePrompt('Complete your profile to generate a personalized meal plan.');
    return;
  }

  let plan = Storage.getMealPlan();
  if (!plan || !plan.meals?.length) {
    plan = buildLocalMealPlan(profile, targets);
    if (plan.meals.length) Storage.saveMealPlan(plan);
  }

  if (!plan.meals.length) {
    container.innerHTML = emptyProfilePrompt('The recipe database is still loading (or failed to load). Please check your connection and try reloading the page.');
    return;
  }

  const totalKcal = plan.meals.reduce((s, m) => s + m.nutrition.kcal, 0);

  container.innerHTML = `
    <div class="grid" style="margin-bottom:var(--space-5);">
      <div class="g-12 card" style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;">
        <div>
          <div class="eyebrow">Today's plan${plan.source === 'ai' ? ' · AI-generated' : ''}</div>
          <h3 style="margin:0;">${fmt(totalKcal)} kcal planned <span class="small">of ${fmt(targets.calorieTarget)} kcal target</span></h3>
        </div>
        <div style="display:flex; gap:10px; flex-wrap:wrap;">
          <button class="btn btn-ghost" id="regen-local">${ICONS.planner} Regenerate</button>
          <button class="btn btn-accent" id="regen-ai">${ICONS.sparkle} Regenerate with AI</button>
          <button class="btn btn-ghost" id="planner-pdf-btn">${ICONS.sparkle} Download PDF</button>
        </div>
      </div>
    </div>
    <div class="grid" id="meal-cards" style="grid-template-columns:repeat(auto-fill, minmax(280px, 1fr));"></div>
  `;

  const mealCards = container.querySelector('#meal-cards');
  plan.meals.forEach((m, idx) => mealCards.appendChild(buildMealCard(m, idx)));

  container.querySelector('#regen-local').addEventListener('click', () => {
    const p = buildLocalMealPlan(profile, targets);
    Storage.saveMealPlan(p);
    toast('New meal plan generated from the local recipe database.', 'success');
    renderPlannerView();
  });

  container.querySelector('#regen-ai').addEventListener('click', async (e) => {
    if (!hasAPIKey()) { toast('Add an AI provider API key in Settings first.', 'error'); return; }
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = 'Generating…';
    try {
      const aiPlan = await generateAIMealPlan(profile, targets);
      const meals = (aiPlan.meals || []).map(m => ({
        slot: m.slot || 'meal',
        recipe: {
          id: 'ai_' + Math.random().toString(36).slice(2),
          name: m.name, servings: m.servings || 1, prepTime: m.prepTime || 15, cookTime: 0,
          difficulty: m.difficulty || 'Easy', instructions: m.instructions || [],
          ingredients: [], ingredientsText: m.ingredients || [],
          healthBenefits: [], substitutions: [], malaysian: false,
        },
        nutrition: { kcal: m.kcal || 0, protein: m.protein || 0, fat: m.fat || 0, carbs: m.carbs || 0, fiber: m.fiber || 0 },
        scaleFactor: 1, sourceId: null,
      }));
      if (!meals.length) throw new Error('AI returned no meals.');
      Storage.saveMealPlan({ meals, generatedAt: new Date().toISOString(), source: 'ai' });
      toast('AI meal plan generated.', 'success');
      renderPlannerView();
    } catch (err) {
      toast(err.message || 'AI meal plan generation failed. Showing local plan instead.', 'error', 4500);
    } finally {
      btn.disabled = false; btn.innerHTML = `${ICONS.sparkle} Regenerate with AI`;
    }
  });

  container.querySelector('#planner-pdf-btn').addEventListener('click', () => exportMealPlanPDF());
}

function emptyProfilePrompt(message) {
  return `<div class="empty-state">${ICONS.empty}<p>${escapeHTML(message)}</p>
    <button class="btn btn-primary" data-nav="profile" onclick="document.querySelector('[data-nav=profile]').click()">Go to Profile</button></div>`;
}

function buildMealCard(meal, idx) {
  const { slot, recipe, nutrition } = meal;
  const card = el(`
    <div class="card meal-card">
      <div class="eyebrow">${escapeHTML(slotLabel(slot))}</div>
      <h4>${escapeHTML(recipe.name)}</h4>
      <div class="meal-meta">
        ${recipe.malaysian ? '<span>🇲🇾 Malaysian</span>' : ''}
        <span>${escapeHTML(recipe.difficulty || 'Easy')}</span>
        <span>${(recipe.prepTime || 0) + (recipe.cookTime || 0)} min</span>
        <span>Serves ${recipe.servings || 1}</span>
      </div>
      <div class="nutrient-row">
        <span><b>${fmt(nutrition.kcal)}</b> kcal</span>
        <span><b>${fmt(nutrition.protein, 1)}g</b> protein</span>
        <span><b>${fmt(nutrition.fat, 1)}g</b> fat</span>
        <span><b>${fmt(nutrition.carbs, 1)}g</b> carbs</span>
        <span><b>${fmt(nutrition.fiber, 1)}g</b> fiber</span>
      </div>
      <div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">
        <button class="btn btn-ghost btn-sm view-recipe">View recipe</button>
        <button class="btn btn-primary btn-sm add-shop">Add to shopping list</button>
      </div>
    </div>
  `);
  card.querySelector('.view-recipe').addEventListener('click', () => openRecipeModal(meal));
  card.querySelector('.add-shop').addEventListener('click', () => {
    addRecipeToShoppingList(recipe);
    toast(`Added "${recipe.name}" ingredients to your shopping list.`, 'success');
  });
  return card;
}

function openRecipeModal(meal) {
  const { recipe, nutrition } = meal;
  const ingredientTextLines = recipe.ingredients?.length
    ? recipe.ingredients.map(i => {
        const ing = ingredientArr().find(x => x.id === i.id);
        return `${fmt(i.qty)}${ing?.unit === 'pc' ? ' pc' : ing?.unit || 'g'} ${ing?.name || i.id}`;
      })
    : (recipe.ingredientsText || []);
  const ingredientLines = recipe.ingredients?.length
    ? recipe.ingredients.map(i => {
        const ing = ingredientArr().find(x => x.id === i.id);
        return `<li>${fmt(i.qty)}${ing?.unit === 'pc' ? ' pc' : ing?.unit || 'g'} ${escapeHTML(ing?.name || i.id)}</li>`;
      }).join('')
    : (recipe.ingredientsText || []).map(t => `<li>${escapeHTML(t)}</li>`).join('');

  openModal(`
    <div class="modal-head">
      <h3>${escapeHTML(recipe.name)}</h3>
      <button class="icon-btn" id="modal-close">${ICONS.close}</button>
    </div>
    <div class="recipe-detail">
      <div class="meal-meta">
        <span>${escapeHTML(recipe.difficulty || 'Easy')}</span>
        <span>Prep ${recipe.prepTime || 0}m</span>
        <span>Cook ${recipe.cookTime || 0}m</span>
        <span>Serves ${recipe.servings || 1}</span>
      </div>
      <div class="nutrient-row">
        <span><b>${fmt(nutrition.kcal)}</b> kcal</span>
        <span><b>${fmt(nutrition.protein, 1)}g</b> protein</span>
        <span><b>${fmt(nutrition.fat, 1)}g</b> fat</span>
        <span><b>${fmt(nutrition.carbs, 1)}g</b> carbs</span>
        <span><b>${fmt(nutrition.fiber, 1)}g</b> fiber</span>
      </div>
      <div>
        <h4 style="font-size:0.9rem;">Ingredients</h4>
        <ul>${ingredientLines || '<li>Not specified</li>'}</ul>
      </div>
      <div>
        <h4 style="font-size:0.9rem;">Instructions</h4>
        <ol>${(recipe.instructions || []).map(s => `<li>${escapeHTML(s)}</li>`).join('') || '<li>Not specified</li>'}</ol>
      </div>
      ${recipe.substitutions?.length ? `<div><h4 style="font-size:0.9rem;">Substitutions</h4><ul>${recipe.substitutions.map(s => `<li>${escapeHTML(typeof s === 'string' ? s : `${s.from} → ${s.to}: ${s.note}`)}</li>`).join('')}</ul></div>` : ''}
      ${recipe.healthBenefits?.length ? `<div><h4 style="font-size:0.9rem;">Health benefits</h4><ul>${recipe.healthBenefits.map(s => `<li>${escapeHTML(s)}</li>`).join('')}</ul></div>` : ''}
      <div class="divider"></div>
      <div>
        <h4 style="font-size:0.9rem;">Share this recipe</h4>
        <div class="share-row" id="recipe-share"></div>
        <button class="btn btn-ghost btn-sm" id="recipe-pdf-btn" style="margin-top:10px;">${ICONS.sparkle} Download PDF</button>
      </div>
    </div>
  `);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('recipe-pdf-btn').addEventListener('click', () => exportRecipePDF(recipe, nutrition, ingredientTextLines));
  shareContent(document.getElementById('recipe-share'), {
    title: recipe.name,
    text: `${recipe.name} — ${fmt(nutrition.kcal)} kcal, ${fmt(nutrition.protein, 1)}g protein per serving. Planned with Health Meal Planning Agent.`,
  });
}

/* ============================ Recipe Generator view ============================ */

export function renderRecipesView() {
  const container = document.getElementById('view-recipes');
  container.innerHTML = `
    <div class="grid g-12">
      <div class="card g-12" style="margin-bottom:var(--space-5);">
        <div class="card-title"><h3>${ICONS.sparkle} Generate a recipe</h3></div>
        <p class="small">Describe what you're craving, or leave it blank for a suggestion based on your profile.</p>
        <div class="chat-input-row">
          <input type="text" id="recipe-request" placeholder="e.g. a high-protein Malaysian dinner under 500 kcal" />
          <button class="btn btn-accent" id="generate-recipe-btn">${ICONS.sparkle} Generate</button>
        </div>
        <p class="small" id="recipe-gen-hint" style="margin-top:8px;"></p>
      </div>
    </div>
    <div id="generated-recipe-slot"></div>
    <div class="card" style="margin-top:var(--space-5);">
      <div class="card-title"><h3>Browse recipe database</h3></div>
      <div class="chip-group" id="recipe-browse-filters"></div>
      <div class="grid" id="recipe-browse-list" style="grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); margin-top:var(--space-4);"></div>
    </div>
  `;

  if (!hasAPIKey()) {
    container.querySelector('#recipe-gen-hint').innerHTML =
      `No AI provider key set — generation will pick a personalized match from the local recipe database instead. Add a free API key in <a href="#" id="goto-settings">Settings</a> for AI-original recipes.`;
    container.querySelector('#goto-settings').addEventListener('click', (e) => { e.preventDefault(); document.querySelector('[data-nav="settings"]').click(); });
  }

  container.querySelector('#generate-recipe-btn').addEventListener('click', () => handleGenerateRecipe(container));

  renderRecipeBrowser(container);
}

async function handleGenerateRecipe(container) {
  const profile = Storage.getProfile();
  const requestText = container.querySelector('#recipe-request').value.trim();
  const btn = container.querySelector('#generate-recipe-btn');
  const slot = container.querySelector('#generated-recipe-slot');
  btn.disabled = true; btn.textContent = 'Generating…';
  slot.innerHTML = `<div class="card"><p class="small">Thinking of something delicious…</p></div>`;

  try {
    let cardHTML;
    if (hasAPIKey()) {
      const r = await generateAIRecipe(profile, requestText);
      const log = Storage.getRecipeLog();
      log.push({ ...r, generatedAt: new Date().toISOString() });
      Storage.saveRecipeLog(log);
      cardHTML = renderAIRecipeCard(r);
    } else {
      const pool = filterRecipesForProfile(profile, null);
      const matches = requestText
        ? pool.filter(r => r.name.toLowerCase().includes(requestText.toLowerCase())).length ? pool.filter(r => r.name.toLowerCase().includes(requestText.toLowerCase())) : pool
        : pool;
      const pick = matches[Math.floor(Math.random() * matches.length)] || recipeArr()[0];
      const nutrition = calcRecipeNutrition(pick, ingredientArr()).perServing;
      cardHTML = renderLocalRecipeCard(pick, nutrition);
    }
    slot.innerHTML = cardHTML;
    wireGeneratedRecipeCard(slot);
  } catch (err) {
    slot.innerHTML = `<div class="card"><p style="color:var(--danger);">${escapeHTML(err.message || 'Recipe generation failed.')}</p></div>`;
  } finally {
    btn.disabled = false; btn.innerHTML = `${ICONS.sparkle} Generate`;
  }
}

function renderAIRecipeCard(r) {
  const n = r.nutritionPerServing || {};
  return `
    <div class="card">
      <div class="card-title">
        <div><div class="eyebrow">${escapeHTML(r.cuisine || 'AI recipe')} · ${escapeHTML(r.mealType || '')}</div><h3>${escapeHTML(r.name || 'Untitled recipe')}</h3></div>
        <span class="badge orange">AI-generated</span>
      </div>
      <div class="meal-meta">
        <span>${escapeHTML(r.difficulty || 'Easy')}</span><span>Prep ${r.prepTime || 0}m</span><span>Cook ${r.cookTime || 0}m</span><span>Serves ${r.servings || 1}</span>
        ${r.estimatedCostMYR ? `<span>~RM${fmt(r.estimatedCostMYR, 2)}</span>` : ''}
      </div>
      <div class="nutrient-row">
        <span><b>${fmt(n.kcal)}</b> kcal</span><span><b>${fmt(n.protein, 1)}g</b> protein</span>
        <span><b>${fmt(n.fat, 1)}g</b> fat</span><span><b>${fmt(n.carbs, 1)}g</b> carbs</span><span><b>${fmt(n.fiber, 1)}g</b> fiber</span>
      </div>
      <div class="divider"></div>
      <h4 style="font-size:0.9rem;">Ingredients</h4>
      <ul>${(r.ingredients || []).map(i => `<li>${escapeHTML(i.amount || '')} ${escapeHTML(i.item || '')}</li>`).join('')}</ul>
      <h4 style="font-size:0.9rem;">Instructions</h4>
      <ol>${(r.instructions || []).map(s => `<li>${escapeHTML(s)}</li>`).join('')}</ol>
      ${r.substitutions?.length ? `<h4 style="font-size:0.9rem;">Substitutions</h4><ul>${r.substitutions.map(s => `<li>${escapeHTML(s)}</li>`).join('')}</ul>` : ''}
      ${r.healthBenefits?.length ? `<h4 style="font-size:0.9rem;">Health benefits</h4><ul>${r.healthBenefits.map(s => `<li>${escapeHTML(s)}</li>`).join('')}</ul>` : ''}
      <div class="divider"></div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <div class="share-row" id="ai-recipe-share"></div>
        <button class="btn btn-ghost btn-sm" id="ai-recipe-pdf-btn">${ICONS.sparkle} Download PDF</button>
      </div>
    </div>
  `;
}

function renderLocalRecipeCard(recipe, nutrition) {
  return `
    <div class="card" data-recipe-id="${escapeHTML(recipe.id)}">
      <div class="card-title">
        <div><div class="eyebrow">${recipe.malaysian ? '🇲🇾 Malaysian' : 'From our database'}</div><h3>${escapeHTML(recipe.name)}</h3></div>
      </div>
      <div class="meal-meta"><span>${escapeHTML(recipe.difficulty)}</span><span>Prep ${recipe.prepTime}m</span><span>Cook ${recipe.cookTime}m</span><span>Serves ${recipe.servings}</span></div>
      <div class="nutrient-row">
        <span><b>${fmt(nutrition.kcal)}</b> kcal</span><span><b>${fmt(nutrition.protein, 1)}g</b> protein</span>
        <span><b>${fmt(nutrition.fat, 1)}g</b> fat</span><span><b>${fmt(nutrition.carbs, 1)}g</b> carbs</span><span><b>${fmt(nutrition.fiber, 1)}g</b> fiber</span>
      </div>
      <div class="divider"></div>
      <h4 style="font-size:0.9rem;">Instructions</h4>
      <ol>${recipe.instructions.map(s => `<li>${escapeHTML(s)}</li>`).join('')}</ol>
      ${recipe.healthBenefits?.length ? `<h4 style="font-size:0.9rem;">Health benefits</h4><ul>${recipe.healthBenefits.map(s => `<li>${escapeHTML(s)}</li>`).join('')}</ul>` : ''}
      <div class="divider"></div>
      <button class="btn btn-primary btn-sm" id="local-add-shop">Add to shopping list</button>
      <button class="btn btn-ghost btn-sm" id="ai-recipe-pdf-btn">${ICONS.sparkle} Download PDF</button>
      <div class="share-row" id="ai-recipe-share" style="margin-top:10px;"></div>
    </div>
  `;
}

function wireGeneratedRecipeCard(slot) {
  const addBtn = slot.querySelector('#local-add-shop');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      const id = slot.querySelector('[data-recipe-id]')?.dataset.recipeId;
      const recipe = recipeArr().find(r => r.id === id);
      if (recipe) { addRecipeToShoppingList(recipe); toast('Added to shopping list.', 'success'); }
    });
  }
  const pdfBtn = slot.querySelector('#ai-recipe-pdf-btn');
  if (pdfBtn) {
    pdfBtn.addEventListener('click', () => {
      const card = slot.querySelector('.card');
      const name = slot.querySelector('h3')?.textContent || 'Recipe';
      const id = card?.dataset.recipeId;
      if (id) {
        // Local database recipe — recompute structured nutrition + ingredients.
        const recipe = recipeArr().find(r => r.id === id);
        const nutrition = calcRecipeNutrition(recipe, ingredientArr()).perServing;
        const lines = recipe.ingredients.map(i => {
          const ing = ingredientArr().find(x => x.id === i.id);
          return `${fmt(i.qty)}${ing?.unit === 'pc' ? ' pc' : ing?.unit || 'g'} ${ing?.name || i.id}`;
        });
        exportRecipePDF(recipe, nutrition, lines);
      } else {
        // AI-generated recipe — pull the structured data back out of the last recipe log entry.
        const log = Storage.getRecipeLog();
        const last = log[log.length - 1];
        if (!last) { toast('Could not find this recipe to export.', 'error'); return; }
        const nutrition = last.nutritionPerServing || {};
        const lines = (last.ingredients || []).map(i => `${i.amount || ''} ${i.item || ''}`.trim());
        exportRecipePDF({ name: last.name, instructions: last.instructions }, nutrition, lines);
      }
    });
  }
  const shareSlot = slot.querySelector('#ai-recipe-share');
  if (shareSlot) {
    const title = slot.querySelector('h3')?.textContent || 'Recipe';
    shareContent(shareSlot, { title, text: `Check out this recipe: ${title} — from Health Meal Planning Agent.` });
  }
}

function renderRecipeBrowser(container) {
  const filters = ['All', 'Malaysian', 'Breakfast', 'Lunch', 'Dinner', 'Snack', 'Vegetarian'];
  const filterBar = container.querySelector('#recipe-browse-filters');
  filterBar.innerHTML = filters.map((f, i) => `<button class="chip ${i === 0 ? 'selected' : ''}" data-filter="${f}">${f}</button>`).join('');
  const listEl = container.querySelector('#recipe-browse-list');

  function draw(filter) {
    let list = recipeArr();
    if (filter === 'Malaysian') list = list.filter(r => r.malaysian);
    else if (['Breakfast', 'Lunch', 'Dinner', 'Snack'].includes(filter)) list = list.filter(r => r.mealType.includes(filter.toLowerCase()));
    else if (filter === 'Vegetarian') list = list.filter(r => r.dietTags.includes('vegetarian') || r.dietTags.includes('vegan'));
    listEl.innerHTML = list.slice(0, 12).map(r => {
      const n = calcRecipeNutrition(r, ingredientArr()).perServing;
      return `<div class="card meal-card" data-id="${escapeHTML(r.id)}">
        <div class="eyebrow">${r.malaysian ? '🇲🇾 Malaysian' : 'International'}</div>
        <h4>${escapeHTML(r.name)}</h4>
        <div class="nutrient-row"><span><b>${fmt(n.kcal)}</b> kcal</span><span><b>${fmt(n.protein, 1)}g</b> protein</span></div>
        <button class="btn btn-ghost btn-sm browse-view">View recipe</button>
      </div>`;
    }).join('') || '<p class="small">No recipes match this filter yet.</p>';

    listEl.querySelectorAll('.browse-view').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.closest('[data-id]').dataset.id;
        const recipe = recipeArr().find(r => r.id === id);
        const nutrition = calcRecipeNutrition(recipe, ingredientArr()).perServing;
        openRecipeModal({ slot: recipe.mealType[0], recipe, nutrition });
      });
    });
  }

  filterBar.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      filterBar.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
      draw(chip.dataset.filter);
    });
  });

  draw('All');
}
