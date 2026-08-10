# 🥗 Health Meal Planning Agent

A production-ready, AI-powered health meal planning web application that runs **entirely in the browser** — no backend, no build step, no database. Deploy it straight to GitHub Pages and it works.

Built with a Malaysian-first food database (nasi lemak, laksa, roti canai, and more) alongside international staples, personalized calorie/macro science, and a swappable AI layer that runs on **free, open-source models** — never OpenAI, never a paid API.

---

## Table of Contents

- [Project Overview](#project-overview)
- [Features](#features)
- [Architecture](#architecture)
- [Folder Structure](#folder-structure)
- [Installation](#installation)
- [Deployment to GitHub Pages](#deployment-to-github-pages)
- [How AI Integration Works](#how-ai-integration-works)
- [Supported AI Providers](#supported-ai-providers)
- [Screenshots](#screenshots)
- [Roadmap](#roadmap)
- [Known Limitations](#known-limitations)
- [Future Improvements](#future-improvements)
- [Contribution Guide](#contribution-guide)
- [License](#license)

---

## Project Overview

Health Meal Planning Agent helps people plan healthy meals around **who they actually are**: their body, their goals, their budget, their cooking skill, and their culture. Every calorie and macro number is computed with standard, explained nutrition formulas (Mifflin-St Jeor, TDEE activity factors, IOM fiber guidelines) — never a black box.

The app works fully offline-capable for its core planning features (local recipe database + rule-based planner), and layers on optional AI for original recipe generation, AI-assisted meal plans, and a conversational nutrition coach — powered by whichever free AI provider you connect with your own API key.

## Features

- ✅ Dashboard — calorie rings, remaining calories, BMI, goal status, water reminder, today's meals, macro progress
- ✅ Profile — full health, lifestyle, allergy and preference intake, stored locally
- ✅ Calorie Calculator — BMR / TDEE / calorie target / macros / fiber / water, each with the formula explained
- ✅ Meal Planner — auto-generated daily plan (local, offline-capable) or AI-generated on demand
- ✅ Recipe Generator — AI-original recipes personalized to your profile, or a curated local pick if no API key is set
- ✅ Shopping List — auto-built from your meal plan, grouped by category, checkable, exportable, printable
- ✅ Progress Tracker — weight & calorie logs, Chart.js charts, weekly/monthly summaries, achievements
- ✅ AI Coach — chat-based nutrition Q&A, grounded in your profile
- ✅ Settings — theme, units, language, AI provider & key, import/export/clear data
- ✅ Dark mode / light mode
- ✅ Fully responsive (desktop, tablet, mobile with bottom tab bar)
- ✅ LocalStorage persistence — nothing ever leaves your device except direct calls to the AI provider you choose
- ✅ Share meal plans, recipes, shopping lists and progress via WhatsApp, Telegram, Facebook, Email, or copy

## Architecture

The app is a static single-page application. `index.html` is the shell; JavaScript ES Modules render each view into empty `<section>` containers on navigation. There is no framework, no bundler, and no build step — every file is loaded as-is by the browser.

```
┌─────────────┐     ┌───────────┐     ┌────────────┐
│  index.html │────▶│  app.js   │────▶│ router.js  │  (tab switching)
└─────────────┘     └─────┬─────┘     └────────────┘
                           │
     ┌─────────────┬───────┼───────┬─────────────┬─────────────┐
     ▼             ▼       ▼       ▼             ▼             ▼
 calorie.js   recipes.js shopping.js progress.js  ai.js      ui.js
     │             │       │           │           │           │
     └─────┬───────┴───────┴─────┬─────┴───────────┘        (shared:
           ▼                     ▼                            icons, toast,
     nutrition.js           storage.js                        modal, escaping)
     (pure formulas)     (localStorage abstraction)

  data.js — loads data/ingredients.json + data/recipes.json once, shared
  share.js — Web Share API + WhatsApp/Telegram/Facebook/Email/Copy fallbacks
```

Each module has a single, documented responsibility (see the header comment block at the top of every `.js` file for purpose/inputs/outputs/dependencies).

## Folder Structure

```
health-meal-planner/
│
├── index.html
├── README.md
├── LICENSE
│
├── css/
│   ├── styles.css        # layout, components, responsive rules
│   └── variables.css      # design tokens (color, type, spacing, dark mode)
│
├── js/
│   ├── app.js              # bootstrap; dashboard, profile, settings, AI coach views
│   ├── ui.js                # shared UI helpers (icons, toast, modal, escaping)
│   ├── router.js           # tab/view switching
│   ├── storage.js          # localStorage abstraction
│   ├── data.js               # loads/caches ingredients.json + recipes.json
│   ├── nutrition.js        # BMR/TDEE/macro/BMI/water formulas
│   ├── calorie.js           # Calorie Calculator view
│   ├── recipes.js           # recipe filtering, local + AI meal planning, recipe views
│   ├── shopping.js         # shopping list build/render/export/print
│   ├── progress.js         # weight/calorie/water logging, charts, achievements
│   ├── ai.js                  # swappable AI provider abstraction
│   └── share.js             # Web Share API + social fallback buttons
│
├── assets/
│   ├── icons/
│   └── images/
│
├── data/
│   ├── ingredients.json    # nutrition database (per 100g), Malaysian-inclusive
│   └── recipes.json          # recipe database with instructions & tags
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

## Deployment to GitHub Pages

1. Push this repository to GitHub.
2. Go to **Settings → Pages** in your repository.
3. Under **Source**, select the `main` branch and the `/ (root)` folder.
4. Save. GitHub will publish the site at `https://YOUR-USERNAME.github.io/health-meal-planner/`.
5. That's it — no build step, no secrets, nothing else to configure.

## How AI Integration Works

The app never bundles or hardcodes an API key. Every AI feature (Recipe Generator, AI meal plan, AI Coach) reads the provider, model and key you enter yourself in **Settings → AI Provider**, stored only in your browser's `localStorage`.

`js/ai.js` is a single abstraction layer: every supported provider speaks an OpenAI-compatible `/chat/completions` schema, so swapping providers is a matter of changing one config object — no other file needs to know which provider is active. If a request fails (missing key, network error, rate limit, malformed response), the error is caught and surfaced as a clear message rather than crashing the view — and the Meal Planner and Recipe Generator always have a local, offline-capable fallback so the app stays useful even with no key at all.

## Supported AI Providers

All are free-tier friendly, open-source-model providers — never OpenAI, never a paid-only API:

| Provider | Example free/open models |
|---|---|
| [OpenRouter](https://openrouter.ai/keys) | Llama 3.1 8B, Mistral 7B, Gemma 2 9B, Qwen 2.5 7B, DeepSeek (all `:free` variants) |
| [Groq](https://console.groq.com/keys) | Llama 3.1 8B Instant, Llama 3.3 70B Versatile, Gemma 2 9B |
| [Together AI](https://api.together.xyz/settings/api-keys) | Llama 3.3 70B Turbo (free), Qwen 2.5 7B Turbo |
| [Hugging Face Inference](https://huggingface.co/settings/tokens) | Llama 3.1 8B Instruct, Mistral 7B Instruct, Qwen 2.5 7B Instruct |

Add your key in Settings, pick a model, and every AI feature in the app starts working immediately.

## Screenshots

_placeholder — add screenshots of the Dashboard, Meal Planner, Recipe Generator and Progress Tracker here after deployment._

- `docs/screenshot-dashboard.png`
- `docs/screenshot-planner.png`
- `docs/screenshot-recipes.png`
- `docs/screenshot-progress.png`

## Roadmap

- Bahasa Malaysia localization (UI strings)
- Barcode/photo-based food logging
- Expanded regional cuisine databases (Indian, Chinese-Malaysian, Nyonya)
- Offline service worker for full offline installability (PWA)
- Weekly (not just daily) meal plan view

## Known Limitations

- AI features require the user's own free API key; without one, AI Coach is unavailable and the Recipe Generator/Meal Planner fall back to the local database.
- Nutrition figures are estimates based on standard food composition data, not medical-grade measurements — the app is not a substitute for professional dietary or medical advice.
- Some AI providers may rate-limit free-tier keys; the app surfaces this as a clear error rather than failing silently.
- Imperial units are label-only in this version; all calculations remain in metric.

## Future Improvements

- Editable/reorderable custom meal plans (drag-and-drop)
- Recipe photo generation
- Multi-day (weekly) shopping list aggregation
- Household/family profile support

## Contribution Guide

1. Fork the repository and create a feature branch.
2. Keep the "no build step" constraint — plain HTML/CSS/ES Modules only.
3. Every new module should start with the same header-comment convention (Purpose / Inputs / Outputs / Depends on) used throughout `js/`.
4. Use `escapeHTML()` from `ui.js` for any user-provided string inserted into the DOM.
5. Open a pull request describing the change and, for UI changes, include a screenshot.

## License

MIT License — see [LICENSE](./LICENSE).
