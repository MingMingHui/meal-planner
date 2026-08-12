/**
 * pdf.js
 * ----------------------------------------------------------------------------
 * Purpose: Generates downloadable PDF reports entirely in the browser using
 *          jsPDF + jspdf-autotable (loaded via CDN in index.html — see
 *          window.jspdf.jsPDF). No backend PDF service is used or required.
 * Inputs:  Reads current profile/plan/shopping/progress from storage.js and
 *          computes nutrition via nutrition.js — callers just pick a report
 *          type and call the matching export function.
 * Outputs: Triggers a browser file download; returns nothing.
 * Depends on: storage.js, nutrition.js, ui.js (toast), CONFIG (config.js),
 *             the globally-loaded jsPDF + autoTable plugin.
 * ----------------------------------------------------------------------------
 */

import Storage from './storage.js';
import { calcFullProfile } from './nutrition.js';
import { toast } from './ui.js';
import CONFIG from './config.js';
import { getUserProfile } from './auth.js';

const BRAND = { primary: [47, 82, 51], accent: [224, 138, 30], ink: [28, 35, 29], muted: [110, 120, 110] };
const DISCLAIMER = 'This report is for informational and meal-planning purposes only and is not medical advice. Consult a qualified healthcare professional for medical guidance.';

function getDoc() {
  if (!window.jspdf?.jsPDF) {
    toast('PDF library failed to load — check your connection and reload the page.', 'error', 5000);
    return null;
  }
  return new window.jspdf.jsPDF({ unit: 'pt', format: 'a4' });
}

function drawHeader(doc, title) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const user = getUserProfile();
  const profile = Storage.getProfile();
  const name = user?.name || profile.name || 'Guest User';

  doc.setFillColor(...BRAND.primary);
  doc.rect(0, 0, pageWidth, 64, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(CONFIG.APP_NAME, 40, 28);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text('Your Personal AI Nutrition Assistant', 40, 44);

  doc.setTextColor(...BRAND.ink);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text(title, 40, 96);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...BRAND.muted);
  doc.text(`Prepared for: ${name}`, 40, 114);
  doc.text(`Report date: ${new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}`, 40, 128);

  return 152; // y-offset where section content should start
}

function drawSectionTitle(doc, text, y) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(...BRAND.primary);
  doc.text(text, 40, y);
  doc.setDrawColor(...BRAND.accent);
  doc.setLineWidth(1.2);
  doc.line(40, y + 4, doc.internal.pageSize.getWidth() - 40, y + 4);
  return y + 20;
}

function drawFooter(doc) {
  const pageCount = doc.internal.getNumberOfPages();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(7.5);
    doc.setTextColor(...BRAND.muted);
    const wrapped = doc.splitTextToSize(DISCLAIMER, pageWidth - 80);
    doc.text(wrapped, 40, pageHeight - 34);
    doc.text(`Page ${i} of ${pageCount}`, pageWidth - 80, pageHeight - 16);
  }
}

function ensureSpace(doc, y, needed = 100) {
  const pageHeight = doc.internal.pageSize.getHeight();
  if (y + needed > pageHeight - 50) {
    doc.addPage();
    return 50;
  }
  return y;
}

function table(doc, y, head, body, opts = {}) {
  doc.autoTable({
    startY: y,
    head: [head],
    body,
    margin: { left: 40, right: 40 },
    styles: { fontSize: 9, textColor: BRAND.ink, cellPadding: 5 },
    headStyles: { fillColor: BRAND.primary, textColor: [255, 255, 255], fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [244, 242, 235] },
    ...opts,
  });
  return doc.lastAutoTable.finalY + 20;
}

/* ------------------------------ Section builders ------------------------------ */

function addProfileSection(doc, y, profile) {
  y = ensureSpace(doc, y);
  y = drawSectionTitle(doc, 'User Profile', y);
  const rows = [
    ['Name', profile.name || getUserProfile()?.name || '—'],
    ['Age', profile.age ? `${profile.age} years` : '—'],
    ['Weight', profile.weight ? `${profile.weight} kg` : '—'],
    ['Height', profile.height ? `${profile.height} cm` : '—'],
    ['Gender', profile.gender || '—'],
    ['Activity level', profile.activityLevel || '—'],
    ['Goal', (profile.goal || '—').replace('_', ' ')],
    ['Dietary preference', profile.dietPreference || '—'],
    ['Allergies', profile.allergies?.length ? profile.allergies.join(', ') : 'None recorded'],
  ];
  return table(doc, y, ['Field', 'Value'], rows, { columnStyles: { 0: { cellWidth: 160, fontStyle: 'bold' } } });
}

