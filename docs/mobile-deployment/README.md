# Mobile deployment guide (Android → Google Play)

This is the master guide for building, testing and releasing the **Health Meal Planning Agent** Android app. Related documents:

| Document | Use it for |
|---|---|
| [google-play-compliance.md](google-play-compliance.md) | Policy checklist: what's done, what's still a blocker, what you must declare in Play Console |
| [testing-guide.md](testing-guide.md) | Every test command, plus the manual device test plan |
| [store-assets.md](store-assets.md) | Store listing checklist (texts, graphics, declarations) |
| [future-platforms.md](future-platforms.md) | What Apple App Store and Huawei AppGallery will need later |

> **Status:** the app builds, passes automated checks, and produces a valid signed AAB. It is **not yet ready for production release**: a privacy policy, the Supabase redirect URL, a real upload key, and the items marked BLOCKER in the compliance checklist need a person to complete them.

---

## 1. Architecture

```
meal-planner/
├── index.html, dashboard.html, css/, js/, data/   ← the web app: single source of truth (GitHub Pages)
├── supabase/                                      ← database schema, RLS policies, delete_my_account()
├── account-deletion.html                          ← public account-deletion page (Play "Delete account URL")
├── mobile/                                        ← Android app (Capacitor 8)
│   ├── capacitor.config.json   app id com.ch2digital.mealplannerai, splash, system bars
│   ├── src/native-bridge.js    the only mobile JS: OAuth via system browser, file saving, back button, share
│   ├── src/mobile.css          safe areas, 48dp touch targets — scoped to html.native-app
│   ├── scripts/                build-web, verify-aab, gradle, version bump, asset generation
│   ├── tests/                  Vitest suite (bridge, build, and the shared web modules)
│   ├── assets/                 icon / splash sources + Play Store graphics
│   ├── version.json            versionName + versionCode
│   ├── www/                    GENERATED copy of the web app (git-ignored)
│   └── android/                native Android project (Gradle)
├── .github/workflows/mobile-android.yml           ← CI
└── docs/mobile-deployment/                        ← you are here
```

