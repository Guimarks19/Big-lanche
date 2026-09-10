const { get, insert, run } = require('../database/connection');
const { AppError, MercadoPagoError } = require('../utils/errors');
const { InvalidWebhookSignatureError } = require('./MercadoPagoProvider');

class WebhookService {
  constructor(db, paymentService, provider, connectionService = null) {
    this.db = db;
    this.paymentService = paymentService;
    this.provider = provider;
    this.connectionService = connectionService;
  }

  async handleMercadoPago(req) {
    const webhookPayload = extractWebhookPayload(req);
    const { type, orderId, signatureDataId, embeddedOrder } = webhookPayload;
    const dataId = orderId;
    const action = req.body?.action || req.query?.action || 'unknown';
    const resourceType = type || 'unknown';
    const requestId = req.headers['x-request-id'] || null;
    const mercadoPagoUserId = req.body?.user_id || req.query?.user_id || null;

    if (!orderId) {
      console.info('[MercadoPagoWebhook] Notificacao recebida sem orderId.', {
        action,
        type,
        request_id: requestId,
      });
      return { received: true };
    }

    if (type !== 'order') {
      console.info('[MercadoPagoWebhook] Notificacao ignorada: type diferente de order.', {
        action,
        type,
        order_id: orderId,
        request_id: requestId,
      });
      return { received: true, ignored: true, reason: 'UNSUPPORTED_WEBHOOK_TYPE' };
    }

    if (!isMercadoPagoOrderId(dataId)) {
      const event = await this.registerEvent({
        dataId,
        action,
        resourceType,
        requestId,
        body: req.body,
        mercadoPagoUserId,
      });

      console.info('[MercadoPagoWebhook] Simulacao recebida sem ID real de order.', {
        action,
        data_id: dataId,
        embedded_status: embeddedOrder?.status || null,
        embedded_external_reference: embeddedOrder?.external_reference || null,
        request_id: requestId,
      });
      await this.markEvent(event.id, 'IGNORED', `Simulacao sem order real: ${dataId}`);
      return { received: true, ignored: true, simulation: true, reason: 'SIMULATED_ORDER_ID' };
    }

    try {
      this.provider.validateWebhookSignature({
        xSignature: req.headers['x-signature'],
        xRequestId: requestId,
        dataId: signatureDataId,
      });
    } catch (error) {
      if (error instanceof InvalidWebhookSignatureError) {
        console.warn('[MercadoPagoWebhook] Assinatura invalida.', {
          action,
          data_id: signatureDataId,
          request_id: requestId,
        });
        throw new AppError('Assinatura do Webhook invalida.', 401, 'INVALID_WEBHOOK_SIGNATURE');
      }
      throw error;
    }

    const connection = this.connectionService
      ? await this.connectionService.getConnectionByMercadoPagoUserId(mercadoPagoUserId)
      : null;
    const event = await this.registerEvent({
      dataId,
      action,
      resourceType,
      requestId,
      body: req.body,
      userId: connection?.user_id || null,
      mercadoPagoUserId,
    });

    if (event.duplicate && event.status === 'PROCESSED') {
      console.info('[MercadoPagoWebhook] Notificacao duplicada ja processada.', {
        action,
        data_id: dataId,
        request_id: requestId,
      });
      return { received: true, duplicate: true };
    }

    try {
      const accessToken = this.connectionService
        ? await this.connectionService.getAccessTokenForMercadoPagoUser(mercadoPagoUserId)
        : null;
      const order = await this.provider.getOrder(dataId, { accessToken });
      console.info('[MercadoPagoWebhook] Order real consultada no Mercado Pago.', {
        action,
        order_id: dataId,
        status: order?.status || null,
        external_reference: order?.external_reference || null,
        request_id: requestId,
      });
      const sale = await this.paymentService.applyProviderOrder(order, {
        userId: connection?.user_id || null,
        mercadoPagoUserId,
        action,
      });
      await this.markEvent(event.id, 'PROCESSED');
      return { received: true, sale };
    } catch (error) {
      if (shouldIgnoreWebhookError(error, { dataId, embeddedOrder })) {
        console.info('[MercadoPagoWebhook] Order nao processada, mas webhook recebido com sucesso.', {
          action,
          data_id: dataId,
          error_code: error.code || error.name,
          error_status: error.statusCode || null,
          simulation: isLikelySimulation(dataId, embeddedOrder, error),
          request_id: requestId,
        });
        await this.markEvent(event.id, 'IGNORED', error.message);
        return {
          received: true,
          ignored: true,
          simulation: isLikelySimulation(dataId, embeddedOrder, error),
          reason: error.code || 'ORDER_LOOKUP_IGNORED',
        };
      }
      await this.markEvent(event.id, 'FAILED', error.message);
      throw error;
    }
  }