function addNutritionSection(doc, y, result) {
  y = ensureSpace(doc, y);
  y = drawSectionTitle(doc, 'Nutrition Summary', y);
  const rows = [
    ['BMI', result.bmi != null ? `${result.bmi} (${result.bmiCat.label})` : '—'],
    ['BMR', `${result.bmr} kcal/day`],
    ['TDEE', `${result.tdee} kcal/day`],
    ['Daily calorie target', `${result.calorieTarget} kcal (${result.goalInfo.label})`],
    ['Protein target', `${result.macros.proteinG} g`],
    ['Carbohydrate target', `${result.macros.carbG} g`],
    ['Fat target', `${result.macros.fatG} g`],
    ['Fiber target', `${result.macros.fiberG} g`],
    ['Water target', `${(result.water / 1000).toFixed(1)} L (${Math.round(result.water / 250)} cups)`],
  ];
  return table(doc, y, ['Metric', 'Value'], rows, { columnStyles: { 0: { cellWidth: 160, fontStyle: 'bold' } } });
}

function addMealPlanSection(doc, y, plan) {
  y = ensureSpace(doc, y);
  y = drawSectionTitle(doc, 'Meal Plan', y);
  if (!plan?.meals?.length) {
    doc.setFontSize(9.5); doc.setTextColor(...BRAND.muted); doc.text('No meal plan has been generated yet.', 40, y);
    return y + 20;
  }
  const rows = plan.meals.map(m => [
    capitalize(m.slot), m.recipe.name, `${Math.round(m.nutrition.kcal)} kcal`,
    `${m.nutrition.protein.toFixed(1)}g`, `${m.nutrition.fat.toFixed(1)}g`, `${m.nutrition.carbs.toFixed(1)}g`, `${m.nutrition.fiber.toFixed(1)}g`,
  ]);
  return table(doc, y, ['Meal', 'Dish', 'Calories', 'Protein', 'Fat', 'Carbs', 'Fiber'], rows);
}

function addShoppingListSection(doc, y, list) {
  y = ensureSpace(doc, y);
  y = drawSectionTitle(doc, 'Shopping List', y);
  if (!list?.items?.length) {
    doc.setFontSize(9.5); doc.setTextColor(...BRAND.muted); doc.text('Shopping list is empty.', 40, y);
    return y + 20;
  }
  const byCategory = {};
  list.items.forEach(i => { (byCategory[i.category] = byCategory[i.category] || []).push(i); });
  const rows = Object.entries(byCategory).flatMap(([cat, items]) =>
    items.map((i, idx) => [idx === 0 ? cat : '', i.checked ? '✓' : '', i.name, i.unit ? `${i.qty} ${i.unit}` : '']));
  return table(doc, y, ['Category', 'Got it', 'Item', 'Qty'], rows, { columnStyles: { 0: { fontStyle: 'bold' } } });
}

function addProgressSection(doc, y, progress) {
  y = ensureSpace(doc, y);
  y = drawSectionTitle(doc, 'Progress', y);
  if (!progress?.weightLog?.length && !progress?.calorieLog?.length) {
    doc.setFontSize(9.5); doc.setTextColor(...BRAND.muted); doc.text('No progress has been logged yet.', 40, y);
    return y + 20;
  }
  if (progress.weightLog?.length) {
    y = table(doc, y, ['Date', 'Weight (kg)'], progress.weightLog.slice(-20).map(e => [e.date, e.weight]));
    y = ensureSpace(doc, y);
  }
  if (progress.calorieLog?.length) {
    y = table(doc, y, ['Date', 'Calories (kcal)'], progress.calorieLog.slice(-20).map(e => [e.date, e.kcal]));
  }
  return y;
}

function addRecommendationsSection(doc, y, profile, result) {
  y = ensureSpace(doc, y);
  y = drawSectionTitle(doc, 'Recommendations', y);
  const recs = buildRecommendations(profile, result);
  doc.setFontSize(9.5);
  doc.setTextColor(...BRAND.ink);
  recs.forEach(r => {
    y = ensureSpace(doc, y, 30);
    const wrapped = doc.splitTextToSize(`• ${r}`, doc.internal.pageSize.getWidth() - 80);
    doc.text(wrapped, 40, y);
    y += wrapped.length * 12 + 6;
  });
  return y;
}

