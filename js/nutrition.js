/**
 * nutrition.js
 * ----------------------------------------------------------------------------
 * Purpose: All scientific nutrition math lives here — BMR, TDEE, calorie
 *          targets, macro splits, water needs, BMI, and recipe nutrition
 *          aggregation from the ingredient database.
 * Inputs:  Profile fields (weight/height/age/gender/activity/goal), and
 *          recipe + ingredient-DB objects.
 * Outputs: Plain numbers/objects consumed by calorie.js (UI) and recipes.js.
 * Depends on: nothing external (pure functions).
 * ----------------------------------------------------------------------------
 */

/** Activity multipliers (standard TDEE activity-factor table). */
export const ACTIVITY_FACTORS = {
  sedentary:   { label: 'Sedentary (little/no exercise)',        factor: 1.2 },
  light:       { label: 'Lightly active (1-3 days/week)',        factor: 1.375 },
  moderate:    { label: 'Moderately active (3-5 days/week)',     factor: 1.55 },
  active:      { label: 'Very active (6-7 days/week)',           factor: 1.725 },
  athlete:     { label: 'Extra active (physical job / 2x/day)',  factor: 1.9 },
};

export const GOAL_ADJUSTMENTS = {
  lose_weight: { label: 'Lose weight', deltaPct: -0.20, note: 'A 20% deficit, a moderate and sustainable pace of fat loss.' },
  maintain:    { label: 'Maintain weight', deltaPct: 0, note: 'Calories set to match your TDEE.' },
  gain_muscle: { label: 'Gain muscle', deltaPct: 0.12, note: 'A 12% surplus to support lean mass gain while limiting fat gain.' },
  gain_weight: { label: 'Gain weight', deltaPct: 0.20, note: 'A 20% surplus for faster weight gain.' },
};

/**
 * Mifflin-St Jeor Equation — the most widely validated BMR formula for
 * general populations (more accurate than Harris-Benedict in most studies).
 *   Men:   BMR = 10W + 6.25H - 5A + 5
 *   Women: BMR = 10W + 6.25H - 5A - 161
 * @param {number} weightKg
 * @param {number} heightCm
 * @param {number} age
 * @param {'male'|'female'|'other'} gender
 */
export function calcBMR(weightKg, heightCm, age, gender) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  if (gender === 'male') return Math.round(base + 5);
  if (gender === 'female') return Math.round(base - 161);
  // 'other' / unspecified: average of the male/female offsets, a common practical approach
  return Math.round(base - 78);
}

/** TDEE = BMR × activity factor. */
export function calcTDEE(bmr, activityLevel) {
  const factor = (ACTIVITY_FACTORS[activityLevel] || ACTIVITY_FACTORS.moderate).factor;
  return Math.round(bmr * factor);
}

/** Applies the goal's %-adjustment to TDEE to get a daily calorie target. */
export function calcCalorieTarget(tdee, goal) {
  const adj = GOAL_ADJUSTMENTS[goal] || GOAL_ADJUSTMENTS.maintain;
  return Math.round(tdee * (1 + adj.deltaPct));
}

/**
 * Macro targets in grams, derived from the calorie target.
 * Protein: 1.6-2.2 g/kg body weight depending on goal (higher for muscle gain /
 *          fat loss to preserve lean mass), calculated then converted to % check.
 * Fat: 25% of total calories (within the generally recommended 20-35% range).
 * Carbs: remainder of calories after protein + fat.
 * Fiber: 14g per 1000 kcal (Institute of Medicine guideline).
 */
export function calcMacros(calorieTarget, weightKg, goal) {
  const proteinPerKg = goal === 'gain_muscle' ? 2.0 : goal === 'lose_weight' ? 2.0 : 1.6;
  let proteinG = Math.round(proteinPerKg * weightKg);
  let proteinKcal = proteinG * 4;

  const fatKcal = Math.round(calorieTarget * 0.25);
  let fatG = Math.round(fatKcal / 9);

  let carbKcal = calorieTarget - proteinKcal - fatKcal;
  if (carbKcal < 0) { // guard for very low calorie targets / high body weight
    carbKcal = Math.round(calorieTarget * 0.35);
    proteinKcal = calorieTarget - carbKcal - fatKcal;
    proteinG = Math.max(0, Math.round(proteinKcal / 4));
  }
  const carbG = Math.max(0, Math.round(carbKcal / 4));
  const fiberG = Math.round((calorieTarget / 1000) * 14);

  return { proteinG, fatG, carbG, fiberG, proteinKcal, fatKcal, carbKcal: carbG * 4 };
}

