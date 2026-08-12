/**
 * progress.js
 * ----------------------------------------------------------------------------
 * Purpose: Tracks weight, daily calories and water intake over time; renders
 *          the Progress Tracker view with Chart.js charts, weekly/monthly
 *          summaries and achievement badges; also exposes small helpers
 *          (today's water cups, today's logged calories) used by the
 *          Dashboard.
 * Inputs:  Manual log entries from the user.
 * Outputs: Renders #view-progress; persists via storage.js.
 * Depends on: storage.js, nutrition.js (BMI), ui.js, Chart.js (CDN global).
 * ----------------------------------------------------------------------------
 */

import Storage from './storage.js';
import { calcBMI, bmiCategory } from './nutrition.js';
import { ICONS, escapeHTML, fmt, toast } from './ui.js';
import { shareContent } from './share.js';
import { exportProgressPDF } from './pdf.js';

function todayStr() { return new Date().toISOString().slice(0, 10); }

export function logWeight(weight, date = todayStr()) {
  const progress = Storage.getProgress();
  const existing = progress.weightLog.find(e => e.date === date);
  if (existing) existing.weight = weight;
  else progress.weightLog.push({ date, weight });
  progress.weightLog.sort((a, b) => a.date.localeCompare(b.date));
  Storage.saveProgress(progress);
  checkAndAwardAchievements(progress);
  return progress;
}

export function logCalories(kcal, date = todayStr()) {
  const progress = Storage.getProgress();
  const existing = progress.calorieLog.find(e => e.date === date);
  if (existing) existing.kcal = kcal;
  else progress.calorieLog.push({ date, kcal });
  progress.calorieLog.sort((a, b) => a.date.localeCompare(b.date));
  Storage.saveProgress(progress);
  checkAndAwardAchievements(progress);
  return progress;
}

export function getTodayCalories() {
  const progress = Storage.getProgress();
  const entry = progress.calorieLog.find(e => e.date === todayStr());
  return entry ? entry.kcal : 0;
}

export function getTodayWaterCups() {
  const progress = Storage.getProgress();
  return progress.waterLog?.[todayStr()] || 0;
}

export function addWaterCup(delta = 1) {
  const progress = Storage.getProgress();
  progress.waterLog = progress.waterLog || {};
  const t = todayStr();
  progress.waterLog[t] = Math.max(0, (progress.waterLog[t] || 0) + delta);
  Storage.saveProgress(progress);
  return progress.waterLog[t];
}

/* ------------------------------ Achievements ------------------------------ */

const ACHIEVEMENT_DEFS = [
  { id: 'first_weight', label: 'First weigh-in logged', test: p => p.weightLog.length >= 1 },
  { id: 'week_weight', label: '7 weight entries logged', test: p => p.weightLog.length >= 7 },
  { id: 'first_calorie', label: 'First calorie log', test: p => p.calorieLog.length >= 1 },
  { id: 'streak_7', label: '7-day calorie logging streak', test: p => hasStreak(p.calorieLog, 7) },
  { id: 'streak_30', label: '30-day calorie logging streak', test: p => hasStreak(p.calorieLog, 30) },
  { id: 'weight_progress', label: 'Weight trending toward goal', test: p => weightTrendPositive(p.weightLog) },
];

function hasStreak(log, days) {
  if (log.length < days) return false;
  const dates = new Set(log.map(e => e.date));
  const d = new Date();
  for (let i = 0; i < days; i++) {
    const s = d.toISOString().slice(0, 10);
    if (!dates.has(s)) return false;
    d.setDate(d.getDate() - 1);
  }
  return true;
}

function weightTrendPositive(log) {
  if (log.length < 3) return false;
  const recent = log.slice(-3);
  return recent[0].weight !== recent[2].weight;
}