function buildRecommendations(profile, result) {
  const recs = [];
  if (result.goalInfo?.note) recs.push(result.goalInfo.note);
  if (result.bmiCat?.label === 'Underweight') recs.push('Your BMI is in the underweight range — consider prioritizing calorie-dense, nutrient-rich foods and discuss this with a healthcare professional.');
  if (result.bmiCat?.label === 'Obese range') recs.push('Your BMI is in the higher range — a gradual, sustainable calorie deficit paired with regular activity is generally recommended; consider consulting a healthcare professional for a personalized plan.');
  recs.push(`Aim for at least ${result.macros.fiberG}g of fiber daily from vegetables, fruits and whole grains to support digestion and satiety.`);
  recs.push(`Spread your ${result.macros.proteinG}g protein target across your ${profile.mealsPerDay || 3} meals to support muscle maintenance and satiety.`);
  recs.push(`Stay hydrated with around ${(result.water / 1000).toFixed(1)}L of water daily, more on hot or active days.`);
  return recs;
}

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

function download(doc, filename) {
  drawFooter(doc);
  doc.save(filename);
  toast(`Downloaded ${filename}`, 'success');
}

/* ------------------------------ Public export functions ------------------------------ */

export function exportCompleteReportPDF() {
  const doc = getDoc(); if (!doc) return;
  const profile = Storage.getProfile();
  const result = calcFullProfile(profile);
  let y = drawHeader(doc, 'Complete Health & Meal Report');

  y = addProfileSection(doc, y, profile);
  if (result) {
    y = addNutritionSection(doc, y, result);
    y = addMealPlanSection(doc, y, Storage.getMealPlan());
    y = addShoppingListSection(doc, y, Storage.getShoppingList());
    y = addProgressSection(doc, y, Storage.getProgress());
    y = addRecommendationsSection(doc, y, profile, result);
  } else {
    doc.setFontSize(10); doc.setTextColor(...BRAND.muted);
    doc.text('Complete your profile (weight, height, age) in the app to include nutrition targets, meal plan and recommendations.', 40, y);
  }
  download(doc, 'health-report-complete.pdf');
}

export function exportProfilePDF() {
  const doc = getDoc(); if (!doc) return;
  const profile = Storage.getProfile();
  const result = calcFullProfile(profile);
  let y = drawHeader(doc, 'Profile Report');
  y = addProfileSection(doc, y, profile);
  if (result) y = addNutritionSection(doc, y, result);
  download(doc, 'health-report-profile.pdf');
}

export function exportMealPlanPDF() {
  const doc = getDoc(); if (!doc) return;
  let y = drawHeader(doc, 'Meal Plan Report');
  y = addMealPlanSection(doc, y, Storage.getMealPlan());
  download(doc, 'health-report-meal-plan.pdf');
}

export function exportShoppingListPDF() {
  const doc = getDoc(); if (!doc) return;
  let y = drawHeader(doc, 'Shopping List');
  y = addShoppingListSection(doc, y, Storage.getShoppingList());
  download(doc, 'health-report-shopping-list.pdf');
}

export function exportProgressPDF() {
  const doc = getDoc(); if (!doc) return;
  let y = drawHeader(doc, 'Progress Report');
  y = addProgressSection(doc, y, Storage.getProgress());
  download(doc, 'health-report-progress.pdf');
}

/** Exports a single recipe (from the meal planner, recipe generator, or database browser). */
export function exportRecipePDF(recipe, nutrition, ingredientLines = []) {
  const doc = getDoc(); if (!doc) return;
  let y = drawHeader(doc, recipe.name || 'Recipe');
  y = ensureSpace(doc, y);
  y = drawSectionTitle(doc, 'Nutrition (per serving)', y);
  y = table(doc, y, ['Calories', 'Protein', 'Fat', 'Carbs', 'Fiber'], [[
    `${Math.round(nutrition.kcal)} kcal`, `${nutrition.protein}g`, `${nutrition.fat}g`, `${nutrition.carbs}g`, `${nutrition.fiber}g`,
  ]]);

  y = ensureSpace(doc, y);
  y = drawSectionTitle(doc, 'Ingredients', y);
  const lines = ingredientLines.length ? ingredientLines : ['Not specified'];
  y = table(doc, y, ['Ingredient'], lines.map(l => [l]));

  y = ensureSpace(doc, y);
  y = drawSectionTitle(doc, 'Instructions', y);
  doc.setFontSize(9.5); doc.setTextColor(...BRAND.ink);
  (recipe.instructions?.length ? recipe.instructions : ['Not specified']).forEach((step, idx) => {
    y = ensureSpace(doc, y, 30);
    const wrapped = doc.splitTextToSize(`${idx + 1}. ${step}`, doc.internal.pageSize.getWidth() - 80);
    doc.text(wrapped, 40, y);
    y += wrapped.length * 12 + 6;
  });

  download(doc, `recipe-${(recipe.name || 'recipe').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`);
}
