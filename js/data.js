/**
 * data.js
 * ----------------------------------------------------------------------------
 * Purpose: Fetches and caches the static JSON databases (ingredients,
 *          recipes) exactly once, so recipes.js, shopping.js and progress.js
 *          can all share the same in-memory copies without circular imports
 *          or duplicate network requests.
 * Inputs:  none (fetches ./data/*.json relative to index.html).
 * Outputs: getIngredientDB() / getRecipeDB() return arrays once loaded.
 * Depends on: ui.js (toast for load failures).
 * ----------------------------------------------------------------------------
 */

import { toast } from './ui.js';

let ingredientDB = [];
let recipeDB = [];
let loaded = false;
let loadingPromise = null;

export function loadAppData() {
  if (loaded) return Promise.resolve();
  if (loadingPromise) return loadingPromise;
  loadingPromise = Promise.all([
    fetch('./data/ingredients.json').then(r => r.json()),
    fetch('./data/recipes.json').then(r => r.json()),
  ]).then(([ingJson, recJson]) => {
    ingredientDB = ingJson.items;
    recipeDB = recJson.recipes;
    loaded = true;
  }).catch(err => {
    console.error('Failed to load app data', err);
    toast('Could not load the recipe database. Check your connection and reload.', 'error', 5000);
  });
  return loadingPromise;
}

export function getIngredientDB() { return ingredientDB; }
export function getRecipeDB() { return recipeDB; }
export function isDataLoaded() { return loaded; }