function checkAndAwardAchievements(progress) {
  const unlockedIds = new Set(progress.achievements.map(a => a.id));
  let newlyUnlocked = [];
  ACHIEVEMENT_DEFS.forEach(def => {
    if (!unlockedIds.has(def.id) && def.test(progress)) {
      progress.achievements.push({ id: def.id, label: def.label, unlockedAt: new Date().toISOString() });
      newlyUnlocked.push(def.label);
    }
  });
  if (newlyUnlocked.length) {
    Storage.saveProgress(progress);
    newlyUnlocked.forEach(l => toast(`🏆 Achievement unlocked: ${l}`, 'success', 4000));
  }
}

/* -------------------------------- Rendering -------------------------------- */

let weightChart = null;
let calorieChart = null;

export function renderProgressView() {
  const container = document.getElementById('view-progress');
  const profile = Storage.getProfile();
  const progress = Storage.getProgress();

  container.innerHTML = `
    <div class="grid grid-dash">
      <div class="g-6 card">
        <div class="card-title"><h3>Log today's weight</h3></div>
        <div class="chat-input-row">
          <input type="number" id="log-weight-input" placeholder="Weight (kg)" step="0.1" />
          <button class="btn btn-primary" id="log-weight-btn">Save</button>
        </div>
      </div>
      <div class="g-6 card">
        <div class="card-title"><h3>Log today's calories</h3></div>
        <div class="chat-input-row">
          <input type="number" id="log-cal-input" placeholder="Calories eaten today" />
          <button class="btn btn-primary" id="log-cal-btn">Save</button>
        </div>
      </div>
      <div class="g-6 card">
        <div class="card-title"><h3>Weight history</h3></div>
        <canvas id="weight-chart" height="180"></canvas>
      </div>
      <div class="g-6 card">
        <div class="card-title"><h3>Calorie history</h3></div>
        <canvas id="calorie-chart" height="180"></canvas>
      </div>
      <div class="g-6 card">
        <div class="card-title"><h3>Weekly / monthly summary</h3></div>
        <div id="summary-block"></div>
      </div>
      <div class="g-6 card">
        <div class="card-title"><h3>Achievements & milestones</h3></div>
        <div id="achievements-block"></div>
      </div>
      <div class="g-12 card">
        <div class="card-title"><h3>Share your progress</h3></div>
        <div class="share-row" id="progress-share"></div>
        <button class="btn btn-ghost btn-sm" id="progress-pdf-btn" style="margin-top:10px;">${ICONS.sparkle} Download PDF</button>
      </div>
    </div>
  `;

  container.querySelector('#log-weight-btn').addEventListener('click', () => {
    const val = parseFloat(container.querySelector('#log-weight-input').value);
    if (!val || val <= 0) { toast('Enter a valid weight.', 'error'); return; }
    logWeight(val);
    Storage.saveProfile({ weight: val });
    toast('Weight logged.', 'success');
    renderProgressView();
  });

  container.querySelector('#log-cal-btn').addEventListener('click', () => {
    const val = parseInt(container.querySelector('#log-cal-input').value, 10);
    if (!val || val <= 0) { toast('Enter a valid calorie amount.', 'error'); return; }
    logCalories(val);
    toast('Calories logged.', 'success');
    renderProgressView();
  });

  renderCharts(progress);
  renderSummary(container, progress, profile);
  renderAchievements(container, progress);

  shareContent(container.querySelector('#progress-share'), {
    title: 'My progress summary',
    text: buildShareSummary(progress, profile),
  });
  container.querySelector('#progress-pdf-btn').addEventListener('click', () => exportProgressPDF());
}

