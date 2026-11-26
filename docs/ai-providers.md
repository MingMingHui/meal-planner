# AI providers, authentication and token usage

How the app connects to AI providers, where credentials are kept, how token usage is measured, and how to add a provider. This applies identically to the web app and the Android app: the Android app packages the same `js/` files (see [mobile-deployment](mobile-deployment/README.md)), so there is one implementation of every rule below.

- [Supported providers](#supported-providers)
- [Three identities: app account, AI provider, guest](#three-identities-app-account-ai-provider-guest)
- [Authentication flow per provider](#authentication-flow-per-provider)
- [Where credentials are stored](#where-credentials-are-stored)
- [Architecture](#architecture)
- [Setup: database, Edge Function, secrets](#setup-database-edge-function-secrets)
- [API contract](#api-contract)
- [Database tables](#database-tables)
- [Token usage and cost](#token-usage-and-cost)
- [Error handling](#error-handling)
- [Guest behaviour](#guest-behaviour)
- [Security](#security)
- [Adding a provider](#adding-a-provider)
- [Testing](#testing)
- [Limitations and assumptions](#limitations-and-assumptions)

## Supported providers

| Provider | Connect with | Models offered (registry: `js/ai/providers.js`) | Cost shown |
|---|---|---|---|
| **OpenAI** (ChatGPT models) | OpenAI Platform API key | GPT-4.1 mini (default), GPT-4.1 nano, GPT-4o mini | Estimated from list price |
| **Anthropic** (Claude) | Anthropic Console API key | Claude Opus 5.5 (default), Claude Sonnet 5.5, Claude Haiku 5.5 | Estimated from list price |
| **OpenRouter** | **Sign in with OpenRouter** (OAuth PKCE; web only) or API key | Free Llama / Mistral / Gemma / Qwen / DeepSeek variants | **Reported by OpenRouter** |
| Groq | API key | Llama 3.1 8B Instant, Llama 3.3 70B, Gemma 2 9B | Not shown (no reliable price) |
| Together AI | API key | Llama 3.3 70B Turbo (free), Qwen 2.5 7B Turbo | Free model $0; others not shown |
| Hugging Face Inference | User access token | Llama 3.1 8B, Mistral 7B, Qwen 2.5 7B | Not shown |

A ChatGPT Plus or Claude.ai subscription does **not** include API access. Users need an API key from the provider's developer console, and API usage is billed by the provider to that key's account.

## Three identities: app account, AI provider, guest

The **Settings → AI Provider** card shows these as three separate lines:

| | What it is | Where it comes from |
|---|---|---|
| **App account** | Who you are in this app (cloud sync, account deletion) | "Continue with Gmail / Outlook" via Supabase Auth (`js/auth.js`) |
| **AI provider** | Which provider account pays for and answers AI requests | An API key you create at the provider, or OpenRouter's sign-in page |
| **Guest** | No app account; everything is scoped to the current browser tab | "Continue as Guest" |

Signing in to the app never signs you in to an AI provider, and connecting an AI provider never creates an app account.

## Authentication flow per provider

The app uses only official, documented mechanisms. It never asks for a provider password, never embeds or scrapes a provider's login page, and never simulates a login.

**API key** (OpenAI, Anthropic, Groq, Together, Hugging Face, and OpenRouter as an alternative):

1. The user creates a key on the provider's website (each provider card links to its key page).
2. The app checks the key's shape (`validateConnectionInput`), then verifies it with a cheap authenticated read on the provider: `GET /v1/models` for OpenAI, Anthropic, Groq and Together; `GET /api/v1/key` for OpenRouter; `GET /api/whoami-v2` for Hugging Face.
3. A rejected key is never saved. If the provider can't be reached from a browser (offline, or the endpoint blocks CORS), a device key is saved as *unverified* and is verified by its first real request. Account-stored keys are always verified server-side.

**OpenRouter OAuth PKCE** ([OpenRouter docs](https://openrouter.ai/docs/guides/overview/auth/oauth)):

1. `startOAuthConnection` creates a 43-character PKCE verifier, its S256 challenge, and a random `state`. These are kept in `sessionStorage` for 10 minutes along with the provider, model, store and owner.
2. The browser goes to `https://openrouter.ai/auth?callback_url=…&code_challenge=…&code_challenge_method=S256`. OpenRouter has no separate `state` parameter, so `state` travels inside `callback_url`'s own query string.
3. OpenRouter redirects to `dashboard.html?ai_oauth=openrouter&state=…&code=…`. Before routing, `completeOAuthFromUrl` does the following:
   - strips `code` and `state` from the address bar;
   - consumes the pending attempt, so a replayed callback finds nothing;
   - checks `state` in constant time, plus the attempt's age, provider and owner.
4. The code and verifier are exchanged at `POST https://openrouter.ai/api/v1/auth/keys`. For **account** storage the exchange happens inside `ai-proxy`, so the issued key never reaches browser JavaScript. For **device/session** storage it happens in the browser.

OAuth is **web-only**. OpenRouter accepts only `https` (or localhost) callback URLs, and the Android app's return path is a custom-scheme deep link. Inside the app the OAuth button is hidden and the API-key option is shown (`getAIEntitlements(...).authMethodsFor`).

**Why OpenAI and Anthropic don't use OAuth:** neither offers end-user OAuth for third-party API access. Their documented mechanism is a developer API key, which is what this app uses.

## Where credentials are stored

| Store | Who can use it | Where the key lives | How the AI call is made | Usage recorded by |
|---|---|---|---|---|
| **Encrypted in your account** (`account`, recommended) | Signed-in users, when `ai-proxy` is deployed | `ai_provider_connections.credential_ciphertext`, AES-256-GCM encrypted by `ai-proxy` | Browser → `ai-proxy` → provider | `ai-proxy` (server telemetry) |
| **This device only** (`device`) | Signed-in users | `localStorage` (`hmpa:settings.apiKey`) | Browser → provider directly | App, into the user's own `ai_usage_records` rows |
| **This browser session only** (`session`) | Guests | `sessionStorage`, cleared when the tab closes | Browser → provider directly | App, in `sessionStorage` only |

A device or session key is bound to its **owner** (`guest` or `user:<id>`) and its **provider**:

- it is never sent to a different provider after you switch provider;
- it is never used by a different person who signs in on the same device;
- it is dropped when a guest signs in during the same tab (the guest's profile data still carries over, as before).

When `ai-proxy` is not deployed, or its encryption secret is missing, the account option is shown disabled with an explanation, and keys stay on the device. This is the app's previous behaviour.

## Architecture

```
User / Guest
   │
Settings → AI Provider (js/aiViews.js)
   │  provider + model + store
   ▼
aiConnections.js ── policy (ai/policy.js): who may store what where
   │
ai.js  chatComplete(messages, {feature})        ◀── Recipe Generator, AI Meal Plan, AI Coach
   │
   ├─ store 'account' ─▶ cloudStorage.invokeAIProxy('chat') ─▶ ai-proxy Edge Function
   │                                                            │ decrypt key (AAD = user:provider)
   │                                                            ▼
   └─ store 'device'/'session' ───────────────────────────▶ ai/chat.js runProviderChat
                                                                │  AIProvider adapter
                                                                │  ├─ openAICompatibleAdapter (OpenAI, OpenRouter, Groq, Together, HF)
                                                                │  └─ anthropicAdapter
                                                                ▼
                                                           provider API
   usage: ai/usage.js buildUsageRecord ─▶ ai_usage_records (server or client) / sessionStorage (guest)
```

The shared AI core lives in **`js/ai/`**. Its modules are pure: no DOM, no Storage, no app imports. All three platforms run the same files:

| File | Responsibility |
|---|---|
| `providers.js` | Registry, `AIProvider` adapters, validation, request limits |
| `chat.js` | Execute one provider call, or verify a key: timeout, classification, parsing |
| `usage.js` | Usage records, cost estimates, filters, summaries |
| `errors.js` | Error codes, safe messages, secret redaction |
| `policy.js` | Entitlements and guest rules |
| `oauth.js` | PKCE and the OpenRouter flow |
| `contract.js` | `ai-proxy` actions and the shape of DB rows |

Where each platform gets the core:

- **Web:** imports `js/ai/` directly.
- **Android:** `mobile/scripts/build-web.mjs` copies `js/` into the app unchanged.
- **Edge Function:** imports `supabase/functions/_shared/ai/`, a byte-identical copy generated by `cd mobile && npm run sync:shared-ai`. `tests/shared-ai-sync.test.js` and `npm run check` fail if the copy drifts. A copy is used because Supabase bundles each function from `supabase/functions/`; importing from outside that folder is only supported by an experimental deploy mode.

## Setup: database, Edge Function, secrets

Skip this section to keep the previous behaviour: everything still works with device and session keys.

1. **Database.** In the Supabase SQL Editor, run `supabase/ai_providers.sql` after `schema.sql`, `policies.sql` and `delete_account.sql`. It is safe to re-run.
2. **Encryption secret.** Generate it and set it as a function secret. Never commit it.
   ```bash
   supabase secrets set AI_CREDENTIALS_ENCRYPTION_KEY="$(openssl rand -base64 32)"
   # optional: restrict browser origins (include https://localhost for the Android app)
   supabase secrets set AI_PROXY_ALLOWED_ORIGINS="https://USERNAME.github.io,https://localhost"
   ```
   Keep a secure backup of the key. If it is lost or changed, saved credentials can't be decrypted: users see "reconnect" and must paste their key again.
3. **Deploy the function** from the repository root:
   ```bash
   cd mobile && npm run sync:shared-ai && cd ..
   supabase functions deploy ai-proxy
   ```
   Keep JWT verification on (the default). `ai-proxy` also validates the token itself.
4. **OpenRouter OAuth.** No registration is needed. The callback is `https://<your site>/dashboard.html` (`aiConnections.oauthCallbackUrl()`), and locally `http://localhost:<port>/dashboard.html`.

**Environment variables**

| Name | Where | Required | Purpose |
|---|---|---|---|
| `AI_CREDENTIALS_ENCRYPTION_KEY` | Supabase function secret | Yes, for account storage | Base64 of 32 bytes; AES-256-GCM key |
| `AI_PROXY_ALLOWED_ORIGINS` | Supabase function secret | No (default `*`) | Allowed browser origins for `ai-proxy` |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Injected by Supabase | — | Auth check, and server-side reads/writes inside `ai-proxy` only |

There are **no AI provider keys** in any environment file or build. Templates: `supabase/functions/.env.example`, `mobile/.env.example`.

## API contract

Defined once in `js/ai/contract.js`. The Edge Function is called as `POST {SUPABASE_URL}/functions/v1/ai-proxy` with `Authorization: Bearer <user access token>` (supabase-js `functions.invoke` adds it) and a JSON body `{ "action": ..., ...payload }`:

| Action | Payload | Response | Auth |
|---|---|---|---|
| `health` | — | `{ ok, encryptionConfigured }` | none |
| `save_key` | `{ provider, model?, apiKey }` | `{ connection }` | signed-in, non-anonymous |
| `oauth_exchange` | `{ provider, model?, code, codeVerifier }` | `{ connection }` | signed-in, non-anonymous |
| `disconnect` | `{ provider }` | `{ disconnected }` | signed-in |
| `chat` | `{ provider, model, messages, temperature?, maxTokens?, feature? }` | `{ text, model, usage, usageRecorded }` | signed-in |

- A `connection` is the public view only: `{ provider, authMethod, model, keyHint, status, lastErrorCode, lastVerifiedAt, updatedAt }`. It never contains the key or ciphertext.
- Errors return a 4xx/5xx status with `{ error: { code, message } }` (see [Error handling](#error-handling)).
- The user id always comes from the verified token. Any `user_id` in the body is ignored.

The apps read their own data directly through PostgREST with Row Level Security:

- `ai_provider_connections`: non-secret columns only (`PUBLIC_CONNECTION_COLUMNS`);
- `ai_usage_records`: select and insert of client rows.

These calls are in `js/cloudStorage.js` (`loadAIConnections`, `loadAIUsage`, `insertAIUsage`, `deleteAIConnection`).

## Database tables

`supabase/ai_providers.sql` adds two tables. No existing table changed. Both cascade on account deletion.

**`ai_provider_connections`**: one row per (user, provider).

- **Columns:** `provider`, `auth_method` (`api_key` | `oauth_pkce`), `model`, `credential_ciphertext` (`v1:<iv>:<ct>`), `key_hint` (last 4 characters), `status` (`active` | `invalid` | `expired`), `last_error_code`, `last_verified_at`, timestamps.
- **RLS:** select and delete of your own rows only.
- **Column grants:** the `authenticated` role can't select `credential_ciphertext` and can't insert or update. Only `ai-proxy` (service role) writes.

**`ai_usage_records`**: one row per AI request.

- **Columns:** `provider`, `model`, `feature` (`coach` | `recipe` | `meal_plan` | `other`), `status`, `error_code`, `input_tokens`, `output_tokens`, `total_tokens` (**generated** = input + output), `token_source`, `estimated_cost_usd`, `cost_source`, `recorded_by` (`server` | `client`), `latency_ms`, `created_at`.
- **RLS:** select and delete your own rows. You can insert only rows for yourself with `recorded_by = 'client'`, so a client cannot forge server telemetry or write rows for someone else.
- **No prompts or responses are stored.** The app's existing privacy model sends profile details to the provider but doesn't keep conversations server-side, and this feature follows it.

The local storage schema went from version 2 to 3. The migration binds an existing device key to its owner and provider, and adds the `hmpa:aiUsage` and `hmpa:aiConnCache` keys.

## Token usage and cost

Every AI request produces one record (`js/ai/usage.js → buildUsageRecord`). Nothing is invented:

| Field | Source | Label in the UI |
|---|---|---|
| Input/output tokens | The provider's response `usage` (OpenAI-compatible `prompt_tokens`/`completion_tokens`; Anthropic `input_tokens` + cache tokens / `output_tokens`) | **Provider-reported** |
| Input/output tokens when the provider returns none | ≈ 4 characters per token over the sent and received text | **App-estimated** |
| Total tokens | Always `input + output` (also a generated DB column) | — |
| Cost, OpenRouter | `usage.cost` returned by OpenRouter (requested with `usage.include`) | **Provider** |
| Cost, models in the pricing table | tokens × list price per 1M (`PRICING_AS_OF` in `providers.js`) | **Est.** |
| Cost, models without reliable pricing | not shown | "—", and summaries say "Excludes models without pricing" |
| Failed requests | counted as a request with 0 tokens and $0 | Failed |

Notes:

- When the provider says a different model answered (e.g. Claude's refusal fallback), the record and price use the model that actually answered.
- Claude Haiku 5.5's long-context rate applies above 100K input tokens.

**AI Usage page** (sidebar → AI Usage; also linked from Settings):

- Filters: date range (default: the last 30 days), provider, model.
- **Current period** (calendar month) and **Selected range** summaries: total, input and output tokens, total requests, estimated cost.
- Per-provider/model breakdown and the request history (date/time, provider, model, feature, tokens, cost, source, status).
- CSV export, which uses the Android share sheet in the app.

**Why not the providers' own usage APIs?**

- The OpenAI Usage API and the Anthropic Usage & Cost API require an organization **admin** key, not the user key this app holds.
- OpenRouter reports cost per response, which the app already uses.

The provider's own billing page stays authoritative. The usage page says so.

## Error handling

Each error has a code (`js/ai/errors.js`) and a friendly message. Messages never include a provider's response body, because it can echo request content, or anything resembling a key.

| Situation | Code | What the user sees |
|---|---|---|
| Nothing connected | `not_configured` | Connect a provider in Settings |
| Key rejected (401) | `auth_invalid` | Reconnect; connection marked "Credentials rejected" |
| Key expired or revoked | `auth_expired` | Reconnect; connection marked "Expired" |
| No access to model (403) | `permission_denied` | Choose another model |
| Rate limited (429) | `rate_limited` | Wait or switch models (retryable) |
| Out of credits / quota (402, `insufficient_quota`, "credit balance") | `quota_exceeded` | Check billing at the provider |
| Model not offered / not found | `unsupported_model` | Choose another model |
| Provider down (5xx, 529 overloaded) | `provider_unavailable` | Try again shortly (retryable) |
| Model declined (`stop_reason: refusal`) | `refused` | Rephrase |
| Offline / CORS / DNS | `network` | Check connection (retryable) |
| Timeout (45 s) | `timeout` | Try again (retryable) |
| App session ended | `app_auth_required` | Sign in again |
| Guest asked for account storage | `guest_restricted` | Explains guest limits |
| `ai-proxy` not deployed or unreachable | `proxy_unavailable` | Account storage disabled; device storage offered |
| Encryption secret missing | `server_misconfigured` | Contact the administrator |
| Usage history unavailable | `usage_unavailable` | Device-recorded usage still shown |
| OAuth callback forged / expired / replayed | `oauth_state_mismatch` | Ignored for safety; try again |

## Guest behaviour

Guests follow the app's existing guest model (`storage.js`): everything stays in this tab's `sessionStorage` and nothing is written to the cloud.

- **Can:** connect any provider (with an API key, or OpenRouter sign-in on the web), use every AI feature, and see their usage for the session.
- **Cannot:** save credentials to an account (the UI doesn't offer it, `aiConnections` refuses it, and `ai-proxy` rejects anonymous users).
- **Isolation:** closing the tab removes the key and usage. Signing in during the same tab carries the guest's profile data over (unchanged behaviour), but **not** their AI key or AI usage. Local usage records carry an owner id and are only shown to that owner.

## Security

- **No hard-coded secrets.** The only key in the frontend is the Supabase anon key, which is public by design. Provider keys come from users. The encryption key is a Supabase function secret. `.gitignore` excludes `.env` files and `supabase/functions/.env`.
- **Encryption at rest.** AES-256-GCM with a random 96-bit IV per write. The additional authenticated data is `user_id:provider`, so a ciphertext moved to another user or provider fails to decrypt. A version prefix leaves room for key rotation.
- **Never returned.** Only `keyHint` (`••••abcd`) ever leaves the server. The settings form never pre-fills a key, and it clears a rejected key from the input.
- **Never logged.** `ai-proxy` logs event names and non-secret fields. Unexpected errors go through `redactSecrets` (provider keys, bearer tokens, JWTs, OAuth codes). Keys never go into URLs, and OAuth codes are stripped from the address bar immediately. There is no analytics.
- **Authorization.**
  - Every `ai-proxy` action except `health` requires a valid, non-anonymous Supabase session, and every query is scoped to the token's user id.
  - RLS plus column grants stop clients from reading ciphertext or forging server usage rows.
  - Request size, message count, roles, model allowlist and `max_tokens` are validated identically in the browser and on the server.
- **Revocation.** Disconnect deletes the stored credential: through `ai-proxy`, or directly through RLS if it is unreachable. Delete Cloud Data and Delete Account remove connections and usage. The card links to each provider's key page so the user can revoke the key itself.
- **Expired credentials.** A 401 marks the connection `invalid`/`expired`. The server stops using it, and the UI asks the user to reconnect. Saving a new key resets it.
- **Browser-direct calls (device/session keys)** send the key straight to the provider over HTTPS, exactly as before this feature. Anthropic requires its documented `anthropic-dangerous-direct-browser-access` opt-in header for this. It is sent only in browser context, never by `ai-proxy`. Account storage avoids exposing the key to the page at all.

## Adding a provider

1. Add an entry to `PROVIDERS` in `js/ai/providers.js`:
   - `id`, `label`, `description`, `kind`;
   - `endpoint`, `verifyUrl`, `keyUrl`, `revokeUrl`;
   - `keyPattern`, `keyPlaceholder`, `authMethods`;
   - `defaultModel`, `models: [{ id, label, pricing }]` (USD per 1M tokens, or `null` when unknown).
2. If its API is OpenAI-compatible, set `kind: 'openai-compatible'` and you're done. Optionally set `tokenParam`, `extraBody` and `extraHeaders`.
3. Otherwise, write an adapter with `buildChatRequest`, `parseChatResponse` and `buildVerifyRequest` (see `anthropicAdapter`) and register it in `ADAPTERS`.
4. If its error envelope differs, extend `classifyProviderError` in `js/ai/errors.js`, and add its key prefix to `SECRET_PATTERNS`.
5. For an official OAuth flow, add the method to `AUTH_METHODS`, implement it next to `ai/oauth.js`, and handle it in `aiConnections.js` and the `ai-proxy` handler.
6. Run `cd mobile && npm run sync:shared-ai && npm run check`. Add the provider to the tests in `tests/ai-providers.test.js`.

No UI, chat-flow, or Edge Function code needs to change for a new OpenAI-compatible provider.

## Testing

`cd mobile && npm run check` runs the shared-copy drift check, lint, type check and all tests. AI coverage:

| Test file | Covers |
|---|---|
| `tests/ai-providers.test.js` | Registry, adapters (OpenAI / OpenRouter / Groq / Anthropic request and response shapes), validation, error classification, redaction, entitlements |
| `tests/ai-usage.test.js` | Token totals, provider-reported vs estimated tokens and cost, filters by date/provider/model, summaries, DB row contract |
| `tests/ai-proxy-handler.test.js` | Edge Function: auth required; anonymous users rejected; encrypted storage; invalid and expired credentials; routing to the selected provider and model; usage recording; cross-user isolation (body `user_id` ignored, AAD binding); rate limit / quota / network errors; CORS |
| `tests/web-ai-client.test.js` | App flow: guest connect, chat and usage; guest restrictions; guest → account isolation; owner/provider binding; account mode via `ai-proxy`; proxy-unavailable fallback; OAuth PKCE callback (success, forged state, owner change, not in the Android app); storage migration |
| `tests/web-ai-views.test.js` | Settings card and AI Usage page render (guest/signed-in, escaping, labels) |
| `tests/shared-ai-sync.test.js` | Edge Function copy identical to `js/ai`; Android build packages `js/`; shared contract; no committed keys |

## Limitations and assumptions

- **Prices** are list prices as of `PRICING_AS_OF`, not your bill: discounts, cached-input pricing, batch pricing and taxes are not modelled. Groq, Hugging Face and some Together models show no cost.
- **Model lists** are curated. Providers retire models over time; a retired model returns `unsupported_model`, and the registry should be updated.
- **OpenRouter OAuth is web-only** (see above).
- **Browser verification:** some providers' verify endpoints may not allow browser (CORS) requests. Such device keys are saved as "unverified" until their first successful request.
- **Account storage requires** `ai_providers.sql`, the deployed `ai-proxy` function and `AI_CREDENTIALS_ENCRYPTION_KEY`. Without them, the app behaves exactly as before (device keys only), and the UI says why.
- **Usage history** for device keys is written by the client, which RLS restricts to the user's own `recorded_by = 'client'` rows. It reflects what the app observed. Server-recorded rows come from `ai-proxy`.
