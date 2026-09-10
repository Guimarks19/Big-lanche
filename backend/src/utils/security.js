const crypto = require('node:crypto');
const { AppError } = require('./errors');

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function addHours(date, hours) {
  return addMinutes(date, hours * 60);
}

function addDays(date, days) {
  return addHours(date, days * 24);
}

function toSqlDate(date) {
  return date.toISOString();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function assertValidEmail(email) {
  const normalized = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 254) {
    throw new AppError('Informe um e-mail valido.', 400, 'INVALID_EMAIL');
  }
  return normalized;
}

function passwordRequirements(password) {
  const value = String(password || '');
  return {
    min_length: value.length >= 8,
    uppercase: /[A-Z]/.test(value),
    lowercase: /[a-z]/.test(value),
    number: /\d/.test(value),
  };
}

function assertStrongPassword(password) {
  const requirements = passwordRequirements(password);
  const valid = Object.values(requirements).every(Boolean);
  if (!valid) {
    throw new AppError('A senha precisa ter 8 caracteres, letra maiuscula, letra minuscula e numero.', 400, 'WEAK_PASSWORD', {
      requirements,
    });
  }
}

function maskEmail(email) {
  const normalized = normalizeEmail(email);
  const [name, domain] = normalized.split('@');
  if (!name || !domain) return normalized;
  const visible = name.slice(0, Math.min(2, name.length));
  return `${visible}${'*'.repeat(Math.max(3, name.length - visible.length))}@${domain}`;
}

function serializeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    email_verified: Boolean(row.email_verified),
    email_verified_at: row.email_verified_at,
    role: row.role,
    active: Boolean(row.active),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

module.exports = {
  addDays,
  addHours,
  addMinutes,
  assertStrongPassword,
  assertValidEmail,
  hashToken,
  maskEmail,
  normalizeEmail,
  passwordRequirements,
  randomToken,
  serializeUser,
  toSqlDate,
};
