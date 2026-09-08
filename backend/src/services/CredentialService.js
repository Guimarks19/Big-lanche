const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../utils/errors');
const { rootDir } = require('../config/env');

const MERCADO_PAGO_KEYS = [
  'MERCADO_PAGO_PUBLIC_KEY',
  'MERCADO_PAGO_ACCESS_TOKEN',
  'MERCADO_PAGO_CLIENT_ID',
  'MERCADO_PAGO_CLIENT_SECRET',
  'MERCADO_PAGO_WEBHOOK_SECRET',
  'MERCADO_PAGO_TERMINAL_ID',
];

const INTERNAL_ENV_ALIASES = {
  MERCADO_PAGO_PUBLIC_KEY: 'MERCADOPAGO_PUBLIC_KEY',
  MERCADO_PAGO_ACCESS_TOKEN: 'MERCADOPAGO_ACCESS_TOKEN',
  MERCADO_PAGO_CLIENT_ID: 'MERCADOPAGO_CLIENT_ID',
  MERCADO_PAGO_CLIENT_SECRET: 'MERCADOPAGO_CLIENT_SECRET',
  MERCADO_PAGO_WEBHOOK_SECRET: 'MERCADOPAGO_WEBHOOK_SECRET',
  MERCADO_PAGO_TERMINAL_ID: 'MERCADOPAGO_TERMINAL_ID',
};

class CredentialService {
  constructor(env, options = {}) {
    this.env = env;
    this.envFilePath = options.envFilePath || path.join(rootDir, '.env');
  }

  getStatus() {
    return {
      public_key: this.describeKey('MERCADO_PAGO_PUBLIC_KEY'),
      access_token: this.describeKey('MERCADO_PAGO_ACCESS_TOKEN'),
      client_id: this.describeKey('MERCADO_PAGO_CLIENT_ID'),
      client_secret: this.describeKey('MERCADO_PAGO_CLIENT_SECRET'),
      webhook_secret: this.describeKey('MERCADO_PAGO_WEBHOOK_SECRET'),
      terminal_id: this.describeKey('MERCADO_PAGO_TERMINAL_ID'),
    };
  }

  save(input = {}) {
    const nextValues = {};
    const fieldMap = {
      public_key: 'MERCADO_PAGO_PUBLIC_KEY',
      access_token: 'MERCADO_PAGO_ACCESS_TOKEN',
      client_id: 'MERCADO_PAGO_CLIENT_ID',
      client_secret: 'MERCADO_PAGO_CLIENT_SECRET',
      webhook_secret: 'MERCADO_PAGO_WEBHOOK_SECRET',
      terminal_id: 'MERCADO_PAGO_TERMINAL_ID',
    };

    for (const [field, key] of Object.entries(fieldMap)) {
      if (Object.prototype.hasOwnProperty.call(input, field)) {
        const value = sanitizeEnvValue(input[field]);
        if (value) nextValues[key] = value;
      }
    }

    if (Object.keys(nextValues).length === 0) {
      throw new AppError('Informe ao menos uma credencial para salvar.', 400, 'NO_CREDENTIALS_TO_SAVE');
    }

    for (const [key, value] of Object.entries(nextValues)) {
      setEnvValue(this.env, key, value);
    }

    writeEnvValues(this.envFilePath, nextValues);
    return this.getStatus();
  }

  describeKey(key) {
    const value = this.env[key] || '';
    return {
      configured: Boolean(value),
      masked: value ? maskValue(value) : null,
    };
  }
}

function sanitizeEnvValue(value) {
  return String(value || '').replace(/[\r\n]/g, '').trim();
}

function maskValue(value) {
  if (value.length <= 8) return '********';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function setEnvValue(env, key, value) {
  env[key] = value;
  const alias = INTERNAL_ENV_ALIASES[key];
  if (alias) env[alias] = value;
}

function writeEnvValues(envFilePath, values) {
  fs.mkdirSync(path.dirname(envFilePath), { recursive: true });

  const existing = fs.existsSync(envFilePath) ? fs.readFileSync(envFilePath, 'utf8') : '';
  const lines = existing ? existing.split(/\r?\n/) : [];
  const writtenKeys = new Set();

  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match) return line;

    const key = match[1];
    if (!Object.prototype.hasOwnProperty.call(values, key)) return line;

    writtenKeys.add(key);
    return `${key}=${values[key]}`;
  });

  for (const key of MERCADO_PAGO_KEYS) {
    if (Object.prototype.hasOwnProperty.call(values, key) && !writtenKeys.has(key)) {
      nextLines.push(`${key}=${values[key]}`);
    }
  }

  fs.writeFileSync(envFilePath, `${nextLines.join('\n').replace(/\n+$/g, '')}\n`, 'utf8');
}

module.exports = { CredentialService, writeEnvValues };