**How it works.** The web app is a static, build-free ES-module app backed by Supabase (Auth + Postgres with Row Level Security). There is no other backend. The Android app is a [Capacitor](https://capacitorjs.com) WebView that runs the same files:

1. `npm run build:web` copies `index.html`, `dashboard.html`, `css/`, `js/` and `data/` into `mobile/www/`, unchanged.
2. The three CDN libraries (supabase-js, Chart.js, jsPDF + autoTable) are bundled locally at the exact versions the web pages request. The app works offline and loads no remote code. The build fails if the versions drift apart.
3. It injects `runtime-config.js` (per-environment Supabase URL/key and the OAuth deep link), `native/bridge.js` and `native/mobile.css`.
4. `npx cap sync android` copies `www/` into the Android project.

**What changed in the shared web code** (all no-ops in a normal browser):

| File | Change | Why |
|---|---|---|
| `js/config.js` | Reads optional `window.__HMPA_CONFIG__` overrides | Per-environment backend, native OAuth redirect, public share link |
| `js/auth.js` | In the app: PKCE + open the provider in the system browser | Google blocks OAuth inside embedded WebViews |
| `js/platform.js` (new) | `saveFile()` — browser download, or native save/share in the app | Android WebViews ignore `<a download>` |
| `js/app.js`, `js/shopping.js`, `js/pdf.js` | Use `saveFile()` (same download code on the web) | as above |
| `js/share.js` | Default link is `CONFIG.PUBLIC_URL` when set | App pages live at `https://localhost`, which is useless to recipients |
| `js/cloudStorage.js`, `js/app.js`, `supabase/delete_account.sql` | **New feature:** Settings → Delete Account (web and app) | Google Play account-deletion requirement |

Business rules, calculations, storage format, sync and RLS are untouched. `mobile/tests/web-business-logic.test.js` pins them.

**OAuth in the app.** Tap "Continue with Gmail" → `signInWithOAuth({ skipBrowserRedirect })` → the provider page opens in a Chrome Custom Tab → Supabase redirects to `com.ch2digital.mealplannerai://auth-callback?code=…` → Android hands that to the app → the bridge loads `./index.html?code=…` → supabase-js exchanges the code (PKCE), exactly where the web redirect would land → `authGate.js` forwards to the dashboard.

**Guest sessions in the app.** Guest data lives in WebView `sessionStorage`, as on the web. In the app that lasts until the app process ends (swiped away, or killed by Android), not until a browser tab closes. Pressing Back on the home screen backgrounds the app instead of closing it, so guest data survives normal use.

---

## 2. Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22 or newer (tested on 24) | `node -v` |
| JDK | 21 | Android Studio bundles one; or Microsoft/Temurin OpenJDK 21. Set `JAVA_HOME`. |
| Android SDK | Platform **36**, Build-Tools 36, Platform-Tools | Via Android Studio, or command-line tools (below) |
| Android Studio | Latest stable | Optional for CLI builds; needed for the emulator GUI and debugging |
| A Google Play Developer account | — | One-time US$25 registration |

Command-line SDK install (what was used to verify this setup on Windows):

```bash
# after unpacking commandlinetools into $ANDROID_HOME/cmdline-tools/latest
yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
```

Point Gradle at the SDK with `ANDROID_HOME`, or create `mobile/android/local.properties` (git-ignored):

```properties
sdk.dir=C\:/Users/you/AppData/Local/Android/Sdk
```

## 3. Local development

```bash
cd mobile
npm ci                     # install exact locked versions
npm run build:web          # build www/ for development
npx cap sync android       # copy www/ + plugins into android/
npx cap run android        # build, install and launch on a device/emulator
# or: npm run dev          # all three in one
```

After **any** change in `js/`, `css/`, `data/`, `index.html` or `dashboard.html`, re-run `npm run build:web && npx cap sync android`. The app never reads the repository files directly.

Debug the WebView: open `chrome://inspect` in desktop Chrome while a **debug** build runs. WebView debugging is off in release builds.

## 4. Android Studio setup

1. `cd mobile && npx cap open android` (or File → Open → `mobile/android`).
2. Let Gradle sync. If prompted, install SDK Platform 36.
3. Use the **app** run configuration. Build variants: `debug` (default) and `release`.
4. Don't let Android Studio "upgrade" the Android Gradle Plugin or Gradle on its own. Capacitor pins compatible versions (AGP 8.13, Gradle 8.14.3).

## 5. Emulator setup

```bash
sdkmanager "emulator" "system-images;android-36;google_apis_playstore;x86_64"
avdmanager create avd -n pixel_api36 -k "system-images;android-36;google_apis_playstore;x86_64" -d pixel_8
emulator -avd pixel_api36
```

Use a **Google Play** system image: Gmail sign-in needs a browser that supports Custom Tabs. Also create a small-screen device (e.g. `-d pixel_4a`, 5.8") and a tablet (`-d pixel_tablet`) for layout testing. On Windows, enable *Windows Hypervisor Platform* for acceleration.

## 6. Physical-device testing

1. On the phone: Settings → About phone → tap **Build number** 7 times → Developer options → enable **USB debugging**.
2. Connect via USB and accept the RSA prompt. `adb devices` should list it.
3. Install:
   ```bash
   cd mobile
   npm run android:debug
   adb install -r android/app/build/outputs/apk/debug/app-debug.apk
   ```
4. Wireless alternative (Android 11+): Developer options → Wireless debugging → `adb pair <ip:port>` then `adb connect <ip:port>`.

## 7. Environment configuration

Environment files live in `mobile/` and are git-ignored; only [`mobile/.env.example`](../../mobile/.env.example) is committed. It documents every variable.

| Variable | development | staging | production | Notes |
|---|---|---|---|---|
| `SUPABASE_URL` | optional (defaults to `js/config.js`) | **required**, https | **required**, https | |
| `SUPABASE_ANON_KEY` | optional | **required** | **required** | anon/publishable only; the build rejects `service_role`/`sb_secret_` keys |
| `PUBLIC_URL` | optional | optional | recommended | https URL of the hosted web app; used in shared links |
| `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | — | — | required to sign | environment variables / CI secrets only |
| `ANDROID_VERSION_CODE` | — | — | optional | overrides `version.json` (CI) |

```bash
cp .env.example .env.production   # then edit
npm run build:web:production      # fails loudly if the backend is missing or not https
```

Values in these files ship inside the app and are **not secret**. Never put a Supabase `service_role` key, an AI provider key, or signing passwords in them.

**Supabase redirect allow-list (required for sign-in in the app):** Supabase Dashboard → Authentication → URL Configuration → *Redirect URLs* → add

```
com.ch2digital.mealplannerai://auth-callback
```

Without it, Supabase falls back to the Site URL after sign-in and the user lands on the website instead of returning to the app. Google/Microsoft provider consoles need no change: their redirect URI remains Supabase's `/auth/v1/callback` (see [../oauth-setup.md](../oauth-setup.md)).

**Account deletion:** run `supabase/delete_account.sql` in the SQL Editor of **each** Supabase project the app points at.

## 8. Testing

See [testing-guide.md](testing-guide.md). Quick version:

```bash
cd mobile
npm run check          # ESLint + type check + 63 Vitest tests
npm run android:test   # on-device instrumented smoke tests (device/emulator required)
```

## 9. Android release build

```bash
cd mobile
npm run version:bump            # versionCode +1 (Play rejects reused codes); `-- 1.1.0` to change versionName
# set ANDROID_KEYSTORE_* (see Signing) and production env, then:
npm run android:release         # → android/app/build/outputs/bundle/release/app-release.aab
npm run verify:aab              # 16 automated checks; must say "All 16 checks passed"
```

The release build uses R8 minification and resource shrinking (`minifyEnabled`, `shrinkResources`). Upload `android/app/build/outputs/mapping/release/mapping.txt` with each release in Play Console (App bundle explorer → Downloads → *ReTrace mapping file*) to get readable crash stack traces. CI publishes it next to the AAB.

`verify:aab` checks: bundletool validation, applicationId, versionName/Code, targetSdk ≥ 36, not debuggable, backup disabled, cleartext disabled, permissions = INTERNET only, production https backend, OAuth redirect, no source maps, no remote scripts, no secret keys, and signed. If the signing certificate is the throwaway "TEST ONLY" key, it adds a 17th, failing check so a test-signed bundle can't be mistaken for a release.

## 10. Signing

Google Play uses **Play App Signing**: Google holds the *app signing key*; you sign uploads with your own *upload key*. If the upload key is lost or leaked, Google can reset it (Play Console → Setup → App integrity). The app signing key cannot be replaced.

Create the upload key **once**, store it in a password manager or secrets vault, and **never commit it** (`*.jks`, `*.keystore` are git-ignored):

```bash
keytool -genkeypair -v -keystore upload-keystore.jks -alias upload \
  -keyalg RSA -keysize 4096 -validity 10000
```

Build with it:

```bash
# macOS/Linux
export ANDROID_KEYSTORE_PATH=/secure/path/upload-keystore.jks
export ANDROID_KEYSTORE_PASSWORD='…' ANDROID_KEY_ALIAS=upload ANDROID_KEY_PASSWORD='…'
# Windows PowerShell
$env:ANDROID_KEYSTORE_PATH='C:\secure\upload-keystore.jks'; $env:ANDROID_KEYSTORE_PASSWORD='…'; $env:ANDROID_KEY_ALIAS='upload'; $env:ANDROID_KEY_PASSWORD='…'
```

Without these variables the release build is **unsigned** (Gradle prints a warning) and Play Console will reject it.

### CI/CD (GitHub Actions)

`.github/workflows/mobile-android.yml` runs on pushes/PRs that touch the app:

| Job | When | Does |
|---|---|---|
| `checks` | always | `npm ci`, lint, type check, tests |
| `android-debug` | always | debug APK + Android lint + instrumented-test APK compile; uploads `app-debug-apk` |
| `android-release` | push to `main` / manual run | production web build, signed AAB, `verify:aab`; uploads `app-release-aab` (+ `mapping.txt`). Skips with a warning if secrets are missing. |

Setup: repository Settings → Environments → **New environment `production`** (optionally require a reviewer). Add:

- **Secrets:** `ANDROID_KEYSTORE_BASE64` (`base64 -w0 upload-keystore.jks`, or in PowerShell `[Convert]::ToBase64String([IO.File]::ReadAllBytes('upload-keystore.jks'))`), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`
- **Variables:** `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `PUBLIC_URL`

CI sets `versionCode = <run number>0`, so every CI build is strictly higher than the last. Don't mix locally built and CI-built uploads unless your local `version.json` code is higher than every CI build already uploaded.

## 11. Google Play Console setup

1. **Create a developer account** at <https://play.google.com/console/signup>: choose *Personal* or *Organization* (an organization needs a D-U-N-S number), pay the fee, and complete identity verification. *TODO (owner): decide which account type.*
2. **Create app**: Home → *Create app* → name **Health Meal Planning Agent**, default language, *App*, *Free*, accept the declarations.
3. **Set up your app** (Dashboard → *Set up your app*). Complete every App content item using [google-play-compliance.md](google-play-compliance.md): privacy policy, app access, ads, content rating, target audience, data safety, government apps, financial features, **health apps**, and the account-deletion URL.
4. **Store listing**: [store-assets.md](store-assets.md).
5. **App integrity**: keep *Play App Signing* enabled (default). The first AAB upload registers your upload key.

## 12. Internal testing

1. Testing → **Internal testing** → *Testers* tab → create an email list (up to 100) → save → copy the **opt-in link**.
2. *Create new release* → upload `app-release.aab` → release name e.g. `1.0.0 (1)` → release notes → *Save* → *Review release* → *Start rollout to Internal testing*.
3. Testers open the opt-in link, accept, then install from Play (usually available within minutes).
4. Run the manual test plan in [testing-guide.md](testing-guide.md) **on a Play-installed build** (Play-signed, so it differs from your local build).
5. Check *Pre-launch report* (Testing → Pre-launch report) for crashes, accessibility and security warnings.
6. Fix issues → `npm run version:bump` → rebuild → upload a new release. Repeat until clean.

## 13. Closed testing

1. Testing → **Closed testing** → *Create track* (or use *Alpha*) → *Testers*: an email list or Google Group → copy the opt-in link.
2. Create a release from the AAB you validated internally (Promote release, or upload) → *Start rollout to Closed testing*.
3. **Personal developer accounts created after 13 November 2023:** before you can apply for production access, you must run a closed test with **at least 12 testers who have been opted in continuously for at least the last 14 days**. Testers who opt out reset nothing for the others, but someone who leaves no longer counts. Recruit **15–20** testers so the count stays at 12 or more. Organization accounts are exempt. Confirm the current numbers in Play Console's dashboard, which shows the live requirement and your progress.
4. Ask testers to **use** the app during those 14 days. Google asks about tester engagement in the production application.
5. Collect feedback in one place, e.g. a shared form. Testers can also send private feedback through the Play Store listing. Record every issue with device, Android version, steps, and the fix version.
6. Fix production-blocking issues and ship updated closed-test builds. Updating the build does not reset the 14-day clock.

## 14. Production access

For personal accounts under the testing requirement: Dashboard → **Apply for production** (enabled once 12+ testers / 14 days is met). Answer the questions about your closed test, the feedback you received and what you changed, and production readiness. Review typically takes up to about 7 days. Organization accounts can go straight to a production release.

## 15. Store listing

Grow → **Main store listing**. Every field, size limit and TODO is in [store-assets.md](store-assets.md).

## 16. Production release

1. Production → *Create new release* → add the AAB (promote the closed-test build you validated).
2. *Countries/regions*: *TODO (owner)*. Malaysia is the obvious first market given the food database.
3. Prefer a **staged rollout** (e.g. 10% → 50% → 100%) so problems can be halted.
4. *Review release* → fix any errors or warnings → *Start rollout to Production* → submit for review (hours to several days; first releases often take longer).

## 17. Post-release monitoring

- **Android vitals** (Quality → Android vitals): watch the crash rate and ANR rate. Google's bad-behaviour thresholds are 1.09% user-perceived crash rate and 0.47% user-perceived ANR rate; staying above them reduces visibility.
- **Crashes & ANRs** with the uploaded `mapping.txt` for readable traces.
- **Ratings & reviews**: reply, and spot regressions.
- **Policy status / Inbox**: policy emails have deadlines, and a missed one can lead to removal.
- **Target API**: every year Google raises the required `targetSdk`, usually with an August 31 deadline. Bump `variables.gradle` (via a Capacitor upgrade) in time.
- **Supabase**: Auth logs for sign-in failures (wrong redirect URL, provider disabled).

## 18. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| After Gmail/Outlook sign-in the browser shows the website instead of returning to the app | `com.ch2digital.mealplannerai://auth-callback` is missing from Supabase *Redirect URLs* (§7) |
| "Outlook sign-in is not enabled for this deployment" | The Azure provider isn't enabled in this Supabase project ([../oauth-setup.md](../oauth-setup.md)) |
| Google shows `403 disallowed_useragent` | OAuth ran inside the WebView: `window.HMPANative` missing → `www/` not rebuilt or synced (`npm run build:web && npx cap sync android`) |
| Delete Account: "not set up on the server yet" | Run `supabase/delete_account.sql` in that Supabase project |
| Export/PDF does nothing | Old build without `js/platform.js` → rebuild and sync |
| `build-web` error: "web app loads @x from the CDN but mobile/package.json has y" | Someone changed a CDN version in `index.html`/`dashboard.html`. Install the same exact version in `mobile/` |
| `SDK location not found` | Set `ANDROID_HOME` or create `android/local.properties` (§2) |
| Gradle: unsupported Java version | Use JDK 21 (`JAVA_HOME`) |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | The installed app was signed with a different key (e.g. Play build vs local) → `adb uninstall com.ch2digital.mealplannerai` |
| Play Console: "Version code 1 has already been used" | `npm run version:bump`, rebuild |
| Play Console: "You uploaded an APK or Android App Bundle that is signed with a different key" | Use the upload key registered in App integrity, or request an upload key reset |
| Content hidden under the status/navigation bar | Built from an old `www/` without `native/mobile.css`, or a new layout element lacks a safe-area rule in `mobile/src/mobile.css` |

## 19. Future Apple deployment

Add `@capacitor/ios` and `npx cap add ios`. The web layer and bridge are platform-neutral. See [future-platforms.md](future-platforms.md#apple-app-store) for the full list (Sign in with Apple requirement, privacy manifest, App Store Connect).

## 20. Future Huawei deployment

Huawei devices without Google Mobile Services can run the same Capacitor APK, since nothing depends on Google Play Services. The open questions are Gmail sign-in and the AppGallery listing. See [future-platforms.md](future-platforms.md#huawei-appgallery).
