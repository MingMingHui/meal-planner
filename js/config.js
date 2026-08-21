/**
 * config.js
 * ----------------------------------------------------------------------------
 * Purpose: Single place for deployment-specific, browser-safe configuration.
 *          Fill in your own Supabase project's URL and anon (public) key
 *          after following the "Authentication Setup" section in README.md.
 *
 *          SECURITY: SUPABASE_ANON_KEY is the public/anon key. It is safe to
 *          expose in frontend code — Supabase enforces access control at the
 *          database level via Row Level Security (see supabase/policies.sql).
 *          NEVER put your Supabase service_role key here or anywhere in this
 *          repository. The service_role key bypasses Row Level Security and
 *          must only ever be used from a trusted server, which this static
 *          GitHub Pages app does not have.
 *
 * Inputs:  none — static values.
 * Outputs: CONFIG object consumed by auth.js / cloudStorage.js.
 * Depends on: nothing.
 * ----------------------------------------------------------------------------
 */

const CONFIG = {
  // From Supabase Dashboard → Project Settings → API
  SUPABASE_URL: 'https://bkrgxmjsyghzrostfvrt.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_idzkrVgI4E4x5BXI35ifLA_fI9zA1Lj',

  // App metadata used in PDF exports and the auth screen.
  APP_NAME: 'meal-planner',

  // Local storage schema version. Bump this and add a migration in
  // storage.js's MIGRATIONS map whenever the stored data shape changes.
  SCHEMA_VERSION: 2,
};

/** True once real Supabase credentials have been filled in above. */
CONFIG.CLOUD_ENABLED = Boolean(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);

/**
 * The base path this app is deployed under, e.g. "/health-meal-planner/" for
 * a GitHub Pages project site (https://USERNAME.github.io/REPOSITORY/), or
 * "/" for a user/organization site or local dev. Used to build OAuth redirect
 * URLs that survive a GitHub Pages sub-path deployment.
 *
 * Deliberately resolves to the *directory*, not a specific filename — that
 * directory request is served as index.html (the login page; see
 * authGate.js) by every static host this app targets. This holds true
 * whether config.js is evaluated from index.html or from dashboard.html
 * (e.g. a guest upgrading to a signed-in account mid-session), since both
 * pages live in the same directory: either way, OAuth always redirects back
 * to the login page, which then forwards an authenticated visitor on to
 * dashboard.html itself.
 */
function computeBasePath() {
  const path = window.location.pathname;
  const lastSlash = path.lastIndexOf('/');
  return lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '/';
}

CONFIG.BASE_PATH = computeBasePath();
CONFIG.REDIRECT_URL = `${window.location.origin}${CONFIG.BASE_PATH}`;

export default CONFIG;
