/**
 * AES-256-GCM for the SimpleFIN access URL.
 *
 * The access URL is a bearer credential — anyone holding it can read every balance on
 * the account, forever, without a second factor. It is the only genuinely sensitive
 * value this app stores, so it is encrypted at rest, never logged, and never sent to
 * the client.
 *
 * GCM rather than CBC because it authenticates: a tampered ciphertext fails to decrypt
 * rather than silently producing garbage that we would then send to an unknown host.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
const KEY_BYTES = 32;

export interface Sealed {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

function keyFrom(hex: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(hex, 'hex');
  } catch {
    throw new Error('ENCRYPTION_KEY is not valid hex. Generate one with: openssl rand -hex 32');
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        `Generate one with: openssl rand -hex 32`
    );
  }
  return key;
}

export function seal(plaintext: string, keyHex: string): Sealed {
  const key = keyFrom(keyHex);
  // A fresh IV per encryption. Reusing one under the same key breaks GCM catastrophically.
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function open(sealed: Sealed, keyHex: string): string {
  const key = keyFrom(keyHex);
  const decipher = createDecipheriv(ALGORITHM, key, sealed.iv);
  decipher.setAuthTag(sealed.tag);
  try {
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Almost always a changed ENCRYPTION_KEY rather than an attack, but we cannot tell
    // the difference and must not guess.
    throw new Error(
      'Could not decrypt the stored access URL. ENCRYPTION_KEY has changed, or the ' +
        'database was modified. Re-run onboarding to store a fresh access URL.'
    );
  }
}

/**
 * Constant-time comparison for the passcode check in Phase 4. Lives here so there is one
 * place to look for "did we compare a secret with ===".
 */
export function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
