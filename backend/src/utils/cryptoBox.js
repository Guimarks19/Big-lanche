const crypto = require('node:crypto');
const { AppError } = require('./errors');

function encryptSecret(value, env) {
  const text = String(value || '');
  if (!text) return null;

  const key = resolveEncryptionKey(env);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

function decryptSecret(value, env) {
  if (!value) return null;
  const [version, ivRaw, tagRaw, encryptedRaw] = String(value).split(':');
  if (version !== 'v1' || !ivRaw || !tagRaw || !encryptedRaw) {
    throw new AppError('Token criptografado inválido.', 500, 'INVALID_ENCRYPTED_SECRET');
  }

  const key = resolveEncryptionKey(env);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, 'base64url')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

function resolveEncryptionKey(env) {
  const configured = env?.ENCRYPTION_KEY || '';
  if (configured) {
    const key = parseKey(configured);
    if (key.length !== 32) {
      throw new AppError('ENCRYPTION_KEY precisa ter 32 bytes em base64, hex ou texto.', 500, 'INVALID_ENCRYPTION_KEY');
    }
    return key;
  }

  if (env?.NODE_ENV === 'production') {
    throw new AppError('Configure ENCRYPTION_KEY para criptografar tokens sensíveis.', 500, 'ENCRYPTION_KEY_REQUIRED');
  }

  return crypto.createHash('sha256').update('big-lanche-development-encryption-key').digest();
}

function parseKey(value) {
  if (/^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  try {
    const base64 = Buffer.from(value, 'base64');
    if (base64.length === 32) return base64;
  } catch {
    // Continua para o fallback textual.
  }
  return Buffer.from(value, 'utf8');
}

module.exports = { decryptSecret, encryptSecret, resolveEncryptionKey };
