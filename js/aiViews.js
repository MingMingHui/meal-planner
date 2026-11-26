/**
 * aiViews.js
 * ----------------------------------------------------------------------------
 * Purpose: The two AI screens, shared by the web app and the Android app
 *          (which packages this file unchanged; mobile.css only adjusts
 *          spacing/touch targets):
 *            - Settings → AI Provider card: provider + model selection,
 *              connect (API key, or OpenRouter OAuth where supported),
 *              connection status, where the credential is stored,
 *              disconnect. Distinguishes app account vs AI provider vs guest.
 *            - AI Usage view: current-period and filtered summaries,
 *              per-model breakdown, history, filters, CSV export — with
 *              provider-reported vs app-estimated numbers labelled.
 *          No provider-specific code: everything comes from ai/providers.js.
 * Inputs:  aiConnections.js / aiUsage.js state; DOM containers.
 * Outputs: Rendered DOM + user actions routed to aiConnections/aiUsage.
 * Depends on: aiConnections.js, aiUsage.js, auth.js, ui.js, router.js, platform.js, ai/*.
 * ----------------------------------------------------------------------------
 */

import {
  getActiveConnection, getConnectionStatus, getEntitlements, checkProxyHealth, refreshAccountConnections,
  connectWithApiKey, disconnectProvider, selectProviderModel, startOAuthConnection, canUseOAuth, isGuestUser,
} from './aiConnections.js';
import { listUsage } from './aiUsage.js';
import { isAuthenticated, getUserProfile, isCloudConfigured } from './auth.js';
import { escapeHTML, fmt, toast } from './ui.js';
import { navigate } from './router.js';
import { saveFile } from './platform.js';
import { listProviders, getProvider, getModel, AUTH_METHODS, PRICING_AS_OF } from './ai/providers.js';
import { CREDENTIAL_STORES } from './ai/policy.js';
import { summarizeUsage, groupUsageByModel, currentPeriod, TOKEN_SOURCES, COST_SOURCES } from './ai/usage.js';
import { AI_ERROR_CODES as C } from './ai/errors.js';

/* ============================== Shared bits ============================== */

const STORE_LABELS = {
  [CREDENTIAL_STORES.ACCOUNT]: 'Encrypted in your account',
  [CREDENTIAL_STORES.DEVICE]: 'This device only',
  [CREDENTIAL_STORES.SESSION]: 'This browser session only (guest)',
};

const STATUS_BADGES = {
  active: ['green', 'Connected'],
  unverified: ['orange', 'Connected — not yet verified'],
  invalid: ['red', 'Credentials rejected — reconnect'],
  expired: ['red', 'Expired — reconnect'],
  none: ['', 'Not connected'],
};

function statusBadge(status) {
  const [color, label] = STATUS_BADGES[status] || STATUS_BADGES.none;
  return `<span class="badge ${color}">${escapeHTML(label)}</span>`;
}

function providerLabel(id) { return getProvider(id)?.label || id; }
function modelLabel(providerId, modelId) { return getModel(providerId, modelId)?.label || modelId; }

export function formatUsd(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n === 0) return '$0.00';
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/* ============================== AI Provider card ============================== */

/**
 * Renders Settings → AI Provider into `card` (a .card element). Re-renders
 * itself after async state (proxy health, account connections) arrives.
 */
