# 🥗 Health Meal Planning Agent

A production-ready, AI-powered health meal planning web application that runs **entirely in the browser** — no custom backend, no build step, no VPS. Deploy it straight to GitHub Pages and it works, with optional cloud sign-in and sync layered on top via Supabase's free tier.

Built with a Malaysian-first food database (nasi lemak, laksa, roti canai, and more) alongside international staples, personalized calorie/macro science, a swappable AI layer on free open-source models, optional Google/Microsoft sign-in with cross-device cloud sync, and in-browser PDF report generation.

---

## Table of Contents

- [Project Overview](#project-overview)
- [Features](#features)
- [Architecture](#architecture)
- [Folder Structure](#folder-structure)
- [Installation](#installation)
- [Deployment to GitHub Pages](#deployment-to-github-pages)
- [Authentication Setup](#authentication-setup)
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

The app works fully offline-capable for its core planning features (local recipe database + rule-based planner) as a guest, with **no account required**. Signing in with Google or Microsoft adds cross-device cloud sync on top, backed by a Supabase PostgreSQL database with Row Level Security, without changing anything about how the app is hosted (still 100% static, still GitHub Pages).

## Features

- ✅ Dashboard — calorie rings, remaining calories, BMI, goal status, water reminder, today's meals, macro progress, sync status
- ✅ Profile — full health, lifestyle, allergy and preference intake, stored locally (and in the cloud if signed in)
- ✅ Calorie Calculator — BMR / TDEE / calorie target / macros / fiber / water, each with the formula explained
- ✅ Meal Planner — auto-generated daily plan (local, offline-capable) or AI-generated on demand
- ✅ Recipe Generator — AI-original recipes personalized to your profile, or a curated local pick if no API key is set
- ✅ Shopping List — auto-built from your meal plan, grouped by category, checkable, exportable, printable
- ✅ Progress Tracker — weight & calorie logs, Chart.js charts, weekly/monthly summaries, achievements
- ✅ AI Coach — chat-based nutrition Q&A, grounded in your profile
- ✅ **Authentication** — Google & Microsoft sign-in via Supabase Auth, or continue as a guest
- ✅ **Cloud Sync** — two-way sync between this device and your account, with offline queuing and conflict handling
- ✅ **PDF Export** — Complete Report, Profile, Meal Plan, Shopping List, Progress, and individual Recipe reports, generated fully in-browser
- ✅ JSON/CSV export & JSON import with a preview + merge/replace confirmation step
- ✅ Settings — theme, units, language, AI provider & key, account, cloud sync controls, data management, privacy notice
- ✅ Dark mode / light mode
- ✅ Fully responsive (desktop, tablet, mobile with bottom tab bar)
- ✅ Share meal plans, recipes, shopping lists and progress via WhatsApp, Telegram, Facebook, Email, or copy

## Architecture

The app is a static single-page application. `index.html` is the shell; JavaScript ES Modules render each view into empty `<section>` containers on navigation. There is no framework, no bundler, and no build step — every file is loaded as-is by the browser.

```
                         index.html
                             │
                           app.js  ── auth gate, user menu, onboarding, dashboard/profile/settings/coach
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
├── index.html
├── README.md
├── LICENSE
│
├── css/
│   ├── styles.css          # layout, components, responsive rules, auth screen, user menu
│   └── variables.css       # design tokens (color, type, spacing, dark mode)
│
├── js/
│   ├── app.js               # bootstrap; auth gate, dashboard, profile, settings, AI coach, onboarding
│   ├── ui.js                 # shared UI helpers (icons, toast, modal, escaping)
│   ├── router.js            # tab/view switching
│   ├── config.js             # Supabase URL/anon key placeholders (fill in your own — see below)
│   ├── auth.js                # Supabase Auth: Google/Microsoft sign-in, session, listeners
│   ├── storage.js            # localStorage abstraction, versioned schema + migrations
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

**Without configuring Supabase, the app works immediately as a guest-only app** — the auth screen still appears, but Google/Microsoft buttons are disabled with an explanatory note, and "Continue as Guest" gives you the full local experience. Nothing breaks if you never touch `config.js`.

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

This section is the step-by-step for enabling Google/Microsoft sign-in and cloud sync. **Skipping this section is fine** — the app runs as a guest-only app without it.

### 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and create a free account.
2. Create a new project. Note your **Project URL** and **anon/public API key** (Project Settings → API) — you'll need these for step 8.

### 2. Configure authentication

In your Supabase project: **Authentication → Providers**.

### 3. Enable Google OAuth

1. In [Google Cloud Console](https://console.cloud.google.com/), create (or reuse) a project → **APIs & Services → Credentials → Create Credentials → OAuth client ID** (type: Web application).
2. Add this **Authorized redirect URI** (Supabase's own callback, shown on the Supabase Google provider config page): `https://<your-project-ref>.supabase.co/auth/v1/callback`.
3. Copy the generated **Client ID** and **Client Secret** into Supabase's Google provider settings and enable it.

### 4. Enable Microsoft/Azure OAuth

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

Commit `js/config.js` with your project's URL and anon key (safe to commit — see Security), push, and your GitHub Pages deployment now has working Google/Microsoft sign-in and cloud sync.

---

## How Cloud Sync Works

- **Guest mode** (default, no sign-in): all data lives in `localStorage` only, via `storage.js`.
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

- **Guest users**: data is stored only in this browser's local storage. Nothing leaves the device.
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
- [ ] Google login completes and returns to the app signed in
- [ ] Microsoft login completes and returns to the app signed in
- [ ] Logout clears the session but leaves local and cloud data intact
- [ ] Session persists across a page refresh
- [ ] Closing the OAuth popup/tab without finishing shows a reasonable message, not a crash

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
- [ ] App loads at the direct project URL (`/REPOSITORY/`)
- [ ] Refreshing any view doesn't 404 (this is a single `index.html`, so it should always work)
- [ ] OAuth redirect returns to the correct sub-path, not the domain root
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