  async registerEvent({ dataId, action, resourceType, requestId, body, userId = null, mercadoPagoUserId = null }) {
    const processedSameAction = await get(
      this.db,
      `SELECT * FROM webhook_events
       WHERE provider = ?
         AND data_id = ?
         AND action = ?
         AND status = 'PROCESSED'
       ORDER BY id DESC
       LIMIT 1`,
      ['mercadopago', dataId, action],
    );
    if (processedSameAction) return { ...processedSameAction, duplicate: true };

    const eventKey = [requestId || body?.id || 'no-request-id', dataId, action].join(':');
    const existing = await get(
      this.db,
      'SELECT * FROM webhook_events WHERE provider = ? AND event_key = ?',
      ['mercadopago', eventKey],
    );

    if (existing) return { ...existing, duplicate: true };

    const rawBody = {
      ...(body || {}),
      ...(mercadoPagoUserId ? { mercado_pago_user_id: mercadoPagoUserId } : {}),
    };

    const id = await insert(
      this.db,
      `INSERT INTO webhook_events
       (user_id, provider, event_key, request_id, data_id, action, resource_type, raw_body)
       VALUES (?, 'mercadopago', ?, ?, ?, ?, ?, ?)`,
      [userId, eventKey, requestId, dataId, action, resourceType, JSON.stringify(rawBody)],
    );

    return {
      id,
      event_key: eventKey,
      status: 'RECEIVED',
      duplicate: false,
    };
  }

  async markEvent(id, status, errorMessage = null) {
    await run(
      this.db,
      `UPDATE webhook_events
       SET status = ?, error_message = ?, processed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [status, errorMessage, id],
    );
  }
}

function shouldIgnoreWebhookError(error, context = {}) {
  return (
    (error instanceof AppError &&
      ['PROVIDER_ORDER_NOT_POINT', 'PROVIDER_ORDER_AMOUNT_REQUIRED'].includes(error.code)) ||
    (error instanceof MercadoPagoError &&
      (error.code === 'order_not_found' ||
        error.statusCode === 404 ||
        (isLikelySimulation(context.dataId, context.embeddedOrder, error) && error.statusCode === 400)))
  );
}

function extractSignatureDataId(req) {
  return (
    req.query?.['data.id'] ||
    req.query?.data_id ||
    req.body?.data?.id ||
    req.body?.id ||
    null
  );
}

function extractWebhookPayload(req) {
  const type = req.body?.type || req.query?.type;
  const signatureDataId = extractSignatureDataId(req);
  const processableOrderId = extractProcessableOrderId(req);

  return {
    type,
    orderId: processableOrderId,
    signatureDataId,
    embeddedOrder: extractEmbeddedOrder(req.body),
  };
}

function extractProcessableOrderId(req) {
  const candidates = [
    req.body?.data?.id,
    req.query?.['data.id'],
    req.query?.data_id,
    req.body?.id,
  ].filter(Boolean);

  return candidates.find(isMercadoPagoOrderId) || candidates[0] || null;
}

function extractEmbeddedOrder(body = {}) {
  const data = body?.data;
  if (!data || typeof data !== 'object') return null;

  if (
    data.status ||
    data.status_detail ||
    data.external_reference ||
    data.transactions ||
    data.total_paid_amount ||
    data.type
  ) {
    return data;
  }

  return null;
}

function isMercadoPagoOrderId(value) {
  return /^ORD/i.test(String(value || '').trim());
}

function isLikelySimulation(dataId, embeddedOrder, error) {
  return (
    !isMercadoPagoOrderId(dataId) ||
    Boolean(embeddedOrder) ||
    error?.code === 'order_not_found' ||
    error?.statusCode === 404
  );
}

module.exports = {
  WebhookService,
  extractEmbeddedOrder,
  extractProcessableOrderId,
  extractSignatureDataId,
  extractWebhookPayload,
  isMercadoPagoOrderId,
  shouldIgnoreWebhookError,
};