export function renderAIProviderCard(card, ui = {}) {
  const active = getActiveConnection();
  const ent = getEntitlements();
  const guest = isGuestUser();
  const selProvider = ui.provider || active.provider;
  const provider = getProvider(selProvider);
  const stores = ent.credentialStores;
  const selStore = ui.store && stores.includes(ui.store) ? ui.store
    : stores.includes(active.store) ? active.store : ent.defaultCredentialStore;
  const selModel = ui.model && getModel(selProvider, ui.model) ? ui.model
    : selProvider === active.provider ? active.model : provider.defaultModel;
  const status = getConnectionStatus(selProvider, selStore);
  const isActiveSelection = selProvider === active.provider && selStore === active.store;
  const oauth = canUseOAuth(selProvider);
  const profile = isAuthenticated() ? getUserProfile() : null;

  const accountNote = guest ? ''
    : ent.accountStorageReason === 'proxy_unavailable'
      ? '<p class="small ai-note">Saving keys to your account isn\'t available on this deployment right now (the secure AI service is not set up or unreachable), so keys can be kept on this device only.</p>'
      : ent.accountStorageReason === 'cloud_not_configured'
        ? '<p class="small ai-note">Cloud features aren\'t configured for this deployment, so keys stay on this device.</p>' : '';

  card.innerHTML = `
    <div class="card-title"><h3>AI Provider</h3>${statusBadge(active.connected ? active.status : 'none')}</div>

    <dl class="ai-identity">
      <div><dt>App account</dt><dd>${profile ? `Signed in as <b>${escapeHTML(profile.name)}</b> with ${escapeHTML(profile.providerLabel)}` : 'Guest session — no app account'}</dd></div>
      <div><dt>AI provider</dt><dd>${active.connected
        ? `<b>${escapeHTML(active.providerInfo.label)}</b> · ${escapeHTML(modelLabel(active.provider, active.model))} · key ${escapeHTML(active.keyHint || '')}${active.authMethod === AUTH_METHODS.OAUTH_PKCE ? ' (connected via OpenRouter sign-in)' : ''}`
        : 'None connected — AI features are off until you connect one'}</dd></div>
      <div><dt>Credential stored</dt><dd>${active.connected ? escapeHTML(STORE_LABELS[active.store]) : '—'}</dd></div>
    </dl>
    <p class="small">Your app sign-in (Gmail/Outlook) and your AI provider account are separate. This app never asks for your AI provider password — only an API key you create on the provider's website${oauth ? ', or an approval on OpenRouter\'s own sign-in page' : ''}.${guest ? ' As a guest, your key is kept in this browser tab only and is cleared when you close it.' : ''}</p>
    ${accountNote}

    <form id="ai-provider-form" autocomplete="off">
      <div class="form-grid">
        <div class="field"><label for="ai-provider">Provider</label>
          <select id="ai-provider">${listProviders().map(p => `<option value="${escapeHTML(p.id)}" ${p.id === selProvider ? 'selected' : ''}>${escapeHTML(p.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="ai-model">Model</label>
          <select id="ai-model">${provider.models.map(m => `<option value="${escapeHTML(m.id)}" ${m.id === selModel ? 'selected' : ''}>${escapeHTML(m.label)}</option>`).join('')}</select></div>
      </div>
      <p class="small">${escapeHTML(provider.description)} <a href="${escapeHTML(provider.keyUrl)}" target="_blank" rel="noopener noreferrer">Create an API key ↗</a></p>

      ${guest ? '' : `
      <fieldset class="ai-store">
        <legend class="small"><b>Where to keep the credential</b></legend>
        ${[CREDENTIAL_STORES.ACCOUNT, CREDENTIAL_STORES.DEVICE].map(s => `
          <label class="ai-store-option ${stores.includes(s) ? '' : 'disabled'}">
            <input type="radio" name="ai-store" value="${s}" ${s === selStore ? 'checked' : ''} ${stores.includes(s) ? '' : 'disabled'} />
            <span><b>${escapeHTML(STORE_LABELS[s])}</b>${s === CREDENTIAL_STORES.ACCOUNT
              ? ' — recommended. Encrypted on the server, works on all your devices, never shown again.'
              : ' — kept in this device\'s browser storage and sent straight to the provider.'}</span>
          </label>`).join('')}
      </fieldset>`}

      <div class="ai-status-row"><span class="small">${escapeHTML(provider.label)} in ${escapeHTML(STORE_LABELS[selStore].toLowerCase())}:</span> ${statusBadge(status.connected ? status.status : 'none')}${status.connected ? ` <span class="small mono">${escapeHTML(status.keyHint || '')}</span>` : ''}</div>

      ${oauth ? `
        <button type="button" class="btn btn-ghost btn-sm" id="ai-oauth-btn">Connect with ${escapeHTML(provider.label)}</button>
        <div class="auth-divider ai-divider"><span>OR PASTE AN API KEY</span></div>` : ''}

      <div class="field full"><label for="ai-apikey">${status.connected ? 'Replace API key (optional)' : 'API key'}</label>
        <input type="password" id="ai-apikey" placeholder="${escapeHTML(status.connected ? `Saved key ${status.keyHint || ''} — paste a new key to replace it` : provider.keyPlaceholder)}" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="text" /></div>

      <div class="ai-actions">
        <button type="submit" class="btn btn-primary btn-sm" id="ai-save-btn">${status.connected ? (isActiveSelection ? 'Save' : 'Use this provider') : 'Connect & verify'}</button>
        ${status.connected ? '<button type="button" class="btn btn-danger btn-sm" id="ai-disconnect-btn">Disconnect</button>' : ''}
        <button type="button" class="btn btn-ghost btn-sm" id="ai-usage-btn">View AI usage →</button>
      </div>
      ${status.connected ? `<p class="small">Disconnecting deletes the credential from ${selStore === CREDENTIAL_STORES.ACCOUNT ? 'your account' : 'this device'}. To revoke the key itself, delete it on <a href="${escapeHTML(provider.revokeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHTML(provider.label)}'s website ↗</a>.</p>` : ''}
    </form>
  `;

  const form = card.querySelector('#ai-provider-form');
  const state = () => ({
    provider: card.querySelector('#ai-provider').value,
    model: card.querySelector('#ai-model').value,
    store: guest ? CREDENTIAL_STORES.SESSION : (card.querySelector('input[name="ai-store"]:checked')?.value || selStore),
  });
  const rerender = (patch = {}) => renderAIProviderCard(card, { ...state(), loaded: ui.loaded, ...patch });

  card.querySelector('#ai-provider').addEventListener('change', (e) => rerender({ provider: e.target.value, model: null }));
  card.querySelectorAll('input[name="ai-store"]').forEach(r => r.addEventListener('change', () => rerender()));
  card.querySelector('#ai-usage-btn').addEventListener('click', () => navigate('usage'));

  card.querySelector('#ai-oauth-btn')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { await startOAuthConnection(state()); } // navigates away on success
    catch (err) { e.currentTarget.disabled = false; toast(err.message, 'error', 5000); }
  });

  card.querySelector('#ai-disconnect-btn')?.addEventListener('click', async (e) => {
    const s = state();
    if (!window.confirm(`Disconnect ${providerLabel(s.provider)}? The saved credential will be deleted from ${s.store === CREDENTIAL_STORES.ACCOUNT ? 'your account' : 'this device'}.`)) return;
    e.currentTarget.disabled = true;
    try { await disconnectProvider(s.provider, s.store); toast(`${providerLabel(s.provider)} disconnected.`, 'success'); }
    catch (err) { toast(err.message, 'error', 5000); }
    rerender();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const s = state();
    const keyInput = card.querySelector('#ai-apikey');
    const apiKey = keyInput.value.trim();
    const btn = card.querySelector('#ai-save-btn');
    if (!apiKey) {
      if (!getConnectionStatus(s.provider, s.store).connected) { toast('Paste an API key to connect this provider.', 'error'); return; }
      selectProviderModel(s);
      toast(`AI settings saved — using ${modelLabel(s.provider, s.model)}.`, 'success');
      rerender();
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Verifying…';
    try {
      const { verified } = await connectWithApiKey({ ...s, apiKey });
      keyInput.value = '';
      toast(verified ? `${providerLabel(s.provider)} connected.` : `${providerLabel(s.provider)} saved. It couldn't be verified right now and will be checked on first use.`, verified ? 'success' : 'default', 5000);
    } catch (err) {
      keyInput.value = ''; // never leave a rejected key sitting in the form
      toast(err.message, 'error', 6000);
    }
    rerender();
  });

  // Fetch async state once per render cycle, then refresh the card.
  if (!guest && !ui.loaded) {
    Promise.all([
      checkProxyHealth(),
      isCloudConfigured() ? refreshAccountConnections().catch(() => []) : Promise.resolve([]),
    ]).then(() => {
      if (!card.isConnected) return;
      const typed = card.querySelector('#ai-apikey')?.value || ''; // don't wipe a key being typed
      renderAIProviderCard(card, { ...state(), loaded: true });
      const input = card.querySelector('#ai-apikey');
      if (input) input.value = typed;
    });
  }
}

