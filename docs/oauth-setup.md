# OAuth Configuration Guide — Gmail & Outlook Sign-In

This is the detailed, click-by-click companion to the README's [Authentication
Setup](../README.md#authentication-setup) section. It covers everything needed
to make the **"Continue with Gmail"** and **"Continue with Outlook"** buttons
on the login page actually work, end to end, across three separate systems:

| System | What you configure there | Requires |
|---|---|---|
| [Google Cloud Console](https://console.cloud.google.com/) | An OAuth client for "Continue with Gmail" | A Google account |
| [Microsoft Entra admin center](https://entra.microsoft.com/) (Azure Portal) | An app registration for "Continue with Outlook" | A Microsoft/Azure account |
| [Supabase Dashboard](https://supabase.com/dashboard) | Wires both providers into this app's auth backend | The Supabase project's owner/admin account |

None of these three steps can be done from this repository or via `git push`
— they're all interactive web-console configuration on services this app
depends on but doesn't control. This app's code (`js/auth.js`, `js/config.js`,
`js/authGate.js`) is already correct and complete on the application side; it
just needs the provider credentials below to exist on the Supabase side
before the buttons will work for anyone other than a guest.

**Branding reminder:** Gmail and Outlook aren't OAuth providers in their own
right — "Continue with Gmail" authenticates via the standard **Google** OAuth
provider, and "Continue with Outlook" authenticates via the standard
**Microsoft/Azure AD** OAuth provider. Every console below refers to "Google"
or "Azure AD," never "Gmail" or "Outlook" — those labels are purely this
app's frontend presentation choice (see `js/auth.js`'s `PROVIDER_DISPLAY_NAMES`).

---

## Before you start: values you'll need to copy around

These are specific to this deployment. Have them handy:

| Value | This deployment's value |
|---|---|
| Supabase project ref | `bkrgxmjsyghzrostfvrt` |
| Supabase OAuth callback URL (goes in **both** Google and Azure) | `https://bkrgxmjsyghzrostfvrt.supabase.co/auth/v1/callback` |
| Deployed app URL (Site URL / Redirect URL in Supabase) | `https://mingminghui.github.io/meal-planner/` |
| Local dev URL (add alongside the deployed URL, if you test locally) | `http://localhost:8000/` (or whatever port you serve on) |

If you ever repoint this app at a different Supabase project, redo this table
with the new project ref first — every URL below depends on it.

---

## Part A — Google Cloud Console (powers "Continue with Gmail")

Google has renamed this area **"Google Auth Platform"** in newer Cloud
projects. Older projects may still show it as a single-page **"OAuth consent
screen"** — the same fields exist either way, just combined onto one page
instead of split into tabs.

### A1. Create or select a project

1. Go to [console.cloud.google.com](https://console.cloud.google.com/).
2. Top-left project dropdown → **New Project**.
3. Name it (e.g. `Health Meal Planning Agent`) → **Create** → wait for
   creation to finish, then confirm it's selected in the project dropdown.

### A2. Configure the consent screen (Branding / Audience / Data Access)

Left sidebar or search bar → **APIs & Services → OAuth consent screen**
(a.k.a. **Google Auth Platform**).

**Branding:**
- **App name**: `Health Meal Planning Agent`
- **User support email**: your email, from the dropdown
- **App logo**: optional — skip it
- **Authorized domains**: optional for Testing status; only matters once you
  publish to production
- **Developer contact information**: your email
- Click **Save**

**Audience:**
- **User type**: **External** (any Google account, not just one workspace)
- This starts the app in **Testing** status. **While in Testing, only the
  Google accounts you explicitly add as test users can complete sign-in** —
  everyone else is blocked with a Google error page before they ever reach
  this app. See [A5](#a5-testing-vs-production--who-can-actually-sign-in)
  below before you consider this "done."
- Under **Test users → Add users**, add every Gmail address that needs to
  sign in for now (your own account at minimum). Testing status caps this at
  100 users.
- Click **Save**

**Data Access (scopes):**
- Click **Add or Remove Scopes**
- Check the three non-sensitive scopes: `.../auth/userinfo.email`,
  `.../auth/userinfo.profile`, `openid`
- These are non-sensitive — no Google verification review is required for
  them specifically
- **Update** → **Save**

### A3. Create the OAuth Client (the actual Client ID/Secret)

Left sidebar → **APIs & Services → Credentials** (a.k.a.
**Google Auth Platform → Clients**).

1. **+ Create Credentials** (or **Create Client**) → **OAuth client ID**
2. **Application type**: **Web application**
3. **Name**: `Health Meal Planner - Supabase` (an internal label only)
4. **Authorized JavaScript origins** → **+ Add URI**:
   ```
   https://mingminghui.github.io
   ```
5. **Authorized redirect URIs** → **+ Add URI** — this is the one that
   actually matters, must match exactly, no trailing differences:
   ```
   https://bkrgxmjsyghzrostfvrt.supabase.co/auth/v1/callback
   ```
6. Click **Create**.

A dialog shows the **Client ID** and **Client Secret** — **copy both now**.
Google only displays the secret once, at creation time. If you lose it,
generate a new one from the client's detail page (**Credentials → click the
client → Reset Secret**); the old one keeps working until you do.

A newly created client can take a few minutes to start working — if you get
`redirect_uri_mismatch` immediately after creating it, wait a few minutes and
retry before assuming something's misconfigured.

### A4. Hand off to Supabase

Continue to [Part C](#part-c--supabase-dashboard-wiring-it-all-together) and
paste the Client ID + Client Secret into the **Google** provider row.

### A5. Testing vs. production — who can actually sign in

This is the step people forget, and the most common reason "it works for me
but not for my coworker":

- **Testing status** (the default): only the exact Google accounts listed
  under **Audience → Test users** can complete sign-in. Anyone else clicking
  "Continue with Gmail" gets a Google-branded error page, never reaching this
  app or Supabase at all.
- **Production status**: any Google account can sign in. To get here, go to
  **Audience → Publish App**. For the basic `email`/`profile`/`openid`
  scopes used here, Google does **not** require the full manual verification
  review — but first-time users may briefly see a "Google hasn't verified
  this app" interstitial they have to click through (**Advanced → Go to
  [app name] (unsafe)**). This is expected and goes away on its own; no
  action needed unless Google's dashboard explicitly flags the app for
  review.

---

## Part B — Microsoft Entra admin center / Azure Portal (powers "Continue with Outlook")

Azure AD was renamed **Microsoft Entra ID**; the admin UI now lives at
[entra.microsoft.com](https://entra.microsoft.com/), though the older
[portal.azure.com](https://portal.azure.com/) → *Azure Active Directory*
blade still works and shows the same data.

### B1. Register the application

1. Sign in to the [Microsoft Entra admin center](https://entra.microsoft.com/)
   with an account that has at least the **Application Developer** role.
2. Browse to **Identity → Applications → App registrations** → **New
   registration**.
3. **Name**: `Health Meal Planning Agent` (shown to users on the Microsoft
   consent screen; changeable later).
4. **Supported account types** — this determines who can sign in, so pick
   deliberately:

   | Option | Effect |
   |---|---|
   | Single tenant only — \<your org\> | Only accounts in your own Microsoft 365/Azure org |
   | Multiple Entra ID tenants | Any work/school account, from any org — no personal accounts |
   | **Any Entra ID Tenant + Personal Microsoft accounts** ← use this one | Any work/school **or** personal Outlook/Hotmail/Live account |
   | Personal accounts only | Only personal Outlook/Hotmail/Live accounts |

   To match "any Gmail account can sign in" parity from Part A, choose
   **Any Entra ID Tenant + Personal Microsoft accounts**.
5. Leave **Redirect URI** blank here — it's added in the next step instead,
   since this form's redirect-URI field defaults to the wrong platform type.
6. Click **Register**.
7. On the app's **Overview** page, copy the **Application (client) ID** —
   you'll need it for Supabase.

### B2. Add the redirect URI

1. On the app's page, left sidebar → **Manage → Authentication**.
2. Click **Add a platform** → select **Web**.
3. Under **Redirect URIs**, enter exactly:
   ```
   https://bkrgxmjsyghzrostfvrt.supabase.co/auth/v1/callback
   ```
4. Leave **Front-channel logout URL** blank.
5. Under **Implicit grant and hybrid flows**, leave both checkboxes
   (**Access tokens**, **ID tokens**) unchecked — Supabase uses the
   authorization code flow, not the implicit flow.
6. Click **Configure** / **Save**.

### B3. Create a client secret

1. Left sidebar → **Manage → Certificates & secrets → Client secrets** tab.
2. **New client secret**.
3. **Description**: `supabase-oauth` (or anything identifiable).
4. **Expires**: pick a duration (max 24 months). Set yourself a reminder to
   rotate it before this date — an expired secret breaks "Continue with
   Outlook" with no warning until it fails.
5. Click **Add**.
6. Copy the **Value** column immediately — like Google, this is shown
   **once only** and cannot be retrieved again after you navigate away. (The
   **Secret ID** column is not what you need — it's just an identifier, not
   the secret itself.)

### B4. Hand off to Supabase

Continue to [Part C](#part-c--supabase-dashboard-wiring-it-all-together) and
paste the **Application (client) ID** and the secret **Value** into the
**Azure** provider row.

### B5. Who can actually sign in

Unlike Google, there's no separate "Testing" gate here — once the redirect
URI and secret are configured and the provider is enabled in Supabase, **any**
Microsoft account matching the "Supported account types" you chose in B1 can
sign in immediately. There's no publish/verification step to remember.

---

## Part C — Supabase Dashboard: wiring it all together

Go to **[your Supabase project](https://supabase.com/dashboard/project/bkrgxmjsyghzrostfvrt)
→ Authentication → Providers**:

1. **Google** row → toggle **Enabled** → paste the **Client ID** and
   **Client Secret** from [A3](#a3-create-the-oauth-client-the-actual-client-idsecret)
   → **Save**.
2. **Azure** row → toggle **Enabled** → paste the **Application (client) ID**
   from [B1](#b1-register-the-application) as the Client ID, and the secret
   **Value** from [B3](#b3-create-a-client-secret) as the Client Secret →
   leave **Azure Tenant URL** as the default (`common`) unless you deliberately
   restricted sign-in to a single tenant in B1 → **Save**.
3. **Authentication → URL Configuration**:
   - **Site URL**: `https://mingminghui.github.io/meal-planner/`
   - **Redirect URLs**: add `https://mingminghui.github.io/meal-planner/`
     (and `http://localhost:8000/`, or your local dev port, if you test
     locally) — include the trailing slash, it must match
     `CONFIG.REDIRECT_URL` exactly (see `js/config.js`).

Both providers take effect **immediately** on save — no code change, commit,
or redeploy is needed. The app already detects which providers are enabled
on every login-page load (`js/auth.js`'s `getEnabledProviders()`, called from
`js/authGate.js`) and enables/disables each button accordingly.

---

## Verification

Confirm a provider is actually live, from outside the app, with the public
(unauthenticated) settings endpoint — this is safe to run any time, it
exposes no secrets:

```bash
curl "https://bkrgxmjsyghzrostfvrt.supabase.co/auth/v1/settings" \
  -H "apikey: <the SUPABASE_ANON_KEY from js/config.js>"
```

Look for `"google":true` and `"azure":true` under the `"external"` key. Both
`false` means that provider isn't enabled yet in Supabase, regardless of
whether the Google/Azure sides are configured correctly.

Then check live in the browser:

1. Open `https://mingminghui.github.io/meal-planner/` in a private/incognito
   window (avoids a cached/already-signed-in session masking a real problem).
2. The Gmail/Outlook buttons should be enabled (not greyed out) once
   `getEnabledProviders()` resolves — this can take a moment on page load.
3. Click one → you should land on the provider's real sign-in page (Google or
   Microsoft), not an error page.
4. After signing in, you should be redirected back through
   `https://mingminghui.github.io/meal-planner/` and on into
   `dashboard.html`, now showing your name/avatar in the top-right user menu.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Unsupported provider: provider is not enabled` (raw JSON, not a styled app error) | The provider's toggle is off in Supabase, or the app tried to sign in before its enabled-providers check disabled the button | Complete Part C for that provider. If it happens on a very first click right after page load, it's a benign race in the best-effort check — the disabled state should stick after a refresh |
| `redirect_uri_mismatch` (Google) | The Authorized redirect URI in Google Cloud Console doesn't exactly match `https://bkrgxmjsyghzrostfvrt.supabase.co/auth/v1/callback` | Re-check for typos, trailing slashes, or `http` vs `https`. Also allow a few minutes after first creating the client |
| `AADSTS50011` — reply URL mismatch (Azure) | The redirect URI in the app registration's **Authentication** blade doesn't match the Supabase callback | Re-check B2; make sure it was added under the **Web** platform, not **SPA** or **Mobile/Desktop** |
| `AADSTS700016` — application not found in tenant | Signing in with an account type not covered by the **Supported account types** chosen in B1 | Either use a matching account, or change B1 to **Any Entra ID Tenant + Personal Microsoft accounts** |
| Google sign-in works for you but not a teammate | The app is still in **Testing** status and they aren't in the test users list | Add them under **Audience → Test users**, or publish the app (see [A5](#a5-testing-vs-production--who-can-actually-sign-in)) |
| "Google hasn't verified this app" warning screen | Expected, brief, cosmetic — appears for a period after first publishing to production | Click **Advanced → Go to [app name] (unsafe)** to continue; no configuration issue |
| Secret pasted into Supabase but sign-in still fails | Client secret expired (Azure secrets expire; Google secrets don't but can be revoked) | Generate a new secret in the console that issued it, update the value in Supabase's provider settings, save |
| Works locally but not on the deployed GitHub Pages URL (or vice versa) | Only one of the two URLs is in Supabase's **Redirect URLs** allowlist | Add both `https://mingminghui.github.io/meal-planner/` and your local dev URL under **Authentication → URL Configuration** |

---

## Security notes

- **Never commit a Client Secret (Google or Azure) to this repository.** They
  live only in the Supabase Dashboard's provider settings, which are not
  version-controlled and not exposed by this app's frontend.
- `js/config.js`'s `SUPABASE_ANON_KEY` is the public/anon key — safe to
  commit, and it cannot read or change provider configuration; it only
  authenticates ordinary end-user requests, gated by Row Level Security (see
  `supabase/policies.sql`). Nothing in this document requires exposing the
  Supabase `service_role` key anywhere — never put that key in this repo,
  in browser code, or in this documentation.
- Rotating either provider's secret (Google: regenerate via **Credentials**;
  Azure: add a new client secret before the old one expires, per B3) is a
  Supabase Dashboard-only change — it never requires a code commit or
  redeploy of this app.
