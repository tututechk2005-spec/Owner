const crypto = require('crypto');

/**
 * Reads the encryption key ONLY from process.env.ENCRYPTION_KEY. There is no
 * silent fallback to a hardcoded default: if the key changed silently between
 * saving and reading, previously-encrypted API secrets would decrypt into
 * garbage (or throw) with no clear explanation. server.js already refuses to
 * boot if ENCRYPTION_KEY is missing (same pattern as JWT_SECRET), so by the
 * time this function runs in normal operation the key is guaranteed to be
 * present. This check remains as defense-in-depth for any code path that
 * might call it before that startup check runs.
 */
function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    const err = new Error('Server configuration error: ENCRYPTION_KEY is not set. API credentials cannot be encrypted or decrypted.');
    err.errorType = 'encryption_error';
    throw err;
  }
  // Derive a stable 32-byte key from whatever string is provided. This is
  // deterministic - the same ENCRYPTION_KEY value always produces the same
  // derived key, so nothing here changes between server restarts/deployments
  // as long as the environment variable itself stays the same.
  return crypto.createHash('sha256').update(String(raw)).digest();
}

function encrypt(plainText) {
  if (plainText === null || plainText === undefined) return null;
  try {
    const iv = crypto.randomBytes(12);
    const key = getKey();
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  } catch (e) {
    if (e.errorType === 'encryption_error') throw e; // already a clear config error from getKey()
    const err = new Error(`Failed to encrypt credential: ${e.message}`);
    err.errorType = 'encryption_error';
    throw err;
  }
}

function decrypt(payload) {
  if (!payload) return null;
  try {
    const buf = Buffer.from(payload, 'base64');
    if (buf.length < 29) throw new Error('Encrypted payload is malformed or truncated');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const encrypted = buf.subarray(28);
    const key = getKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (e) {
    if (e.errorType === 'encryption_error') throw e; // already a clear config error from getKey()
    // Almost always means ENCRYPTION_KEY changed since this value was saved,
    // or the stored data is corrupted - never a Binance-side problem.
    const err = new Error(`Failed to decrypt stored credential: ${e.message}. This usually means ENCRYPTION_KEY has changed since it was saved, or the stored value is corrupted.`);
    err.errorType = 'decryption_error';
    throw err;
  }
}

// Masks a secret for display purposes (never send full secret to client)
function mask(value) {
  if (!value) return '';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}${'*'.repeat(value.length - 8)}${value.slice(-4)}`;
}

module.exports = { encrypt, decrypt, mask };
