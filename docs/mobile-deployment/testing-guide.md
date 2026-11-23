# Mobile testing guide

All commands run from `mobile/` unless noted. Windows users: use PowerShell or Git Bash; the npm scripts are cross-platform.

## Commands

| Task | Command |
|---|---|
| Install dependencies | `npm ci` |
| Development mode (build, sync, run on device/emulator) | `npm run dev` |
| Rebuild web bundle only | `npm run build:web` (or `build:web:staging`, `build:web:production`) |
| Unit + integration tests (Vitest) | `npm test` (watch mode: `npm run test:watch`) |
| Linting | `npm run lint` |
| Type checks (`tsc --checkJs`) | `npm run typecheck` |
| All three | `npm run check` |
| Android lint | `node scripts/gradle.mjs lintDebug` |
| Build debug APK | `npm run android:debug` → `android/app/build/outputs/apk/debug/app-debug.apk` |
| Build release AAB | `npm run android:release` → `android/app/build/outputs/bundle/release/app-release.aab` |
| Build release APK (sideload testing only) | `npm run android:release:apk` |
| Verify the AAB | `npm run verify:aab` |
| Install debug build on a physical device | `adb install -r android/app/build/outputs/apk/debug/app-debug.apk` |
| Emulator / device instrumented tests | start an emulator (`emulator -avd pixel_api36`) or connect a device, then `npm run android:test` |
| Production artifacts (CI-equivalent) | `npm ci && npm run check && npm run android:release && npm run verify:aab` with production env + signing variables set (see [README §7, §10](README.md#7-environment-configuration)) |
| Install a release AAB on a device (exactly what Play would install) | `java -jar node_modules/.cache/bundletool-all-1.18.1.jar build-apks --bundle=android/app/build/outputs/bundle/release/app-release.aab --output=app.apks --connected-device --ks=<upload.jks> --ks-key-alias=upload` then `java -jar … install-apks --apks=app.apks` (the jar is downloaded by `verify:aab`) |

The "integration" tests are the Vitest files that drive the real shared web modules (`tests/web-*.test.js`) and the build pipeline (`tests/build-web.test.js`) together; the on-device ones are the instrumented tests.

## Automated coverage

| Suite | File | Covers |
|---|---|---|
| Build pipeline | `tests/build-web.test.js` | CDN → local vendoring, version-drift guard, no remote scripts, tag injection order |
| Environments | `tests/env.test.js` | production requires an https backend; rejects `service_role`/secret keys; dev fallback |
| Native bridge | `tests/native-bridge.test.js` | OAuth deep-link routing (warm and cold start, no redirect loop), back-button order, native file save, share polyfill |
| Auth (shared) | `tests/web-auth.test.js` | web OAuth unchanged; app uses PKCE + system browser; error messages; local sign-out |
| Platform/config (shared) | `tests/web-platform-config.test.js` | browser download path unchanged; native save; cancel vs failure; runtime config overrides |
| Account deletion | `tests/web-account-deletion.test.js` | RPC call, setup-missing message, SQL restricted to `auth.uid()`, cascade on every table |
| Business logic (shared) | `tests/web-business-logic.test.js` | BMR/TDEE/targets/macros/BMI values; persistence; export never includes the API key; import merge; guest → account claim |
| Module graph | `tests/web-module-graph.test.js` | `app.js` / `authGate.js` and every module they import load without errors |
| On device | `android/app/src/androidTest/.../AppSmokeTest.java` | package id; launch → background → foreground → recreate (rotation); deep link resolves to the app; web assets + runtime config packaged; backup disabled |
| Release artifact | `scripts/verify-aab.mjs` | 16 checks: bundle validity, ids/versions, target SDK, permissions, https, no secrets/maps/remote code, signing (+ a failing guard if signed with a test key) |

## Manual device test plan

Run on **(a)** a physical phone, **(b)** a small emulator (≈5"), **(c)** a tablet emulator, at least one of them on Android 16 (API 36) and one on an older version (e.g. Android 10). Before production, repeat on a **Play-installed internal-testing build**. Record pass/fail, device and build per row.

| # | Area | Steps | Expected | Automated? |
|---|---|---|---|---|
| 1 | Startup | Cold-start the app (also in airplane mode) | Green splash → login screen within ~2 s; offline still shows the login page and guest mode works | Partly (`AppSmokeTest`) |
| 2 | Login (Gmail) | Continue with Gmail → choose account | Custom Tab opens (not inside the app) → returns to the app → dashboard, avatar/name in the user menu | Partly (bridge + auth tests) |
| 2b | Login (Outlook) | Same with Outlook (if enabled) | Same; if not enabled, the button is greyed out with a note | — |
| 2c | Login cancelled | Start sign-in, close the Custom Tab | Back on the login screen, no crash, can retry | — |
| 3 | Logout | User menu → Sign Out → confirm | Back to the login screen; local data kept on device | — |
| 4 | Registration | ➖ No separate registration: first OAuth sign-in creates the account | — | — |
| 5 | Password reset | ➖ No passwords (OAuth only) | — | — |
| 6 | Main navigation | Bottom tab bar, ☰ drawer, every view | Every view renders; the active tab is highlighted | Smoke test |
| 7 | Workflows | Profile save → dashboard targets; Calorie Calculator; generate a meal plan (local); recipe browse; add to shopping list, check items; log weight/water/calories; AI Coach with a valid key; Settings changes | All behave exactly as on the web | Business-logic tests |
| 7b | Exports | Export JSON, Export CSV, Download PDF (complete, profile, meal plan, shopping, progress, recipe), shopping list text/JSON | Android share sheet opens with the file; saving to Files/Drive gives a valid file | Partly |
| 7c | Import | Settings → Import Data → pick an exported JSON | File picker opens; preview modal; merge works | — |
| 7d | Delete account | Signed in → Settings → Delete Account → type DELETE | Account and cloud data gone (check the Supabase table editor); back to login; signing in again gives an empty account | Partly |
| 8 | API communication | Sign in, edit profile, Sync Now | Badge "Synced"; data visible on the web app with the same account | — |
| 9 | Invalid API responses | Set a wrong AI key; use AI Coach | Friendly "API key was rejected" toast; no crash | Error mapping is unit-level in `js/ai.js` |
| 10 | Network interruption | Turn off network mid-sync / mid-AI request; turn back on | "Offline" toasts; sync resumes on reconnect; AI shows a network error | — |
| 11 | Slow network | Emulator → Extended controls → Cellular → *EDGE* / *Poor* signal | Loading states visible; AI request times out after 30 s with a message | — |
| 12 | Empty states | Fresh install, guest | Dashboard "Set up my profile"; empty shopping list/progress states | — |
| 13 | Error states | Supabase down (wrong URL in a staging build) | App runs in local mode; sign-in reports an error | — |
| 14 | Form validation | Profile with missing weight/height/age | "Please fill in weight, height and age." | — |
| 15 | Keyboard | Focus every input (profile, AI coach, settings key) | Field scrolls above the keyboard; no zoom-on-focus; tab bar not covering inputs; Done/Next keys work | — |
| 16 | Android back | Modal open → Back; user menu open → Back; drawer open → Back; on Recipes → Back; on Dashboard → Back; on the login page → Back; gesture navigation and 3-button | Closes modal → menu → drawer → goes to Dashboard → backgrounds the app (doesn't kill it) | Bridge unit tests |
| 17 | Rotation | Rotate on every view, with a modal open | Layout adapts; no data loss; no reload | `AppSmokeTest` (recreate) |
| 18 | Screen sizes | Small phone, large phone, tablet, split-screen, font size *Largest*, display size *Largest* | No clipped controls; content not under the status or navigation bars; tablet shows the sidebar layout | — |
| 19 | Permissions | Settings → Apps → app → Permissions | No runtime permissions requested at any point | `verify:aab` |
| 20 | Background/foreground | As a guest with data: Home → open another app → return; also leave it for 30 min | Same screen and data; a guest session survives backgrounding | `AppSmokeTest` (lifecycle) |
| 20b | Process death | Developer options → *Don't keep activities*, or `adb shell am kill com.ch2digital.mealplannerai` while backgrounded | Signed-in: data intact. Guest: session data is cleared (expected, documented) | — |
| 21 | Session expiration | Signed in, leave >1 h offline, then reconnect | Token refreshes silently; if revoked (e.g. Supabase → Users → sign out user), next sync fails gracefully and sign-in is offered | — |
| 22 | Data persistence | Signed in: add data → force-stop → reopen | Data present | Storage tests |
| 23 | Security-sensitive | Export JSON → confirm no API key in the file; after Delete Account the old data isn't restorable; `adb backup` / Auto Backup excludes app data; release build not debuggable (`chrome://inspect` shows nothing) | As stated | Partly (tests, `verify:aab`) |
| 24 | Upgrade from previous version | Install version N from internal testing, create data, then install N+1 (Play update or `adb install -r`) | Data kept; `runMigrations()` upgrades the schema; still signed in | — (do it for every release) |
| 25 | Deep link abuse | `adb shell am start -a android.intent.action.VIEW -d "com.ch2digital.mealplannerai://auth-callback?code=bogus"` | App opens; sign-in fails cleanly; no crash | Bridge unit tests |
| 26 | Share | Share a recipe, plan or progress | Android share sheet with the text (+ public link if `PUBLIC_URL` is set) | Bridge unit tests |
| 27 | Accessibility | TalkBack through login, tab bar, user menu, settings | Every control announced with a label | Pre-launch report |
| 28 | Dark mode | System dark theme; in-app theme toggle | Readable; splash stays on-brand | — |

## Results log (2026-11-23, local Windows build)

| Check | Result |
|---|---|
| `npm run lint` / `typecheck` / `test` | ✅ clean / ✅ clean / ✅ 63 passed |
| `assembleDebug`, `assembleDebugAndroidTest`, `lintDebug` | ✅ (2 harmless warnings) |
| `android:release` (signed with a throwaway test key) + `verify:aab` | ✅ 16/17. Expected failure: test key |
| Headless Chrome smoke test of the packaged bundle (390 px wide) and the web app | ✅ guest flow, 9 views, export; 0 JS errors |
| Instrumented tests on an emulator or device | ⏳ **not run**: no emulator or device available |
| Manual device test plan | ⏳ **not run** |
