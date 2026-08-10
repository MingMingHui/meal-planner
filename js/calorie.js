/**
 * calorie.js
 * ----------------------------------------------------------------------------
 * Purpose: Renders the "Calorie Calculator" view — shows the user's BMR,
 *          TDEE, calorie target, macro split, fiber and water needs, each
 *          with a plain-language explanation of the formula used.
 * Inputs:  The saved profile (storage.js).
 * Outputs: Renders #view-calculator.
 * Depends on: storage.js, nutrition.js, ui.js.
 * ----------------------------------------------------------------------------
 */

import Storage from './storage.js';
import { calcFullProfile, ACTIVITY_FACTORS, GOAL_ADJUSTMENTS } from './nutrition.js';
import { escapeHTML, fmt } from './ui.js';

export function renderCalculatorView() {
  const container = document.getElementById('view-calculator');
  const profile = Storage.getProfile();
  const result = calcFullProfile(profile);

  if (!result) {
    container.innerHTML = `<div class="empty-state"><p>Add your weight, height and age in your Profile to see your calculations.</p>
      <button class="btn btn-primary" onclick="document.querySelector('[data-nav=profile]').click()">Go to Profile</button></div>`;
    return;
  }

  const { bmr, tdee, calorieTarget, macros, water, bmi, bmiCat, goalInfo } = result;
  const activityLabel = (ACTIVITY_FACTORS[profile.activityLevel] || ACTIVITY_FACTORS.moderate).label;

  container.innerHTML = `
    <div class="grid grid-dash">
      <div class="g-4 card stat-card"><div class="stat-label">BMR</div><div class="stat-value">${fmt(bmr)}</div><div class="small">kcal/day at rest</div></div>
      <div class="g-4 card stat-card"><div class="stat-label">TDEE</div><div class="stat-value">${fmt(tdee)}</div><div class="small">kcal/day with activity</div></div>
      <div class="g-4 card stat-card"><div class="stat-label">Calorie Target</div><div class="stat-value">${fmt(calorieTarget)}</div><div class="small">${escapeHTML(goalInfo.label)}</div></div>

      <div class="g-12 card">
        <div class="card-title"><h3>Macronutrient targets</h3></div>
        <div class="grid" style="grid-template-columns:repeat(4, 1fr); gap:16px;">
          <div class="stat-card"><div class="stat-label">Protein</div><div class="stat-value">${fmt(macros.proteinG)}g</div></div>
          <div class="stat-card"><div class="stat-label">Fat</div><div class="stat-value">${fmt(macros.fatG)}g</div></div>
          <div class="stat-card"><div class="stat-label">Carbohydrates</div><div class="stat-value">${fmt(macros.carbG)}g</div></div>
          <div class="stat-card"><div class="stat-label">Fiber</div><div class="stat-value">${fmt(macros.fiberG)}g</div></div>
        </div>
        <div class="macro-bar" style="margin-top:16px;">
          <span style="width:${pct(macros.proteinKcal, calorieTarget)}%; background:var(--primary);"></span>
          <span style="width:${pct(macros.fatKcal, calorieTarget)}%; background:var(--accent);"></span>
          <span style="width:${pct(macros.carbKcal, calorieTarget)}%; background:var(--berry);"></span>
        </div>
      </div>

      <div class="g-6 card stat-card">
        <div class="stat-label">Water Intake</div>
        <div class="stat-value">${fmt(water / 1000, 1)} L</div>
        <div class="small">≈ ${Math.round(water / 250)} cups (250ml) per day</div>
      </div>
      <div class="g-6 card stat-card">
        <div class="stat-label">BMI</div>
        <div class="stat-value">${bmi ?? '—'}</div>
        <div class="small">${escapeHTML(bmiCat.label)}</div>
      </div>

      <div class="g-12">
        <h3>How these numbers are calculated</h3>
        <div class="formula-note" style="margin-bottom:12px;">
          <b>BMR — Mifflin-St Jeor Equation</b><br>
          Men: 10 × weight(kg) + 6.25 × height(cm) − 5 × age + 5<br>
          Women: 10 × weight(kg) + 6.25 × height(cm) − 5 × age − 161<br>
          This is your Basal Metabolic Rate — the energy your body needs at complete rest.
        </div>
        <div class="formula-note" style="margin-bottom:12px;">
          <b>TDEE — Total Daily Energy Expenditure</b><br>
          TDEE = BMR × activity factor. Your activity level is set to <b>${escapeHTML(activityLabel)}</b> in your profile.
        </div>
        <div class="formula-note" style="margin-bottom:12px;">
          <b>Calorie Target</b><br>
          Your goal (<b>${escapeHTML(goalInfo.label)}</b>) applies a ${(goalInfo.deltaPct * 100).toFixed(0)}% adjustment to TDEE. ${escapeHTML(goalInfo.note)}
        </div>
        <div class="formula-note" style="margin-bottom:12px;">
          <b>Protein, Fat & Carbohydrates</b><br>
          Protein is set relative to body weight (1.6–2.0 g/kg depending on your goal) to preserve or build lean mass.
          Fat is set to 25% of total calories, within the commonly recommended 20–35% range.
          Carbohydrates fill the remaining calories.
        </div>
        <div class="formula-note" style="margin-bottom:12px;">
          <b>Fiber</b><br>
          14g of fiber per 1000 kcal consumed — the Institute of Medicine's general adequate-intake guideline.
        </div>
        <div class="formula-note">
          <b>Water</b><br>
          33ml per kg of body weight, plus extra for higher activity levels, as a practical daily hydration baseline.
        </div>
      </div>
    </div>
  `;
}

function pct(part, whole) {
  if (!whole) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}
