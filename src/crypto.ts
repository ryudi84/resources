/**
 * Password protection for the hosted panel, with zero services and zero cost:
 * the scan data is sealed with AES-256-GCM under a PBKDF2-derived key at
 * build time, and the published page decrypts it in-browser via WebCrypto.
 * GitHub Pages only ever hosts ciphertext.
 */

export interface SealedPanel {
  v: 1;
  kdf: 'PBKDF2-SHA-256';
  iterations: number;
  salt: string;
  iv: string;
  data: string;
}

export const KDF_ITERATIONS = 310_000;

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function sealPanel(password: string, plaintext: string): Promise<SealedPanel> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, KDF_ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  );
  return {
    v: 1,
    kdf: 'PBKDF2-SHA-256',
    iterations: KDF_ITERATIONS,
    salt: b64(salt),
    iv: b64(iv),
    data: b64(new Uint8Array(ciphertext)),
  };
}

/** Mirror of the in-browser unlock path; used by tests to prove the seal round-trips. */
export async function unsealPanel(password: string, sealed: SealedPanel): Promise<string> {
  const key = await deriveKey(password, unb64(sealed.salt), sealed.iterations);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(sealed.iv) as BufferSource },
    key,
    unb64(sealed.data) as BufferSource,
  );
  return new TextDecoder().decode(plaintext);
}
