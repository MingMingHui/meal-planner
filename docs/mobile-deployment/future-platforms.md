# Future platforms: Apple App Store and Huawei AppGallery

Nothing Apple- or Huawei-specific has been added yet. The architecture keeps both cheap to add:

- **All app behaviour lives in the shared web app** (`js/`), which knows nothing about Android. It only checks `window.HMPANative` for the two capabilities that differ inside a native shell: opening OAuth in the system browser, and saving a file.
- **`mobile/src/native-bridge.js` uses only cross-platform Capacitor plugins** (App, Browser, Filesystem, Share, Splash Screen), and every one of them supports iOS. The OAuth deep link is derived from the app id (`<appId>://auth-callback`), not hard-coded for Android.
- **No Google Play Services dependency**: no Firebase, FCM, Play Billing, Play Integrity or Google Sign-In SDK. Sign-in goes through Supabase in the system browser.
- **Configuration is per-environment and platform-neutral** (`scripts/env.mjs` → `window.__HMPA_CONFIG__`).

## Platform-specific areas

| Area | Today (Android) | Apple App Store | Huawei AppGallery |
|---|---|---|---|
| Push notifications | Not used | APNs (`@capacitor/push-notifications`), push entitlement | No FCM on HMS devices → Huawei Push Kit (HMS Core) |
| Authentication providers | Gmail (Google) + Outlook (Microsoft) via Supabase, system browser + PKCE | **App Review Guideline 4.8**: apps offering third-party social login must also offer an equivalent privacy-focused option, i.e. **Sign in with Apple** (Supabase supports the `apple` provider). Needs an Apple Services ID and key | Google sign-in works on HMS devices only if a browser is installed and the user has a Google account. Consider *HUAWEI ID* (via a custom OIDC provider) for HMS-only markets |
| In-app purchases | None | If ever added: Apple In-App Purchase is mandatory for digital goods | If ever added: Huawei IAP Kit |
| Maps | Not used | — | — (HMS Map Kit if ever needed) |
| Analytics / crash reporting | None | Declare any you add in App Privacy and the privacy manifest | Declare in AppGallery's privacy questionnaire |
| Device APIs | Filesystem (private cache), Share sheet, Custom Tabs, back button | Same plugins; Back button doesn't exist (swipe-back is WebView history, which the hash router doesn't use, so there's no change); `Browser` uses `SFSafariViewController` | Same as Android (AOSP APIs) |
| App signing | Upload key + Play App Signing | Apple Distribution certificate + provisioning profile (Xcode automatic signing) | AppGallery signs with its own key (*App signing* service) or your key; generate a separate upload key |
| Store metadata | `store-assets.md` | App Store Connect: name ≤ 30, subtitle ≤ 30, keywords ≤ 100, 6.9"/6.5" iPhone screenshots (+ iPad if supported), privacy policy URL, support URL, **App Privacy "nutrition labels"**, age rating, review notes + demo access | AppGallery Connect: similar listing, privacy statement, rating, and (for China) a software copyright certificate and ICP filing |
| Platform permissions | INTERNET only | No runtime permissions needed. `PrivacyInfo.xcprivacy` must declare *required-reason APIs* (e.g. UserDefaults, file timestamps used by Capacitor/plugins; Capacitor ships its own manifest) and collected data types | Same manifest as Android; HMS Core permissions only if HMS kits are added |
| Account deletion | In-app + web link | Required by Guideline 5.1.1(v): the existing **Delete Account** flow satisfies it. Also **revoke the Sign in with Apple token** on deletion (needs a server-side call, e.g. a Supabase Edge Function) | Required: the existing flow and web page |
| Safe areas / notch | `mobile.css` + `SystemBars` CSS variables | `env(safe-area-inset-*)` works natively in WKWebView; `mobile.css` already uses it | Same as Android |
| Deep link for OAuth | Intent filter for `com.ch2digital.mealplannerai://auth-callback` | Add a URL Type with the same scheme in `Info.plist`; `appUrlOpen` already handles it. Add to Supabase Redirect URLs (same URL) | Same as Android |

## Apple App Store: steps when the time comes

1. Apple Developer Program membership (US$99/yr); create the App ID `com.ch2digital.mealplannerai` in Certificates, Identifiers & Profiles.
2. On a Mac with Xcode: `cd mobile && npm i @capacitor/ios@<same major> && npx cap add ios && npx cap sync ios`.
3. `Info.plist`: register the URL scheme `com.ch2digital.mealplannerai` (URL Types); set the display name.
4. Add **Sign in with Apple** (Guideline 4.8): enable the Apple provider in Supabase, add a third button in `index.html`/`js/auth.js` (`provider: 'apple'`), and a token revocation step in account deletion.
5. Privacy manifest (`PrivacyInfo.xcprivacy`) covering app-level data collection (same inventory as the Play Data safety form).
6. Icons/splash: `npx capacitor-assets generate --ios` (sources already in `mobile/assets/`).
7. App Store Connect: create the app, App Privacy answers, screenshots, review notes (guest mode, how to sign in, AI key note), then TestFlight → submission.
8. CI: add a `macos-latest` job (xcodebuild archive) with signing via App Store Connect API key secrets.

## Huawei AppGallery: steps when the time comes

1. Huawei developer account (identity verification) → AppGallery Connect → create the app with package `com.ch2digital.mealplannerai`.
2. The **same AAB/APK** can be submitted (no GMS dependency). Test on an HMS-only device (no Google services) or Huawei's Cloud Debugging, with particular attention to:
   - Gmail sign-in: needs a browser; Custom Tabs fall back to the default browser. Verify the deep-link return.
   - Outlook sign-in works the same way.
3. Decide whether to add HUAWEI ID sign-in for HMS-only users (product decision).
4. Complete AppGallery's privacy statement, content rating and (if distributing in mainland China) the additional filings.
5. Add Huawei-specific plugins only if/when Push Kit, IAP or Analytics are needed, behind a separate Capacitor build flavour, so the Google Play build stays free of HMS SDKs.