/** Toast for the result of completeOAuthFromUrl() (run by app.js on load). */
export function reportOAuthResult(result) {
  if (!result) return;
  if (result.ok) toast(`${providerLabel(result.provider)} connected.`, 'success', 4000);
  else toast(result.error?.message || 'Connecting the AI provider did not complete.', 'error', 6000);
}

/* ============================== AI Usage view ============================== */

function isoDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function defaultFilters() {
  const to = new Date();
  const from = new Date(); from.setDate(from.getDate() - 29);
  return { from: isoDate(from), to: isoDate(to), provider: '', model: '' };
}

let usageFilters = null;

function tokenSourceBadge(r) {
  return r.tokenSource === TOKEN_SOURCES.PROVIDER
    ? '<span class="badge green" title="Token counts reported by the provider in its response">Provider-reported</span>'
    : '<span class="badge orange" title="The provider did not report token counts; estimated by the app at ~4 characters per token">App-estimated</span>';
}

function costCell(r) {
  if (r.estimatedCostUsd === null) return '<span title="No reliable pricing for this model">—</span>';
  if (r.costSource === COST_SOURCES.PROVIDER) return `${formatUsd(r.estimatedCostUsd)} <span class="badge green" title="Charge reported by the provider">Provider</span>`;
  return `${formatUsd(r.estimatedCostUsd)} <span class="badge orange" title="Estimated from token counts and published prices">Est.</span>`;
}

