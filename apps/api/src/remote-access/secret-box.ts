import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
// Fixed labels: changing either one makes every stored secret unreadable.
const HKDF_SALT = 'briefroom';
const HKDF_INFO = 'briefroom/secret-box/v1';

/** HKDF-SHA256 over BRIEFROOM_SECRET_KEY, so the env bytes are never used as the cipher key. */
export function deriveSecretBoxKey(secretKey: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secretKey, HKDF_SALT, HKDF_INFO, KEY_BYTES));
}

/** `v1.<iv>.<ciphertext>.<tag>`, base64url parts. The version is bound in as associated data. */
export function seal(plain: string, key: Buffer): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(VERSION));
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv, ciphertext, cipher.getAuthTag()]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

export function open(sealed: string, key: Buffer): string {
  assertKey(key);
  const [version, iv, ciphertext, tag, ...rest] = sealed.split('.');
  if (version !== VERSION || rest.length > 0 || iv === undefined || ciphertext === undefined) {
    throw new Error('Unknown sealed secret format');
  }
  const ivBytes = Buffer.from(iv, 'base64url');
  const tagBytes = Buffer.from(tag ?? '', 'base64url');
  if (ivBytes.length !== IV_BYTES || tagBytes.length !== TAG_BYTES) {
    throw new Error('Unknown sealed secret format');
  }
  const decipher = createDecipheriv(ALGORITHM, key, ivBytes, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(VERSION));
  decipher.setAuthTag(tagBytes);
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new Error('The secret box key must be 32 bytes');
}
