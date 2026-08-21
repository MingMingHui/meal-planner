# 🥗 Health Meal Planning Agent

A production-ready, AI-powered health meal planning web application that runs **entirely in the browser** — no custom backend, no build step, no VPS. Deploy it straight to GitHub Pages and it works, with optional cloud sign-in and sync layered on top via Supabase's free tier.

Built with a Malaysian-first food database (nasi lemak, laksa, roti canai, and more) alongside international staples, personalized calorie/macro science, a swappable AI layer on free open-source models, optional "Continue with Gmail" / "Continue with Outlook" sign-in with cross-device cloud sync, and in-browser PDF report generation.

---

## Table of Contents

- [Project Overview](#project-overview)
- [Features](#features)
- [Architecture](#architecture)
- [Folder Structure](#folder-structure)
- [Installation](#installation)
- [Deployment to GitHub Pages](#deployment-to-github-pages)
- [Authentication Setup](#authentication-setup)
- [Guest Sessions](#guest-sessions)
- [How Cloud Sync Works](#how-cloud-sync-works)
- [PDF Export](#pdf-export)
- [How AI Integration Works](#how-ai-integration-works)
- [Supported AI Providers](#supported-ai-providers)
- [Security](#security)
- [Privacy](#privacy)
- [Screenshots](#screenshots)
- [Testing Checklist](#testing-checklist)
- [Roadmap](#roadmap)
- [Known Limitations](#known-limitations)
- [Contribution Guide](#contribution-guide)
- [License](#license)

---

## Project Overview

Health Meal Planning Agent helps people plan healthy meals around **who they actually are**: their body, their goals, their budget, their cooking skill, and their culture. Every calorie and macro number is computed with standard, explained nutrition formulas (Mifflin-St Jeor, TDEE activity factors, IOM fiber guidelines) — never a black box.

The app works fully offline-capable for its core planning features (local recipe database + rule-based planner) as a guest, with **no account required** — guest access is scoped to the current browser session (see [Guest Sessions](#guest-sessions)). Signing in with Gmail or Outlook adds cross-device cloud sync on top, backed by a Supabase PostgreSQL database with Row Level Security, without changing anything about how the app is hosted (still 100% static, still GitHub Pages).

## Features

- ✅ Dashboard — calorie rings, remaining calories, BMI, goal status, water reminder, today's meals, macro progress, sync status
- ✅ Profile — full health, lifestyle, allergy and preference intake, stored locally (and in the cloud if signed in)
- ✅ Calorie Calculator — BMR / TDEE / calorie target / macros / fiber / water, each with the formula explained
- ✅ Meal Planner — auto-generated daily plan (local, offline-capable) or AI-generated on demand
- ✅ Recipe Generator — AI-original recipes personalized to your profile, or a curated local pick if no API key is set
- ✅ Shopping List — auto-built from your meal plan, grouped by category, checkable, exportable, printable
- ✅ Progress Tracker — weight & calorie logs, Chart.js charts, weekly/monthly summaries, achievements
- ✅ AI Coach — chat-based nutrition Q&A, grounded in your profile
- ✅ **Authentication** — "Continue with Gmail" & "Continue with Outlook" sign-in via Supabase Auth (Google / Microsoft-Azure-AD OAuth under the hood), or continue as a guest for the current browser session only (see [Guest Sessions](#guest-sessions))
- ✅ **Cloud Sync** — two-way sync between this device and your account, with offline queuing and conflict handling
- ✅ **PDF Export** — Complete Report, Profile, Meal Plan, Shopping List, Progress, and individual Recipe reports, generated fully in-browser
- ✅ JSON/CSV export & JSON import with a preview + merge/replace confirmation step
- ✅ Settings — theme, units, language, AI provider & key, account, cloud sync controls, data management, privacy notice
- ✅ Dark mode / light mode
- ✅ Fully responsive (desktop, tablet, mobile with bottom tab bar)
- ✅ Share meal plans, recipes, shopping lists and progress via WhatsApp, Telegram, Facebook, Email, or copy

## Architecture

The app is two static pages, not one combined page: `index.html` is a standalone login/guest-choice screen (controlled by `authGate.js`), and `dashboard.html` is the app shell (controlled by `app.js`), which is itself a single-page app internally — JavaScript ES Modules render each view into empty `<section>` containers on navigation within that page. There is no framework, no bundler, and no build step — every file is loaded as-is by the browser.

Moving between the two pages is a real browser navigation (`window.location`), not a `hidden`-attribute toggle within one document:

- **`index.html`** (`authGate.js`): if already signed in or already in an active guest session, redirects straight to `dashboard.html`. Otherwise wires up the Gmail/Outlook/Guest buttons; "Continue as Guest" and a completed sign-in both navigate to `dashboard.html`.
- **`dashboard.html`** (`app.js`): on load, requires either an authenticated session or an active guest session — anyone without either (direct URL visit, stale bookmark, ended guest session) is redirected back to `index.html`. Signing out redirects back to `index.html` too.

```
                         index.html  (authGate.js — login/guest choice)
                             │  window.location redirect, not a div toggle
                             ▼
                       dashboard.html
                             │
                           app.js  ── user menu, onboarding, dashboard/profile/settings/coach; guards this page
                             │
        ┌──────────┬─────────┼─────────┬──────────┬───────────┐
        ▼          ▼         ▼         ▼          ▼           ▼
   calorie.js  recipes.js shopping.js progress.js  ai.js     pdf.js
        │          │         │         │
        └────┬─────┴────┬────┴────┬────┘
             ▼           ▼        ▼
       nutrition.js  storage.js  data.js
      (pure formulas) (local KV) (recipes/ingredients JSON)

   Auth & cloud layer (all new in this revision):
   ┌──────────┐   ┌────────────────┐   ┌────────────────┐
   │ auth.js  │──▶│ cloudStorage.js │──▶│ Supabase (RLS)  │
   └──────────┘   └────────┬────────┘   └────────────────┘
                            │
                     syncManager.js  ── merges local (storage.js) ↔ cloud, tracks sync status
                            │
                         app.js  ── user menu, sync badge, first-login conflict prompt

   config.js  — deployment credentials (Supabase URL/anon key), never a secret
   utils.js   — small date/merge helpers shared by storage.js & syncManager.js
   ui.js      — shared icons/toast/modal/escaping used by every view
   router.js  — tab switching
   share.js   — Web Share API + social fallback buttons
```

Each module has a single, documented responsibility (see the header comment block at the top of every `.js` file for purpose/inputs/outputs/dependencies). Database access is centralized in `cloudStorage.js` — no other file talks to Supabase directly — and merge/conflict logic is centralized in `syncManager.js`.

## Folder Structure

```
health-meal-planner/
│
├── index.html              # login/guest-choice page (see authGate.js) — separate page, not a div toggle
├── dashboard.html          # app shell page (see app.js) — everything after sign-in/guest entry
├── README.md
├── LICENSE
│
├── css/
│   ├── styles.css          # layout, components, responsive rules, auth screen, user menu
│   └── variables.css       # design tokens (color, type, spacing, dark mode)
│
├── js/
│   ├── authGate.js          # index.html-only controller: redirect-if-already-in, wire Gmail/Outlook/Guest buttons
│   ├── app.js               # dashboard.html-only controller: entry guard, dashboard, profile, settings, AI coach, onboarding
│   ├── ui.js                 # shared UI helpers (icons, toast, modal, escaping)
│   ├── router.js            # tab/view switching (within dashboard.html)
│   ├── config.js             # Supabase URL/anon key placeholders (fill in your own — see below)
│   ├── auth.js                # Supabase Auth: Gmail/Outlook sign-in (Google/Azure OAuth), session, listeners
│   ├── storage.js            # localStorage (signed-in) / sessionStorage (guest) abstraction, versioned schema + migrations
│   ├── cloudStorage.js       # centralized Supabase table reads/writes (RLS-scoped)
│   ├── syncManager.js        # merges local ↔ cloud data, sync status, conflict resolution
│   ├── data.js                 # loads/caches ingredients.json + recipes.json
│   ├── nutrition.js          # BMR/TDEE/macro/BMI/water formulas
│   ├── calorie.js             # Calorie Calculator view
│   ├── recipes.js             # recipe filtering, local + AI meal planning, recipe views
│   ├── shopping.js           # shopping list build/render/export/print
│   ├── progress.js           # weight/calorie/water logging, charts, achievements
│   ├── ai.js                    # swappable AI provider abstraction
│   ├── pdf.js                  # in-browser PDF report generation (jsPDF + autoTable)
│   ├── utils.js               # small shared date/merge helpers
│   └── share.js               # Web Share API + social fallback buttons
│
├── assets/
│   ├── icons/
│   └── images/
│
├── data/
│   ├── ingredients.json      # nutrition database (per 100g), Malaysian-inclusive
│   └── recipes.json           # recipe database with instructions & tags
│
├── supabase/
│   ├── schema.sql             # tables, keys, indexes, triggers
│   └── policies.sql           # Row Level Security policies
│
└── docs/
```

## Installation

No installation required. There is no `npm install`, no build step, and no server.

**Run locally:**

```bash
git clone https://github.com/YOUR-USERNAME/health-meal-planner.git
cd health-meal-planner
python3 -m http.server 8000   # or any static file server
# open http://localhost:8000
```

A static server is required only because the app uses `fetch()` to load the JSON data files — opening `index.html` directly via `file://` will block those requests in most browsers.

**Without configuring Supabase, the app works immediately as a guest-only app** — the auth screen still appears, but the Gmail/Outlook buttons are disabled with an explanatory note, and "Continue as Guest" gives you the full local experience for the current browser session (see [Guest Sessions](#guest-sessions)). Nothing breaks if you never touch `config.js`.

## Deployment to GitHub Pages

1. Push this repository to GitHub.
2. Go to **Settings → Pages** in your repository.
3. Under **Source**, select the `main` branch and the `/ (root)` folder.
4. Save. GitHub will publish the site at `https://YOUR-USERNAME.github.io/health-meal-planner/`.
5. That's it for guest mode — no build step, no secrets, nothing else to configure.
6. To enable sign-in and cloud sync, follow **Authentication Setup** below, then fill in `js/config.js` and redeploy (just commit the file — no build step).

The app automatically detects its own base path (works correctly whether deployed at `https://USERNAME.github.io/` or `https://USERNAME.github.io/REPOSITORY/`), so OAuth redirects work without extra configuration on the frontend side.

---

## Authentication Setup

This section is the step-by-step for enabling "Continue with Gmail" / "Continue with Outlook" sign-in and cloud sync. **Skipping this section is fine** — the app runs as a guest-only app without it.

> **Need the full click-by-click walkthrough?** See [`docs/oauth-setup.md`](docs/oauth-setup.md) for exact menu names and screens in Google Cloud Console and the Microsoft Entra admin center, plus a troubleshooting table for common errors (`redirect_uri_mismatch`, `AADSTS50011`, "works for me but not my teammate," etc.). The steps below are the condensed version.

> **Branding note:** the buttons read "Continue with Gmail" and "Continue with Outlook," but Gmail and Outlook are mail brands, not OAuth providers in their own right. Under the hood, "Continue with Gmail" authenticates via the standard **Google** OAuth provider (any Google/Gmail account), and "Continue with Outlook" authenticates via the standard **Microsoft/Azure AD** OAuth provider (any Microsoft/Outlook account). So everywhere below that says "Google" or "Azure," that's the underlying provider you're configuring in Supabase/Google Cloud Console/Azure Portal — none of those third-party consoles know about the "Gmail"/"Outlook" labels, which are purely a frontend (`index.html` / `js/auth.js`) presentation choice.

> **If you see "Unsupported provider: provider is not enabled"** when clicking Gmail/Outlook: this is Supabase's own server response, not an app bug — it means `SUPABASE_URL`/`SUPABASE_ANON_KEY` in `config.js` point at a real project, but the Google and/or Azure provider hasn't been switched on in that project's **Authentication → Providers** page yet (steps 3–4 below). You can check this yourself for any deployment with:
> ```bash
> curl "https://<your-project-ref>.supabase.co/auth/v1/settings" -H "apikey: <your-anon-key>"
> ```
> and looking at `external.google` / `external.azure` in the response. The app now does this check itself on page load (`auth.js`'s `getEnabledProviders()`) and disables whichever button isn't enabled instead of letting the click navigate the tab away to Supabase's raw error response — but until a provider is actually turned on here, its button stays disabled and "Continue as Guest" is the only way in.

### 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and create a free account.
2. Create a new project. Note your **Project URL** and **anon/public API key** (Project Settings → API) — you'll need these for step 8.

### 2. Configure authentication

In your Supabase project: **Authentication → Providers**.

### 3. Enable Google OAuth (powers "Continue with Gmail")

1. In [Google Cloud Console](https://console.cloud.google.com/), create (or reuse) a project → **APIs & Services → Credentials → Create Credentials → OAuth client ID** (type: Web application).
2. Add this **Authorized redirect URI** (Supabase's own callback, shown on the Supabase Google provider config page): `https://<your-project-ref>.supabase.co/auth/v1/callback`.
3. Copy the generated **Client ID** and **Client Secret** into Supabase's Google provider settings and enable it.

### 4. Enable Microsoft/Azure OAuth (powers "Continue with Outlook")

1. In the [Azure Portal](https://portal.azure.com/), go to **Azure Active Directory → App registrations → New registration**.
2. Add the same Supabase callback URL as a **Redirect URI** (Web platform): `https://<your-project-ref>.supabase.co/auth/v1/callback`.
3. Under **Certificates & secrets**, create a client secret. Copy the **Application (client) ID** and the secret into Supabase's Azure provider settings ("azure" provider) and enable it.

### 5. Configure redirect URLs

In Supabase: **Authentication → URL Configuration**.

- **Site URL**: your deployed app's base URL, e.g. `https://YOUR-USERNAME.github.io/health-meal-planner/`
- **Redirect URLs**: add both the production URL above and `http://localhost:8000/` (or whatever port you use locally) so local testing works too. Include the trailing slash to match `CONFIG.REDIRECT_URL` exactly.

### 6. Create the database

Open **SQL Editor** in Supabase, paste the contents of `supabase/schema.sql`, and run it.

### 7. Run the security policies

In the same SQL Editor, paste the contents of `supabase/policies.sql` and run it. This enables Row Level Security and creates the "users can only access their own rows" policies on every table — **do not skip this step**, it's what makes it safe to use the public anon key in the browser.

### 8. Configure the frontend

Edit `js/config.js`:

```javascript
const CONFIG = {
  SUPABASE_URL: 'https://your-project-ref.supabase.co',
  SUPABASE_ANON_KEY: 'your-anon-public-key',
  ...
};
```

Only use the **anon/public** key here — see [Security](#security) below.

### 9. Deploy to GitHub Pages

Commit `js/config.js` with your project's URL and anon key (safe to commit — see Security), push, and your GitHub Pages deployment now has working Gmail/Outlook sign-in and cloud sync.

---

## Guest Sessions

"Continue as Guest" is scoped to the **current browser session**, not remembered indefinitely:

- Guest data (profile, meal plan, shopping list, progress, chat/recipe log) is written to `sessionStorage` instead of `localStorage` — see `storage.js`'s `enterGuestSession()` / `claimGuestSessionForAccount()`. `sessionStorage` is tied to the browser tab's lifetime: it survives page refreshes, reloads, and navigation between `index.html` and `dashboard.html` (including the redirect round-trip of an OAuth sign-in), but **the browser clears it automatically once the tab/window is closed** — no app code has to run to wipe it, and it can't be recovered afterwards.
- Because of that, every guest session shows a persistent banner (`#guest-banner` in `dashboard.html`, rendered by `renderGuestBanner()` in `app.js`) reminding the guest to **Export JSON** or **Download PDF** before they close the browser, or sign in to keep their data permanently. A `beforeunload` handler (`wireGuestExitReminder()`) also triggers the browser's native "leave site?" confirmation if the guest has unsaved data, as a second line of defense — browsers show their own generic text there rather than a custom message, so the banner is the primary reminder.
- The login page (`index.html`) reappears on every new browser session — a guest is no longer "remembered" across a full browser restart the way the old `localStorage`-based `guestConfirmed` flag used to work. Returning within the same tab session (e.g. visiting `index.html` again, or refreshing `dashboard.html`) skips straight back into the app, since the session flag is still set: `index.html` redirects straight to `dashboard.html`, and `dashboard.html` itself just re-checks the same flag rather than bouncing back.
- Clicking "Continue as Guest" or completing a sign-in is a real page navigation to `dashboard.html` (`window.location`), not a `hidden`-attribute toggle within `index.html` — see [Architecture](#architecture).
- **If a guest signs in mid-session** (via the guest dropdown, Settings, or the auth screen), their session data is folded into the durable `localStorage` store first (`claimGuestSessionForAccount()`), then treated as "existing local data" by the normal first-login merge flow (see [How Cloud Sync Works](#how-cloud-sync-works)) — nothing is lost by signing in.
- Upgrading an older deployment: any guest data left over in `localStorage` from before this change is migrated into the new session-scoped store the next time "Continue as Guest" is clicked, then removed from `localStorage` (see `enterGuestSession()`'s one-time migration step) — it will still be cleared when that browser session ends unless exported.

---

## How Cloud Sync Works

- **Guest mode** (default, no sign-in): all data lives in `sessionStorage` only, for the current browser session — see [Guest Sessions](#guest-sessions).
- **Signed in**: `syncManager.js` performs a two-way sync on sign-in, after saving your profile, and on demand via **Settings → Cloud Sync → Sync Now**. Single-record data (profile, active meal plan, shopping list, settings) uses "latest `updated_at` wins." Progress (weight/calorie/water logs) merges **per entry, per date** — logging on your phone never erases something you logged on your laptop the same day.
- **First sign-in with existing local data**: if this browser already has guest data *and* your account already has cloud data, you're asked to **Merge Both** (recommended and default), **Keep Cloud Data**, or **Keep This Device's Data** — nothing is silently overwritten.
- **Offline**: the sync badge shows "Offline"; local changes keep working normally. Syncing resumes automatically when the connection returns.
- **Sync status**: shown as a badge in the top bar (Synced / Syncing / Sync Failed / Offline) and expanded in Settings → Cloud Sync.

## PDF Export

Every export happens **fully in the browser** using [jsPDF](https://github.com/parallax/jsPDF) + [jspdf-autotable](https://github.com/simonbengtsson/jsPDF-AutoTable), loaded via CDN — no backend PDF service. Available from the Dashboard, Profile, Meal Planner, Recipe Generator, Progress Tracker, and Settings:

- **Complete Health & Meal Report** — profile, nutrition summary, meal plan, shopping list, progress, and recommendations in one document.
- **Individual reports** — Profile, Current Meal Plan, Shopping List, a single Recipe, or Progress Report.

Every PDF includes the app name, your name (from your account or profile), the report date, and this notice: *"This report is for informational and meal-planning purposes only and is not medical advice."*

---

## How AI Integration Works

The app never bundles or hardcodes an AI API key. Every AI feature (Recipe Generator, AI meal plan, AI Coach) reads the provider, model and key you enter yourself in **Settings → AI Provider**, stored only in your browser's `localStorage` — **AI API keys are intentionally never synced to the cloud database**, even when you're signed in (see `cloudStorage.js`'s `saveSettings`, which strips it before writing).

`js/ai.js` is a single abstraction layer: every supported provider speaks an OpenAI-compatible `/chat/completions` schema, so swapping providers is a matter of changing one config object. If a request fails (missing key, network error, rate limit, malformed response), the error is caught and surfaced as a clear message rather than crashing the view — and the Meal Planner and Recipe Generator always have a local, offline-capable fallback so the app stays useful even with no key at all.

## Supported AI Providers

All are free-tier friendly, open-source-model providers — never OpenAI, never a paid-only API:

| Provider | Example free/open models |
|---|---|
| [OpenRouter](https://openrouter.ai/keys) | Llama 3.1 8B, Mistral 7B, Gemma 2 9B, Qwen 2.5 7B, DeepSeek (all `:free` variants) |
| [Groq](https://console.groq.com/keys) | Llama 3.1 8B Instant, Llama 3.3 70B Versatile, Gemma 2 9B |
| [Together AI](https://api.together.xyz/settings/api-keys) | Llama 3.3 70B Turbo (free), Qwen 2.5 7B Turbo |
| [Hugging Face Inference](https://huggingface.co/settings/tokens) | Llama 3.1 8B Instruct, Mistral 7B Instruct, Qwen 2.5 7B Instruct |

---

## Security

> ⚠️ **NEVER use the Supabase `service_role` key in this frontend application.** Only use the **public/anon key**, which is designed to be exposed in browser code. Row Level Security (`supabase/policies.sql`) is what actually protects your users' data — the anon key alone grants no access to anything.

- `js/config.js` only ever holds the anon key. Do not paste a `service_role` key into `index.html`, any `.js` file, or a committed `.env` — this repository has no server, so there is nowhere safe to use a service-role key at all.
- AI provider API keys entered by users stay in `localStorage` only; they are never sent to Supabase or included in JSON export.
- All Supabase tables have Row Level Security enabled with policies scoped to `auth.uid() = user_id` — enforced by PostgreSQL itself, not by client-side JavaScript.
- Destructive actions (Delete Local Data, Delete Cloud Data) always show a confirmation dialog first, and only delete the scope they claim to (local-only vs cloud-only never touches the other).
- **Account deletion**: fully deleting a user's Supabase Auth identity requires the `service_role` key, which by design cannot run from this static frontend. **Delete Cloud Data** removes every row this app wrote for the user, which in practice erases all their personal data; the underlying auth identity record itself would need to be removed by a project admin from the Supabase dashboard, or via a server-side function you control outside this repo. The app does not claim to delete the account itself — only the data.

## Privacy

- **Guest users**: data is stored only in this browser tab's session storage — nothing leaves the device, and it is cleared automatically once the browser is closed. See [Guest Sessions](#guest-sessions).
- **Authenticated users**: data is additionally synchronized to the Supabase cloud database, protected by Row Level Security so only that account can read or write it.
- **AI features**: using the Recipe Generator, AI Meal Plan, or AI Coach sends relevant profile details (e.g. weight, goals, allergies) to the AI provider you configured, directly from your browser. This data is not "100% private" once sent to that third party — review your chosen provider's own privacy policy.

## Screenshots

_placeholder — add screenshots of the Dashboard, Meal Planner, Recipe Generator and Progress Tracker here after deployment._

- `docs/screenshot-dashboard.png`
- `docs/screenshot-planner.png`
- `docs/screenshot-recipes.png`
- `docs/screenshot-progress.png`
- `docs/screenshot-auth-screen.png`

---

## Testing Checklist

### Authentication
- [ ] Gmail (Google OAuth) login completes and returns to the app signed in
- [ ] Outlook (Microsoft/Azure OAuth) login completes and returns to the app signed in
- [ ] Logout clears the session but leaves local and cloud data intact
- [ ] Session persists across a page refresh
- [ ] Closing the OAuth popup/tab without finishing shows a reasonable message, not a crash

### Guest Sessions
- [ ] Guest data persists across a page refresh (same tab)
- [ ] Auth screen reappears in a brand-new browser session (e.g. after fully closing and reopening the browser) — guest is not auto-remembered
- [ ] Guest banner and its Export/Download PDF buttons appear during a guest session and work
- [ ] Closing the tab with unsaved guest data triggers the browser's native confirmation prompt
- [ ] Signing in mid-guest-session (Gmail/Outlook) carries the guest's data into the account via the first-login merge flow, instead of losing it

### Local Storage
- [ ] Guest data persists across a refresh
- [ ] Authenticated local data persists across a refresh
- [ ] Data survives a schema migration (bump `CONFIG.SCHEMA_VERSION`, confirm old data still loads)

### Cloud
- [ ] Profile/meal plan/shopping list upload to Supabase after sign-in
- [ ] Data downloads correctly when signing in on a second browser/device
- [ ] "Sync Now" in Settings completes without error
- [ ] First-login conflict prompt appears when both local and cloud data exist, and all three choices (Merge/Keep Cloud/Keep Device) work
- [ ] Progress entries merge (not overwrite) when logged from two devices on different dates

### PDF
- [ ] Complete Report generates and downloads with all sections
- [ ] Meal Plan PDF matches the current plan
- [ ] Recipe PDF includes ingredients and instructions
- [ ] Shopping List PDF groups items by category
- [ ] Progress PDF includes weight/calorie tables

### Mobile
- [ ] Android Chrome — bottom tab bar, auth screen, dropdown menu
- [ ] iPhone Safari — same, plus Web Share API sheet on share buttons

### GitHub Pages
- [ ] App loads at the direct project URL (`/REPOSITORY/`), landing on the login page (`index.html`)
- [ ] Refreshing any view within `dashboard.html` doesn't 404 (views are hash-routed within that one page)
- [ ] Visiting `/REPOSITORY/dashboard.html` directly with no session/guest state redirects to the login page instead of showing a broken shell
- [ ] OAuth redirect returns to the correct sub-path (`index.html`), not the domain root, and then continues on to `dashboard.html`
- [ ] No secrets are visible in the deployed source (view page source / dev tools — only the anon key, never a service key)

---

## Roadmap

- Bahasa Malaysia localization (UI strings)
- Barcode/photo-based food logging
- Expanded regional cuisine databases (Indian, Chinese-Malaysian, Nyonya)
- Offline service worker for full offline installability (PWA)
- Weekly (not just daily) meal plan view with cloud history

## Known Limitations

- AI features require the user's own free API key; without one, AI Coach is unavailable and the Recipe Generator/Meal Planner fall back to the local database.
- Nutrition figures are estimates based on standard food composition data, not medical-grade measurements — the app is not a substitute for professional dietary or medical advice.
- Some AI providers may rate-limit free-tier keys; the app surfaces this as a clear error rather than failing silently.
- Imperial units are label-only in this version; all calculations remain in metric.
- Full Supabase Auth account deletion (removing the identity record itself, not just its data) cannot be performed safely from this static frontend — see [Security](#security).
- Recipe history sync (`recipes` table) is append-only by design; it doesn't currently sync deletions of individual saved recipes.

## Contribution Guide

1. Fork the repository and create a feature branch.
2. Keep the "no build step" constraint — plain HTML/CSS/ES Modules only.
3. Every new module should start with the same header-comment convention (Purpose / Inputs / Outputs / Depends on) used throughout `js/`.
4. Use `escapeHTML()` from `ui.js` for any user-provided string inserted into the DOM.
5. Any new Supabase table needs a matching Row Level Security policy in `supabase/policies.sql` — never ship a table without one.
6. Open a pull request describing the change and, for UI changes, include a screenshot.

## License

MIT License — see [LICENSE](./LICENSE).
