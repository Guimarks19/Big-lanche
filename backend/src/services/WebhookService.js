const { get, run } = require('../database/connection');
const { AppError } = require('../utils/errors');
const { InvalidWebhookSignatureError } = require('./MercadoPagoProvider');

class WebhookService {
  constructor(db, paymentService, provider) {
    this.db = db;
    this.paymentService = paymentService;
    this.provider = provider;
  }

  async handleMercadoPago(req) {
    const dataId = extractDataId(req);
    const action = req.body?.action || req.query?.action || 'unknown';
    const resourceType = req.body?.type || req.query?.type || 'unknown';
    const requestId = req.headers['x-request-id'] || null;

    try {
      this.provider.validateWebhookSignature({
        xSignature: req.headers['x-signature'],
        xRequestId: requestId,
        dataId,
      });
    } catch (error) {
      if (error instanceof InvalidWebhookSignatureError) {
        throw new AppError('Assinatura do Webhook invalida.', 401, 'INVALID_WEBHOOK_SIGNATURE');
      }
      throw error;
    }

    if (!dataId) {
      throw new AppError('Webhook sem data.id.', 400, 'WEBHOOK_DATA_ID_REQUIRED');
    }

    const event = this.registerEvent({
      dataId,
      action,
      resourceType,
      requestId,
      body: req.body,
    });

    if (event.duplicate && event.status === 'PROCESSED') {
      return { received: true, duplicate: true };
    }

    if (resourceType !== 'order') {
      this.markEvent(event.id, 'IGNORED');
      return { received: true, ignored: true };
    }

    try {
      const order = await this.provider.getOrder(dataId);
      const sale = this.paymentService.applyProviderOrder(order);
      this.markEvent(event.id, 'PROCESSED');
      return { received: true, sale };
    } catch (error) {
      if (error instanceof AppError && error.code === 'SALE_NOT_FOUND_FOR_ORDER') {
        this.markEvent(event.id, 'IGNORED', error.message);
        return { received: true, ignored: true };
      }
      this.markEvent(event.id, 'FAILED', error.message);
      throw error;
    }
  }

  registerEvent({ dataId, action, resourceType, requestId, body }) {
    const eventKey = [requestId || body?.id || 'no-request-id', dataId, action].join(':');
    const existing = get(
      this.db,
      'SELECT * FROM webhook_events WHERE provider = ? AND event_key = ?',
      ['mercadopago', eventKey],
    );

    if (existing) return { ...existing, duplicate: true };

    const result = run(
      this.db,
      `INSERT INTO webhook_events
       (provider, event_key, request_id, data_id, action, resource_type, raw_body)
       VALUES ('mercadopago', ?, ?, ?, ?, ?, ?)`,
      [eventKey, requestId, dataId, action, resourceType, JSON.stringify(body || {})],
    );

    return {
      id: result.lastInsertRowid,
      event_key: eventKey,
      status: 'RECEIVED',
      duplicate: false,
    };
  }

  markEvent(id, status, errorMessage = null) {
    run(
      this.db,
      `UPDATE webhook_events
       SET status = ?, error_message = ?, processed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [status, errorMessage, id],
    );
  }
}

function extractDataId(req) {
  return (
    req.query?.['data.id'] ||
    req.query?.data_id ||
    req.body?.data?.id ||
    req.body?.id ||
    null
  );
}

module.exports = { WebhookService, extractDataId };