function summaryTiles(s) {
  const costLabel = s.hasEstimatedCost || !s.costComplete ? 'Estimated cost' : 'Cost';
  const costNote = !s.costComplete ? '<div class="small">Excludes models without pricing</div>' : '';
  return `
    <div class="usage-tiles">
      <div class="stat-card"><div class="stat-label">Total tokens</div><div class="stat-value">${fmt(s.totalTokens)}</div>${s.hasEstimatedTokens ? '<div class="small">Includes app estimates</div>' : ''}</div>
      <div class="stat-card"><div class="stat-label">Input tokens</div><div class="stat-value">${fmt(s.inputTokens)}</div></div>
      <div class="stat-card"><div class="stat-label">Output tokens</div><div class="stat-value">${fmt(s.outputTokens)}</div></div>
      <div class="stat-card"><div class="stat-label">Total requests</div><div class="stat-value">${fmt(s.requests)}</div>${s.failedRequests ? `<div class="small">${fmt(s.failedRequests)} failed</div>` : ''}</div>
      <div class="stat-card"><div class="stat-label">${costLabel}</div><div class="stat-value">${formatUsd(s.estimatedCostUsd)}</div>${costNote}</div>
    </div>`;
}

function usageCsv(records) {
  const head = ['created_at', 'provider', 'model', 'feature', 'status', 'error_code', 'input_tokens', 'output_tokens', 'total_tokens', 'token_source', 'estimated_cost_usd', 'cost_source', 'recorded_by'];
  const rows = records.map(r => [r.createdAt, r.provider, r.model, r.feature, r.status, r.errorCode || '', r.inputTokens, r.outputTokens, r.totalTokens, r.tokenSource, r.estimatedCostUsd ?? '', r.costSource, r.recordedBy]);
  return [head, ...rows].map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
}

