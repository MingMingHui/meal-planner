// @vitest-environment jsdom
/**
 * Regression tests for the shared business logic the app packages unchanged.
 * Values are computed from the formulas as they exist today; if one of these
 * fails, a business rule changed — that must be a deliberate decision.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { calcBMR, calcTDEE, calcCalorieTarget, calcMacros, calcBMI, bmiCategory, calcFullProfile } from '../../js/nutrition.js';

describe('nutrition.js (Mifflin-St Jeor, activity factors, goal adjustments)', () => {
  it('BMR', () => {
    expect(calcBMR(70, 175, 30, 'male')).toBe(1649);
    expect(calcBMR(60, 165, 28, 'female')).toBe(1330);
    expect(calcBMR(60, 165, 28, 'other')).toBe(1413);
  });
  it('TDEE and calorie targets', () => {
    expect(calcTDEE(1649, 'moderate')).toBe(2556);
    expect(calcTDEE(1649, 'unknown')).toBe(2556); // falls back to moderate
    expect(calcCalorieTarget(2556, 'lose_weight')).toBe(2045);
    expect(calcCalorieTarget(2556, 'maintain')).toBe(2556);
    expect(calcCalorieTarget(2556, 'gain_muscle')).toBe(2863);
  });
  it('macros sum back to the calorie target', () => {
    const m = calcMacros(2045, 70, 'lose_weight');
    expect(m.proteinG).toBe(140);
    expect(m.proteinKcal + m.fatKcal + m.carbKcal).toBeCloseTo(2045, -1);
  });
  it('BMI', () => {
    expect(calcBMI(70, 175)).toBeCloseTo(22.9, 1);
    expect(bmiCategory(22.9).label).toBe('Healthy range');
    expect(bmiCategory(31).label).toBe('Obese range');
  });
  it('calcFullProfile returns null until the profile is complete', () => {
    expect(calcFullProfile({ weight: 70 })).toBeNull();
    const full = calcFullProfile({ weight: 70, height: 175, age: 30, gender: 'male', activityLevel: 'moderate', goal: 'maintain' });
    expect(full).toMatchObject({ bmr: 1649, tdee: 2556, calorieTarget: 2556 });
  });
});

describe('storage.js (data persistence, export/import, guest sessions)', () => {
  let Storage;
  beforeEach(async () => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.resetModules();
    Storage = (await import('../../js/storage.js')).default;
  });

  it('persists the profile and stamps timestamps', () => {
    const saved = Storage.saveProfile({ name: 'A', weight: 70 });
    expect(saved.createdAt).toBeTruthy();
    expect(Storage.getProfile()).toMatchObject({ name: 'A', weight: 70, gender: 'female' });
    expect(JSON.parse(window.localStorage.getItem('hmpa:profile')).weight).toBe(70);
  });

  it('never exports the AI API key and never imports over it', () => {
    Storage.saveSettings({ apiKey: 'secret-key', aiProvider: 'groq' });
    const exported = Storage.exportAll();
    expect(exported.settings.apiKey).toBe('');
    Storage.importAll({ ...exported, settings: { ...exported.settings, apiKey: 'attacker' } });
    expect(Storage.getSettings().apiKey).toBe('secret-key');
  });

  it('rejects exports from a newer schema version', () => {
    expect(Storage.previewImport({ schemaVersion: 999 }).ok).toBe(false);
  });

  it('merges progress logs by date on import', () => {
    Storage.saveProgress({ weightLog: [{ date: '2026-01-01', weight: 70 }], calorieLog: [], waterLog: {}, achievements: [] });
    Storage.importAll({ progress: { weightLog: [{ date: '2026-01-02', weight: 69.5 }], calorieLog: [], waterLog: {}, achievements: [] } });
    expect(Storage.getProgress().weightLog.map(e => e.date)).toEqual(['2026-01-01', '2026-01-02']);
  });

  it('guest data lives in sessionStorage and is claimed into localStorage on sign-in', () => {
    Storage.enterGuestSession();
    expect(Storage.isGuestSessionActive()).toBe(true);
    Storage.saveProfile({ name: 'Guest', weight: 60 });
    expect(window.localStorage.getItem('hmpa:profile')).toBeNull();
    expect(JSON.parse(window.sessionStorage.getItem('hmpa:profile')).name).toBe('Guest');

    Storage.claimGuestSessionForAccount();
    expect(Storage.isGuestSessionActive()).toBe(false);
    expect(JSON.parse(window.localStorage.getItem('hmpa:profile')).name).toBe('Guest');
  });

  it('clearLocalData removes every app key', () => {
    Storage.saveProfile({ weight: 70 });
    Storage.saveShoppingList({ items: [{ id: 1 }] });
    Storage.clearLocalData();
    expect(Object.keys(window.localStorage).filter(k => k.startsWith('hmpa:'))).toEqual([]);
  });
});