function renderCharts(progress) {
  if (typeof Chart === 'undefined') return; // Chart.js failed to load (offline) — charts skipped gracefully
  const weightCtx = document.getElementById('weight-chart');
  const calorieCtx = document.getElementById('calorie-chart');
  const theme = getComputedStyle(document.documentElement);
  const gridColor = theme.getPropertyValue('--line').trim();
  const inkColor = theme.getPropertyValue('--ink-soft').trim();

  if (weightChart) weightChart.destroy();
  if (calorieChart) calorieChart.destroy();

  const wLog = progress.weightLog.slice(-30);
  weightChart = new Chart(weightCtx, {
    type: 'line',
    data: {
      labels: wLog.map(e => e.date.slice(5)),
      datasets: [{ label: 'Weight (kg)', data: wLog.map(e => e.weight), borderColor: '#2F5233', backgroundColor: 'rgba(47,82,51,0.12)', tension: 0.35, fill: true }],
    },
    options: chartOptions(gridColor, inkColor),
  });

  const cLog = progress.calorieLog.slice(-30);
  calorieChart = new Chart(calorieCtx, {
    type: 'bar',
    data: {
      labels: cLog.map(e => e.date.slice(5)),
      datasets: [{ label: 'Calories', data: cLog.map(e => e.kcal), backgroundColor: '#E08A1E' }],
    },
    options: chartOptions(gridColor, inkColor),
  });
}

function chartOptions(gridColor, inkColor) {
  return {
    responsive: true,
    plugins: { legend: { labels: { color: inkColor } } },
    scales: {
      x: { ticks: { color: inkColor }, grid: { color: gridColor } },
      y: { ticks: { color: inkColor }, grid: { color: gridColor } },
    },
  };
}

function renderSummary(container, progress, profile) {
  const block = container.querySelector('#summary-block');
  const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
  const monthAgo = new Date(); monthAgo.setDate(monthAgo.getDate() - 30);
  const weekAgoStr = weekAgo.toISOString().slice(0, 10);
  const monthAgoStr = monthAgo.toISOString().slice(0, 10);

  const weekCal = progress.calorieLog.filter(e => e.date >= weekAgoStr);
  const monthCal = progress.calorieLog.filter(e => e.date >= monthAgoStr);
  const avgWeek = weekCal.length ? Math.round(weekCal.reduce((s, e) => s + e.kcal, 0) / weekCal.length) : null;
  const avgMonth = monthCal.length ? Math.round(monthCal.reduce((s, e) => s + e.kcal, 0) / monthCal.length) : null;

  const firstWeight = progress.weightLog[0]?.weight;
  const lastWeight = progress.weightLog[progress.weightLog.length - 1]?.weight;
  const weightChange = (firstWeight != null && lastWeight != null) ? +(lastWeight - firstWeight).toFixed(1) : null;
  const bmi = lastWeight && profile.height ? calcBMI(lastWeight, profile.height) : null;
  const cat = bmiCategory(bmi);

  block.innerHTML = `
    <div class="nutrient-row" style="font-size:0.85rem; gap:16px;">
      <span>Avg. calories (7d): <b>${avgWeek ? fmt(avgWeek) : '—'}</b></span>
      <span>Avg. calories (30d): <b>${avgMonth ? fmt(avgMonth) : '—'}</b></span>
      <span>Weight change: <b>${weightChange != null ? (weightChange > 0 ? '+' : '') + weightChange + ' kg' : '—'}</b></span>
      <span>Current BMI: <b>${bmi ?? '—'}</b> (${escapeHTML(cat.label)})</span>
    </div>
  `;
}

function renderAchievements(container, progress) {
  const block = container.querySelector('#achievements-block');
  if (!progress.achievements.length) {
    block.innerHTML = `<p class="small">No achievements yet — start logging your weight and calories to unlock milestones.</p>`;
    return;
  }
  block.innerHTML = progress.achievements
    .slice().reverse()
    .map(a => `<div class="badge green" style="margin:0 6px 6px 0;">🏆 ${escapeHTML(a.label)}</div>`)
    .join('');
}

function buildShareSummary(progress, profile) {
  const lastWeight = progress.weightLog[progress.weightLog.length - 1]?.weight;
  const bmi = lastWeight && profile.height ? calcBMI(lastWeight, profile.height) : null;
  return `My progress on Health Meal Planning Agent — ${progress.weightLog.length} weight logs, ${progress.achievements.length} achievements unlocked${bmi ? `, current BMI ${bmi}` : ''}.`;
}
