/** Globals shared between the packaged web app and the native bridge. */

interface HMPARuntimeConfig {
  APP_ENV?: 'development' | 'staging' | 'production';
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  REDIRECT_URL?: string;
  PUBLIC_URL?: string;
}

interface HMPANativeBridge {
  isNative: true;
  platform: string;
  openAuthUrl(url: string): Promise<void>;
  saveFile(blob: Blob, filename: string): Promise<void>;
}

interface Window {
  /** Written by mobile/scripts/build-web.mjs into www/runtime-config.js. */
  __HMPA_CONFIG__?: Readonly<HMPARuntimeConfig>;
  /** Installed by src/native-bridge.js; absent in a normal browser. */
  HMPANative?: HMPANativeBridge;
}