/**
 * Daily water target (mL). Uses 33 mL per kg body weight — a commonly cited
 * baseline — plus 350 mL extra for active/very-active/athlete users.
 */
export function calcWaterTarget(weightKg, activityLevel) {
  let mL = Math.round(weightKg * 33);
  if (['active', 'athlete'].includes(activityLevel)) mL += 500;
  else if (activityLevel === 'moderate') mL += 250;
  return mL;
}

/** BMI = weight(kg) / height(m)^2 */
export function calcBMI(weightKg, heightCm) {
  const heightM = heightCm / 100;
  if (!heightM) return null;
  return +(weightKg / (heightM * heightM)).toFixed(1);
}

export function bmiCategory(bmi) {
  if (bmi == null || isNaN(bmi)) return { label: '—', tone: 'neutral' };
  if (bmi < 18.5) return { label: 'Underweight', tone: 'warn' };
  if (bmi < 25) return { label: 'Healthy range', tone: 'good' };
  if (bmi < 30) return { label: 'Overweight', tone: 'warn' };
  return { label: 'Obese range', tone: 'bad' };
}

/**
 * Runs the full calculation pipeline from a profile object.
 * @param {object} profile - Storage profile shape (weight, height, age, gender, activityLevel, goal)
 */
export function calcFullProfile(profile) {
  const { weight, height, age, gender, activityLevel, goal } = profile;
  if (!weight || !height || !age) return null;
  const bmr = calcBMR(weight, height, age, gender);
  const tdee = calcTDEE(bmr, activityLevel);
  const calorieTarget = calcCalorieTarget(tdee, goal);
  const macros = calcMacros(calorieTarget, weight, goal);
  const water = calcWaterTarget(weight, activityLevel);
  const bmi = calcBMI(weight, height);
  const bmiCat = bmiCategory(bmi);
  return { bmr, tdee, calorieTarget, macros, water, bmi, bmiCat, goalInfo: GOAL_ADJUSTMENTS[goal] || GOAL_ADJUSTMENTS.maintain };
}

/* --------------------------- Recipe nutrition math --------------------------- */

/**
 * Sums the nutrition of a recipe's ingredient list using the ingredient DB,
 * then divides by servings to get per-serving values.
 * @param {object} recipe - recipe object with .ingredients [{id, qty}] and .servings
 * @param {Array}  ingredientDB - array of ingredient objects from data/ingredients.json
 */
export function calcRecipeNutrition(recipe, ingredientDB) {
  const byId = new Map(ingredientDB.map(i => [i.id, i]));
  const totals = { kcal: 0, protein: 0, fat: 0, carbs: 0, fiber: 0, costMYR: 0 };

  for (const line of recipe.ingredients) {
    const ing = byId.get(line.id);
    if (!ing) continue;
    // per-piece ingredients (eggs, banana, apple) use qty directly as a multiplier;
    // everything else is per-100g/ml so we scale by qty/100.
    const factor = ing.perPiece ? line.qty : line.qty / 100;
    totals.kcal    += ing.kcal * factor;
    totals.protein += ing.protein * factor;
    totals.fat     += ing.fat * factor;
    totals.carbs   += ing.carbs * factor;
    totals.fiber   += ing.fiber * factor;
    totals.costMYR += ing.costPerUnit * line.qty;
  }

  const servings = recipe.servings || 1;
  return {
    perServing: {
      kcal: Math.round(totals.kcal / servings),
      protein: +(totals.protein / servings).toFixed(1),
      fat: +(totals.fat / servings).toFixed(1),
      carbs: +(totals.carbs / servings).toFixed(1),
      fiber: +(totals.fiber / servings).toFixed(1),
      costMYR: +(totals.costMYR / servings).toFixed(2),
    },
    total: {
      kcal: Math.round(totals.kcal),
      protein: +totals.protein.toFixed(1),
      fat: +totals.fat.toFixed(1),
      carbs: +totals.carbs.toFixed(1),
      fiber: +totals.fiber.toFixed(1),
      costMYR: +totals.costMYR.toFixed(2),
    },
  };
}
