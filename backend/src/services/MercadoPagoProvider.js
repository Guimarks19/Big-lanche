const {
  InvalidWebhookSignatureError,
  WebhookSignatureValidator,
} = require('mercadopago');
const { MercadoPagoError, AppError } = require('../utils/errors');
const { centsToDecimal } = require('../utils/money');

class MercadoPagoProvider {
  constructor(env, fetchImpl = global.fetch) {
    this.env = env;
    this.fetch = fetchImpl;
  }

  async listTerminals({ limit = 50, offset = 0, store_id, pos_id, accessToken } = {}) {
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (store_id) query.set('store_id', store_id);
    if (pos_id) query.set('pos_id', pos_id);
    return this.request(`/terminals/v1/list?${query.toString()}`, { method: 'GET', accessToken });
  }

  async setupTerminalMode(providerTerminalId, operatingMode, accessToken = null) {
    return this.request('/terminals/v1/setup', {
      method: 'PATCH',
      accessToken,
      body: {
        terminals: [
          {
            id: providerTerminalId,
            operating_mode: operatingMode,
          },
        ],
      },
    });
  }

  async createPointOrder(input) {
    const terminalId = input.terminalId || this.env.MERCADO_PAGO_TERMINAL_ID;
    if (!terminalId) {
      throw new AppError('Configure MERCADO_PAGO_TERMINAL_ID no backend.', 400, 'TERMINAL_ID_REQUIRED');
    }

    const paymentMethod = {
      default_type: input.mercadoPagoPaymentType,
    };

    if (input.mercadoPagoPaymentType === 'credit_card') {
      paymentMethod.default_installments = this.env.MERCADOPAGO_DEFAULT_INSTALLMENTS;
      paymentMethod.installments_cost = this.env.MERCADOPAGO_INSTALLMENTS_COST;
    }

    const body = {
      type: 'point',
      external_reference: input.externalReference,
      expiration_time: this.env.MERCADOPAGO_ORDER_EXPIRATION,
      transactions: {
        payments: [
          {
            amount: centsToDecimal(input.amountCents),
          },
        ],
      },
      config: {
        point: {
          terminal_id: terminalId,
          print_on_terminal: this.env.MERCADOPAGO_PRINT_ON_TERMINAL,
        },
        payment_method: paymentMethod,
      },
      description: input.description || 'Venda PDV',
    };

    return this.request('/v1/orders', {
      method: 'POST',
      idempotencyKey: input.idempotencyKey,
      body,
    });
  }

  async createPointCharge({ amountCents, saleId, terminalId, idempotencyKey, paymentType, description }) {
    return this.createPointOrder({
      amountCents,
      externalReference: buildSaleExternalReference(saleId),
      idempotencyKey,
      mercadoPagoPaymentType: paymentType || 'credit_card',
      description: description || `Venda ${saleId}`,
      terminalId,
    });
  }

  async getOrder(orderId, options = {}) {
    return this.request(`/v1/orders/${encodeURIComponent(orderId)}`, {
      method: 'GET',
      accessToken: options.accessToken,
    });
  }

  async cancelOrder(orderId, idempotencyKey) {
    return this.request(`/v1/orders/${encodeURIComponent(orderId)}/cancel`, {
      method: 'POST',
      idempotencyKey,
    });
  }

  async refundOrder(orderId, idempotencyKey) {
    return this.request(`/v1/orders/${encodeURIComponent(orderId)}/refund`, {
      method: 'POST',
      idempotencyKey,
    });
  }

  async simulateOrderEvent(orderId, payload) {
    return this.request(`/v1/orders/${encodeURIComponent(orderId)}/events`, {
      method: 'POST',
      body: payload,
    });
  }

  validateWebhookSignature({ xSignature, xRequestId, dataId }) {
    if (!this.env.MERCADOPAGO_WEBHOOK_SIGNATURE_REQUIRED) return;
    if (!this.env.MERCADO_PAGO_WEBHOOK_SECRET) {
      throw new AppError(
        'Configure MERCADO_PAGO_WEBHOOK_SECRET para validar Webhooks.',
        500,
        'WEBHOOK_SECRET_REQUIRED',
      );
    }

    WebhookSignatureValidator.validate({
      xSignature,
      xRequestId,
      dataId,
      secret: this.env.MERCADO_PAGO_WEBHOOK_SECRET,
    });
  }

  async exchangeOAuthCode({ code, redirectUri, codeVerifier, testToken = false }) {
    return this.requestWithoutAccessToken('/oauth/token', {
      method: 'POST',
      body: {
        client_id: this.env.MERCADO_PAGO_CLIENT_ID,
        client_secret: this.env.MERCADO_PAGO_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
        ...(testToken ? { test_token: 'true' } : {}),
      },
    });
  }

  async refreshOAuthToken(refreshToken) {
    return this.requestWithoutAccessToken('/oauth/token', {
      method: 'POST',
      body: {
        client_id: this.env.MERCADO_PAGO_CLIENT_ID,
        client_secret: this.env.MERCADO_PAGO_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      },
    });
  }

  async getAuthenticatedUser(accessToken) {
    return this.request('/users/me', { method: 'GET', accessToken });
  }

  async request(path, { method = 'GET', body, idempotencyKey, accessToken } = {}) {
    const token = accessToken || this.env.MERCADO_PAGO_ACCESS_TOKEN;
    this.ensureAccessToken(token);

    const response = await this.fetch(`${this.env.MERCADOPAGO_API_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const raw = await response.text();
    const data = raw ? tryParseJson(raw) : null;

    if (!response.ok) {
      throw new MercadoPagoError(
        data?.message || data?.error || 'Falha na comunicacao com Mercado Pago.',
        response.status,
        data?.error || 'MERCADOPAGO_REQUEST_FAILED',
        data,
      );
    }

    return data;
  }

  async requestWithoutAccessToken(path, { method = 'GET', body } = {}) {
    const response = await this.fetch(`${this.env.MERCADOPAGO_API_BASE_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });

    const raw = await response.text();
    const data = raw ? tryParseJson(raw) : null;
    if (!response.ok) {
      throw new MercadoPagoError(
        data?.message || data?.error || 'Falha na comunicacao com Mercado Pago.',
        response.status,
        data?.error || 'MERCADOPAGO_REQUEST_FAILED',
        data,
      );
    }
    return data;
  }

  ensureAccessToken(accessToken) {
    if (!accessToken) {
      throw new AppError(
        'Configure MERCADO_PAGO_ACCESS_TOKEN no backend antes de chamar o Mercado Pago.',
        400,
        'MERCADO_PAGO_ACCESS_TOKEN_REQUIRED',
      );
    }
  }
}

function buildSaleExternalReference(saleId) {
  const normalized = Number(saleId);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new AppError('ID da venda invalido para external_reference.', 400, 'INVALID_SALE_ID');
  }
  return `VENDA_${normalized}`;
}

function tryParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

module.exports = {
  buildSaleExternalReference,
  InvalidWebhookSignatureError,
  MercadoPagoProvider,
};
