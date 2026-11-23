# Google Play store assets checklist

Everything Play Console asks for in the store listing and App content. Drafts below come **only** from what the app actually does (README, code). Anything about the business, legal terms or data practices is marked **TODO** for a human to confirm. Do not publish TODO text.

| Item | Requirement (Play Console) | Status | Value / location |
|---|---|---|---|
| App name | ≤ 30 characters | ⚠️ confirm | **Health Meal Planning Agent** (26). Also the launcher label (`android/app/src/main/res/values/strings.xml`). *TODO (owner): confirm the name and check for trademark conflicts.* |
| Short description | ≤ 80 characters | ⚠️ draft | *Draft:* "Plan meals, calculate calories and track progress, with Malaysian food built in." (79) *TODO: approve.* |
| Full description | ≤ 4000 characters; no keyword stuffing, no medical claims | ⚠️ draft | See the draft below. *TODO: approve.* |
| App icon | 512 × 512 PNG, 32-bit, ≤ 1 MB | ✅ generated | `mobile/assets/store/icon-512.png` (brand leaf on #2F5233). *TODO (design): optional review.* |
| Feature graphic | 1024 × 500 PNG/JPEG, no transparency | ⚠️ placeholder | `mobile/assets/store/feature-graphic-1024x500.png` (brand mark only). *TODO (design): replace with a designed graphic.* |
| Phone screenshots | 2–8, 16:9 or 9:16, each side 320–3840 px | ❌ TODO | Capture from a real device/emulator running the release build: `adb exec-out screencap -p > shot1.png`. Suggested: Dashboard, Profile, Meal Planner, Recipe, Shopping list, Progress chart, AI Coach, Settings. Use realistic sample data, never real users' data. |
| 7" and 10" tablet screenshots | Optional, but needed to be featured for tablets | ❌ TODO | The app has a tablet (sidebar) layout. Capture from the Pixel Tablet emulator. |
| Privacy policy URL | Required | ❌ **BLOCKER** | *TODO (owner/legal)*, see [google-play-compliance.md](google-play-compliance.md) #1. |
| Account deletion URL | Required (the app has accounts) | ⚠️ | `https://<GitHub Pages host>/account-deletion.html`. *TODO: publish and add a support contact.* |
| Support email | Required, public | ❌ TODO (owner) | — |
| Website | Optional | ⚠️ | The GitHub Pages URL of the web app. *TODO: confirm.* |
| Phone number | Optional | — | Leave blank unless the business wants it. |
| Category | App or Game + category | ⚠️ draft | App → **Health & Fitness** (alternative: Food & Drink). *TODO: choose.* |
| Tags | Up to 5, from Google's list | ⚠️ draft | e.g. Nutrition, Diet, Meal planner, Calorie counter, Recipes, whichever appear in Console's list. *TODO.* |
| Content rating | IARC questionnaire | ❌ TODO | Compliance #10. Answer accurately about AI chat and unmoderated generated text. |
| Target audience | Age groups | ❌ TODO | Recommended 18+. Compliance #11. |
| Data safety | Form | ❌ TODO | Draft answers in compliance #3. |
| Health apps declaration | Form | ❌ TODO | Compliance #4. |
| Ads | Declaration | ✅ | No ads. |
| App access (reviewer instructions) | Required when any feature needs login or keys | ⚠️ draft | See the draft below. |
| Countries / regions | Selection | ❌ TODO (owner) | Malaysia is the natural first market given the food database. Confirm. |
| Pricing | Free / paid | ✅ draft | **Free** (no billing in the app). Switching from free to paid is impossible later. |
| Contains ads / in-app purchases badges | Derived | ✅ | Neither. |
| Release notes | Per release, ≤ 500 chars per language | ⚠️ | e.g. "First release." per version. |

## Draft full description (TODO: owner review)

> Health Meal Planning Agent helps you plan meals and hit your nutrition goals, with a food and recipe database that includes Malaysian favourites like nasi lemak, laksa and roti canai alongside international staples.
>
> • Calorie calculator: daily calorie, macro (protein, fat, carbs) and water targets based on your age, height, weight, activity level and goal, with the formulas explained.
> • Meal planner: daily plans that fit your targets, diet preference and allergies.
> • Recipes: browse recipes with full nutrition, or generate new ones with AI.
> • Shopping list: built from your plan, grouped and ready to check off.
> • Progress tracker: log weight, calories and water and see your trends.
> • AI coach: ask nutrition questions and get answers personalised to your profile.
> • PDF reports and export: download or share your plan, shopping list and progress.
>
> Use it as a guest with no account, or sign in with Gmail or Outlook to sync across your devices and the web.
>
> AI features use your own free API key from a provider you choose (OpenRouter, Groq, Together AI or Hugging Face). When you use them, the relevant profile details are sent to that provider.
>
> This app provides general nutrition information for meal planning. It is not medical advice and does not replace a doctor or dietitian.

Check before publishing: no "best", "#1", "clinically proven", or treatment/cure claims. Mention only features that work in the release build.

## Draft reviewer access instructions (App content → App access)

> All core features (profile, calorie calculator, meal planner, recipes, shopping list, progress tracker, PDF/export) work without an account: tap **Continue as Guest** on the first screen.
>
> Cloud sync needs sign-in with **Continue with Gmail** (any Google account works, including the reviewer's). *[If Outlook is disabled in production, add: "Outlook sign-in is not enabled in this release."]*
>
> AI Recipe Generator, AI Meal Plan and AI Coach need an AI provider API key, entered in Settings → AI Provider. *TODO (owner): either provide a dedicated, rate-limited reviewer key here (never commit it to the repository), or state that free keys can be created at https://openrouter.ai/keys.*
>
> Account deletion: Settings → Your data → Delete Account (type DELETE).