export async function renderUsageView() {
  const container = document.getElementById('view-usage');
  if (!container) return;
  usageFilters = usageFilters || defaultFilters();
  const f = usageFilters;
  const provider = f.provider ? getProvider(f.provider) : null;
  const guest = isGuestUser();

  container.innerHTML = `
    <div class="card">
      <form class="usage-filters" id="usage-filters">
        <div class="field"><label for="uf-from">From</label><input type="date" id="uf-from" value="${escapeHTML(f.from)}" /></div>
        <div class="field"><label for="uf-to">To</label><input type="date" id="uf-to" value="${escapeHTML(f.to)}" /></div>
        <div class="field"><label for="uf-provider">Provider</label><select id="uf-provider"><option value="">All providers</option>${listProviders().map(p => `<option value="${escapeHTML(p.id)}" ${p.id === f.provider ? 'selected' : ''}>${escapeHTML(p.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="uf-model">Model</label><select id="uf-model" ${provider ? '' : 'disabled'}><option value="">All models</option>${provider ? provider.models.map(m => `<option value="${escapeHTML(m.id)}" ${m.id === f.model ? 'selected' : ''}>${escapeHTML(m.label)}</option>`).join('') : ''}</select></div>
        <div class="usage-filter-actions">
          <button type="submit" class="btn btn-primary btn-sm">Apply</button>
          <button type="button" class="btn btn-ghost btn-sm" id="uf-reset">Reset</button>
        </div>
      </form>
    </div>
    <div id="usage-body"><div class="card"><p class="small">Loading usage…</p></div></div>
  `;

  const form = container.querySelector('#usage-filters');
  form.querySelector('#uf-provider').addEventListener('change', (e) => { usageFilters = { ...readFilters(form), provider: e.target.value, model: '' }; renderUsageView(); });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const next = readFilters(form);
    if (next.from && next.to && next.from > next.to) { toast('The start date must be on or before the end date.', 'error'); return; }
    usageFilters = next;
    renderUsageView();
  });
  form.querySelector('#uf-reset').addEventListener('click', () => { usageFilters = defaultFilters(); renderUsageView(); });

  const period = currentPeriod();
  let filtered; let monthly;
  try {
    [filtered, monthly] = await Promise.all([listUsage(f), listUsage({ from: period.from, to: period.to })]);
  } catch {
    container.querySelector('#usage-body').innerHTML = `<div class="card"><p class="small">Usage history could not be loaded right now.</p></div>`;
    return;
  }
  if (!container.isConnected || usageFilters !== f) return; // navigated away or filters changed meanwhile

  const s = summarizeUsage(filtered.records);
  const ms = summarizeUsage(monthly.records);
  const groups = groupUsageByModel(filtered.records);
  const scopeText = filtered.scope === 'session'
    ? 'Guest session: usage is kept in this browser tab only and is cleared when you close it.'
    : filtered.scope === 'account'
      ? 'Usage from all your devices, saved to your account. Only you can see it.'
      : 'Usage recorded on this device.';
  const active = getActiveConnection();

  container.querySelector('#usage-body').innerHTML = `
    ${filtered.cloudError ? `<div class="card"><p class="small ai-note">${escapeHTML(filtered.cloudError.code === C.USAGE_UNAVAILABLE || !filtered.cloudError.message ? 'Account usage history could not be loaded right now — showing usage recorded on this device.' : filtered.cloudError.message)}</p></div>` : ''}
    ${!active.connected && !filtered.records.length ? `<div class="card"><p class="small">No AI provider is connected. <a href="#" id="usage-goto-settings">Connect one in Settings</a> to start using AI features — usage will appear here.</p></div>` : ''}

    <div class="card">
      <div class="card-title"><h3>Current period · ${escapeHTML(period.label)}</h3></div>
      ${summaryTiles(ms)}
    </div>

    <div class="card">
      <div class="card-title"><h3>Selected range</h3><button class="btn btn-ghost btn-sm" id="usage-export" ${filtered.records.length ? '' : 'disabled'}>Export CSV</button></div>
      ${summaryTiles(s)}
      ${groups.length ? `
        <h4 class="usage-subhead">By provider and model</h4>
        <table class="usage-table">
          <thead><tr><th>Provider</th><th>Model</th><th>Requests</th><th>Input</th><th>Output</th><th>Total</th><th>Cost</th></tr></thead>
          <tbody>${groups.map(g => `<tr>
            <td data-label="Provider">${escapeHTML(g.providerLabel)}</td>
            <td data-label="Model">${escapeHTML(modelLabel(g.provider, g.model))}</td>
            <td data-label="Requests">${fmt(g.requests)}</td>
            <td data-label="Input">${fmt(g.inputTokens)}</td>
            <td data-label="Output">${fmt(g.outputTokens)}</td>
            <td data-label="Total">${fmt(g.totalTokens)}</td>
            <td data-label="Cost">${g.costComplete ? formatUsd(g.estimatedCostUsd) : '—'}</td>
          </tr>`).join('')}</tbody>
        </table>` : ''}
    </div>

    <div class="card">
      <div class="card-title"><h3>Usage history</h3><span class="small">${fmt(filtered.records.length)} request${filtered.records.length === 1 ? '' : 's'}</span></div>
      ${filtered.records.length ? `
        <table class="usage-table">
          <thead><tr><th>Date &amp; time</th><th>Provider</th><th>Model</th><th>Feature</th><th>Input</th><th>Output</th><th>Total</th><th>Cost</th><th>Tokens</th><th>Status</th></tr></thead>
          <tbody>${filtered.records.slice(0, 500).map(r => `<tr>
            <td data-label="Date &amp; time">${escapeHTML(new Date(r.createdAt).toLocaleString())}</td>
            <td data-label="Provider">${escapeHTML(providerLabel(r.provider))}</td>
            <td data-label="Model">${escapeHTML(modelLabel(r.provider, r.model))}</td>
            <td data-label="Feature">${escapeHTML(r.feature.replace('_', ' '))}</td>
            <td data-label="Input">${fmt(r.inputTokens)}</td>
            <td data-label="Output">${fmt(r.outputTokens)}</td>
            <td data-label="Total">${fmt(r.totalTokens)}</td>
            <td data-label="Cost">${costCell(r)}</td>
            <td data-label="Tokens">${r.status === 'success' ? tokenSourceBadge(r) : '—'}</td>
            <td data-label="Status">${r.status === 'success' ? '<span class="badge green">OK</span>' : `<span class="badge red" title="${escapeHTML(r.errorCode || '')}">Failed</span>`}${r.pending ? ' <span class="badge orange" title="Saved on this device; will upload to your account when online">Pending</span>' : ''}</td>
          </tr>`).join('')}</tbody>
        </table>
        ${filtered.records.length > 500 ? '<p class="small">Showing the 500 most recent requests. Narrow the date range or export CSV to see everything.</p>' : ''}
      ` : '<p class="small">No AI requests in this range.</p>'}
    </div>

    <div class="card">
      <div class="card-title"><h3>About these numbers</h3></div>
      <p class="small">${escapeHTML(scopeText)} Prompts and AI replies are never stored — only token counts and request details.</p>
      <p class="small"><span class="badge green">Provider-reported</span> token counts come from the provider's own response for each request. <span class="badge orange">App-estimated</span> counts are used only when a provider returns none (≈4 characters per token).</p>
      <p class="small"><b>Cost</b> is reported by the provider where it provides one (OpenRouter). Otherwise it is an estimate from token counts and published list prices as of ${escapeHTML(PRICING_AS_OF)}; your provider's bill is authoritative (discounts, caching, taxes and price changes are not reflected). Models without reliable pricing show "—". Failed requests count as requests with 0 tokens.</p>
    </div>
  `;

  container.querySelector('#usage-goto-settings')?.addEventListener('click', (e) => { e.preventDefault(); navigate('settings'); });
  container.querySelector('#usage-export')?.addEventListener('click', () => {
    saveFile(new Blob([usageCsv(filtered.records)], { type: 'text/csv' }), `ai-usage-${f.from || 'all'}-to-${f.to || 'now'}.csv`);
    toast(guest ? 'Usage exported. Guest usage is cleared when you close this tab.' : 'Usage exported.', 'success');
  });
}

function readFilters(form) {
  return {
    from: form.querySelector('#uf-from').value,
    to: form.querySelector('#uf-to').value,
    provider: form.querySelector('#uf-provider').value,
    model: form.querySelector('#uf-model').value,
  };
}
