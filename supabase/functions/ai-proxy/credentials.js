/**
 * credentials.js — AES-256-GCM encryption of AI provider credentials at rest.
 * ----------------------------------------------------------------------------
 * The 32-byte key comes from the AI_CREDENTIALS_ENCRYPTION_KEY function
 * secret (base64) and never leaves the Edge Function. Each ciphertext is
 * bound to its owner and provider through GCM additional authenticated data
 * ("<user id>:<provider>"), so a row copied to another user or provider
 * fails to decrypt instead of silently working. Format: "v1:<iv b64>:<ct b64>"
 * — the version prefix leaves room for key rotation.
 * Pure Web Crypto: runs in Deno (production) and Node 20+ (tests).
 * ----------------------------------------------------------------------------
 */

const VERSION = 'v1';
const enc = new TextEncoder();
const dec = new TextDecoder();

const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromB64 = (b64) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

/** Imports the base64 secret; returns null when it is missing or not 32 bytes. */
export async function importEncryptionKey(base64Secret, cryptoImpl = globalThis.crypto) {
  if (!base64Secret) return null;
  let raw;
  try { raw = fromB64(base64Secret.trim()); } catch { return null; }
  if (raw.length !== 32) return null;
  return cryptoImpl.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export const credentialAad = (userId, provider) => enc.encode(`${userId}:${provider}`);

export async function encryptCredential(key, plaintext, aad, cryptoImpl = globalThis.crypto) {
  const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await cryptoImpl.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, enc.encode(plaintext)));
  return `${VERSION}:${toB64(iv)}:${toB64(ct)}`;
}

export async function decryptCredential(key, payload, aad, cryptoImpl = globalThis.crypto) {
  const [version, ivB64, ctB64] = String(payload || '').split(':');
  if (version !== VERSION || !ivB64 || !ctB64) throw new Error('Unsupported credential format');
  const pt = await cryptoImpl.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(ivB64), additionalData: aad }, key, fromB64(ctB64));
  return dec.decode(pt);
}
