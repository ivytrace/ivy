import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM with a key derived (HKDF-SHA256) from IVY_SECRET_KEY. Used for the plaintext of API
 * keys that Ivy itself has to hand out again (the per-tenant auto-trace key).
 * Format: `v1.<iv>.<tag>.<ciphertext>`, base64url.
 */
const INFO = 'ivy api key encryption v1';

function derive(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), INFO, 32));
}

export function serverSecret(): string | null {
  return process.env.IVY_SECRET_KEY?.trim() || null;
}

export function encrypt(plaintext: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(secret), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function decrypt(box: string, secret: string): string {
  const [version, iv, tag, ct] = box.split('.');
  if (version !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unsupported encrypted value');
  const decipher = createDecipheriv('aes-256-gcm', derive(secret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
