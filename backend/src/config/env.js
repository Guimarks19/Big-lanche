const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config();

const rootDir = path.resolve(__dirname, '../../..');

function boolFromEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return String(value).toLowerCase() === 'true';
}

function intFromEnv(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function resolveProjectPath(value, fallback) {
  const rawPath = value || fallback;
  if (rawPath === ':memory:') return rawPath;
  return path.isAbsolute(rawPath) ? rawPath : path.join(rootDir, rawPath);
}

function loadEnv(overrides = {}) {
  const merged = { ...process.env, ...overrides };

  return {
    NODE_ENV: merged.NODE_ENV || 'development',
    PORT: intFromEnv(merged.PORT, 3000),
    DATABASE_PATH: resolveProjectPath(merged.DATABASE_PATH, 'backend/data/pdv.sqlite'),
    MERCADOPAGO_PUBLIC_KEY: merged.MERCADOPAGO_PUBLIC_KEY || '',
    MERCADOPAGO_ACCESS_TOKEN: merged.MERCADOPAGO_ACCESS_TOKEN || '',
    MERCADOPAGO_CLIENT_ID: merged.MERCADOPAGO_CLIENT_ID || '',
    MERCADOPAGO_CLIENT_SECRET: merged.MERCADOPAGO_CLIENT_SECRET || '',
    MERCADOPAGO_WEBHOOK_SECRET: merged.MERCADOPAGO_WEBHOOK_SECRET || '',
    MERCADOPAGO_TERMINAL_ID: merged.MERCADOPAGO_TERMINAL_ID || '',
    MERCADOPAGO_API_BASE_URL: merged.MERCADOPAGO_API_BASE_URL || 'https://api.mercadopago.com',
    MERCADOPAGO_CARD_DEFAULT_TYPE: merged.MERCADOPAGO_CARD_DEFAULT_TYPE || 'credit_card',
    MERCADOPAGO_DEFAULT_INSTALLMENTS: intFromEnv(merged.MERCADOPAGO_DEFAULT_INSTALLMENTS, 1),
    MERCADOPAGO_INSTALLMENTS_COST: merged.MERCADOPAGO_INSTALLMENTS_COST || 'seller',
    MERCADOPAGO_PRINT_ON_TERMINAL: merged.MERCADOPAGO_PRINT_ON_TERMINAL || 'no_ticket',
    MERCADOPAGO_ORDER_EXPIRATION: merged.MERCADOPAGO_ORDER_EXPIRATION || 'PT16M',
    MERCADOPAGO_ENABLE_QR: boolFromEnv(merged.MERCADOPAGO_ENABLE_QR, false),
    MERCADOPAGO_WEBHOOK_SIGNATURE_REQUIRED: boolFromEnv(
      merged.MERCADOPAGO_WEBHOOK_SIGNATURE_REQUIRED,
      true,
    ),
    ENABLE_TEST_ENDPOINTS: boolFromEnv(merged.ENABLE_TEST_ENDPOINTS, false),
  };
}

module.exports = { loadEnv, rootDir };
