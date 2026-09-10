const { randomUUID } = require('node:crypto');
const { all, get, insert, run, withTransaction } = require('../database/connection');
const { AppError } = require('../utils/errors');
const { decimalToCents } = require('../utils/money');
const { buildSaleExternalReference } = require('./MercadoPagoProvider');

class PaymentService {
  constructor(db, saleService, cashRegisterService, provider, env, terminalService) {
    this.db = db;
    this.saleService = saleService;
    this.cashRegisterService = cashRegisterService;
    this.provider = provider;
    this.env = env;
    this.terminalService = terminalService;
  }

  async startPayment(saleId, requestedMethod, context = {}) {
    const sale = await this.saleService.getSale(saleId, context);
    const paymentMethod = requestedMethod ? String(requestedMethod).toUpperCase() : sale.payment_method;

    if (sale.status !== 'PENDING') {
      throw new AppError('Apenas vendas pendentes podem iniciar pagamento.', 409, 'SALE_NOT_PENDING');
    }
    if (paymentMethod !== sale.payment_method) {
      throw new AppError('Metodo de pagamento diferente do informado na venda.', 400, 'PAYMENT_METHOD_MISMATCH');
    }
    if (sale.provider_order_id) {
      return this.saleService.getSale(sale.id, context);
    }

    const mercadoPagoPaymentType = this.mapPaymentMethod(paymentMethod);
    const externalReference = await this.ensureSaleExternalReference(sale);
    const order = await this.provider.createPointCharge({
      amountCents: sale.total_cents,
      saleId: sale.id,
      idempotencyKey: sale.idempotency_key,
      paymentType: mercadoPagoPaymentType,
      description: `Venda ${externalReference}`,
      terminalId: await this.getConfiguredTerminalId(context.userId),
    });

    await withTransaction(this.db, async (tx) => {
      const payment = extractPrimaryPayment(order);
      const transactionId = extractTransactionId(payment);

      await run(
        tx,
        `UPDATE sales
         SET provider_order_id = ?, provider_payment_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [order.id, transactionId, sale.id],
      );

      await upsertPayment(tx, {
        saleId: sale.id,
        providerOrderId: order.id,
        transactionId,
        amountCents: sale.total_cents,
        paymentMethod,
        status: mapOrderToInternalStatus(order, payment),
        statusDetail: order.status_detail || payment?.status_detail || null,
        rawResponse: order,
        ...extractProviderMetadata(order, payment, context),
      });
    });

    return this.saleService.getSale(sale.id, context);
  }

  assertCanStart(paymentMethod) {
    this.mapPaymentMethod(String(paymentMethod || '').toUpperCase());

    if (!this.env.MERCADO_PAGO_ACCESS_TOKEN) {
      throw new AppError(
        'Configure MERCADO_PAGO_ACCESS_TOKEN no backend antes de chamar o Mercado Pago.',
        400,
        'MERCADO_PAGO_ACCESS_TOKEN_REQUIRED',
      );
    }

    // O terminal ativo pode vir da conexao OAuth do usuario e e resolvido em startPayment.
  }

  async getConfiguredTerminalId(userId = null) {
    return (await this.terminalService?.getActiveTerminalId(userId)) || this.env.MERCADO_PAGO_TERMINAL_ID;
  }

  async syncSalePaymentStatus(saleId, context = {}) {
    const sale = await this.saleService.getSale(saleId, context);
    if (!sale.provider_order_id) return sale;
    const order = await this.provider.getOrder(sale.provider_order_id);
    return this.applyProviderOrder(order, context);
  }

  async cancelPendingPayment(saleId, context = {}) {
    const sale = await this.saleService.getSale(saleId, context);
    if (sale.status !== 'PENDING' && sale.status !== 'ACTION_REQUIRED') {
      throw new AppError('Apenas vendas pendentes podem ser canceladas.', 409, 'SALE_NOT_CANCELABLE');
    }

    if (sale.provider_order_id) {
      await this.provider.cancelOrder(sale.provider_order_id, randomUUID());
    }

    await withTransaction(this.db, async (tx) => {
      await run(
        tx,
        "UPDATE sales SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'APPROVED'",
        [sale.id],
      );
    });

    return this.saleService.getSale(sale.id, context);
  }

  async applyProviderOrder(order, context = {}) {
    const payment = extractPrimaryPayment(order);
    const transactionId = extractTransactionId(payment);
    const providerOrderId = order?.id;
    const externalReference = order?.external_reference;
    let sale =
      (externalReference && (await this.saleService.getSaleByExternalReference(externalReference))) ||
      (providerOrderId && (await this.saleService.getSaleByProviderOrderId(providerOrderId)));

    if (!sale) {
      sale = await this.createSaleFromProviderOrder(order, context);
    }

    const nextStatus = mapOrderToInternalStatus(order, payment);
    const amountCents = extractPaidAmountCents(order, payment) || sale.total_cents;
    const statusDetail = order.status_detail || payment?.status_detail || null;

    await withTransaction(this.db, async (tx) => {
      const currentSale = await get(tx, 'SELECT * FROM sales WHERE id = ?', [sale.id]);

      await upsertPayment(tx, {
        saleId: sale.id,
        providerOrderId: providerOrderId || currentSale.provider_order_id,
        transactionId,
        amountCents,
        paymentMethod: sale.payment_method,
        status: nextStatus,
        statusDetail,
        rawResponse: order,
        ...extractProviderMetadata(order, payment, context),
      });

      if (providerOrderId && !currentSale.provider_order_id) {
        await run(tx, 'UPDATE sales SET provider_order_id = ? WHERE id = ?', [providerOrderId, sale.id]);
      }
      if (transactionId) {
        await run(tx, 'UPDATE sales SET provider_payment_id = ? WHERE id = ?', [transactionId, sale.id]);
      }

      if (nextStatus === 'APPROVED') {
        if (amountCents !== currentSale.total_cents) {
          await run(
            tx,
            "UPDATE sales SET status = 'ACTION_REQUIRED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            [sale.id],
          );
          await run(
            tx,
            `UPDATE payments
             SET status = 'AMOUNT_MISMATCH',
                 status_detail = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE sale_id = ?`,
            [`paid=${amountCents}; expected=${currentSale.total_cents}`, sale.id],
          );
          return;
        }

        await this.approveSale(currentSale, transactionId, tx);
        return;
      }

      if (nextStatus === 'REFUNDED') {
        await this.refundSale(currentSale, transactionId, tx);
        return;
      }

      if (currentSale.status !== 'APPROVED' && currentSale.status !== 'REFUNDED') {
        await run(
          tx,
          'UPDATE sales SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [nextStatus, sale.id],
        );
      }
    });

    return this.saleService.getSale(sale.id, sale.user_id ? { userId: sale.user_id } : {});
  }

  async createSaleFromProviderOrder(order, context = {}) {
    const providerOrderId = order?.id;
    if (!providerOrderId) {
      throw new AppError('Order do Mercado Pago sem ID.', 400, 'PROVIDER_ORDER_ID_REQUIRED');
    }

    if (order?.type && order.type !== 'point') {
      throw new AppError('Order recebida nao e do Mercado Pago Point.', 400, 'PROVIDER_ORDER_NOT_POINT');
    }

    const payment = extractPrimaryPayment(order);
    const transactionId = extractTransactionId(payment);
    const totalCents = extractProviderAmountCents(order, payment);
    if (!Number.isInteger(totalCents) || totalCents <= 0) {
      throw new AppError(
        'Order do Mercado Pago sem valor valido para cadastro de venda.',
        400,
        'PROVIDER_ORDER_AMOUNT_REQUIRED',
      );
    }

    const userId = await this.resolveUserIdForOrder(order, context);
    const saleId = await withTransaction(this.db, async (tx) => {
      const existing =
        (await this.saleService.getSaleByProviderOrderId(providerOrderId)) ||
        (order.external_reference && (await this.saleService.getSaleByExternalReference(order.external_reference)));
      if (existing) return existing.id;

      const cashRegister = await this.cashRegisterService.ensureOpen(userId, tx);
      const externalReference = sanitizeExternalReference(order.external_reference, providerOrderId);
      const paymentMethod = mapProviderPaymentMethod(payment, order);

      const createdSaleId = await insert(
        tx,
        `INSERT INTO sales
         (user_id, total_cents, status, payment_method, external_reference, provider_order_id, provider_payment_id,
          idempotency_key, cash_register_id, source)
         VALUES (?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, 'MERCADOPAGO_WEBHOOK')`,
        [
          userId || null,
          totalCents,
          paymentMethod,
          externalReference,
          providerOrderId,
          transactionId,
          `mp_order_${providerOrderId}`,
          cashRegister.id,
        ],
      );

      await upsertTerminalFromOrder(tx, order, userId);
      return createdSaleId;
    });

    return this.saleService.getSale(saleId, userId ? { userId } : {});
  }

  async ensureSaleExternalReference(sale) {
    const externalReference = buildSaleExternalReference(sale.id);
    if (sale.external_reference === externalReference) return externalReference;

    await run(this.db, 'UPDATE sales SET external_reference = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
      externalReference,
      sale.id,
    ]);
    return externalReference;
  }

  async approveSale(currentSale, transactionId, db = this.db) {
    if (currentSale.status === 'APPROVED') return;

    await run(
      db,
      "UPDATE sales SET status = 'APPROVED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [currentSale.id],
    );

    await run(
      db,
      `INSERT INTO cash_movements
       (user_id, cash_register_id, sale_id, type, amount_cents, payment_method, description, provider_payment_id)
       VALUES (?, ?, ?, 'SALE', ?, ?, ?, ?)
       ON CONFLICT(sale_id, type) DO NOTHING`,
      [
        currentSale.user_id || null,
        currentSale.cash_register_id,
        currentSale.id,
        currentSale.total_cents,
        currentSale.payment_method,
        `Venda ${currentSale.external_reference}`,
        transactionId,
      ],
    );
  }

  async refundSale(currentSale, transactionId, db = this.db) {
    if (currentSale.status === 'REFUNDED') return;

    if (currentSale.status === 'APPROVED') {
      await run(
        db,
        `INSERT INTO cash_movements
         (user_id, cash_register_id, sale_id, type, amount_cents, payment_method, description, provider_payment_id)
         VALUES (?, ?, ?, 'REFUND', ?, ?, ?, ?)
         ON CONFLICT(sale_id, type) DO NOTHING`,
        [
          currentSale.user_id || null,
          currentSale.cash_register_id,
          currentSale.id,
          -currentSale.total_cents,
          currentSale.payment_method,
          `Estorno ${currentSale.external_reference}`,
          transactionId,
        ],
      );
    }

    await run(
      db,
      "UPDATE sales SET status = 'REFUNDED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [currentSale.id],
    );
  }

  async resolveUserIdForOrder(order, context = {}) {
    if (context.userId) return context.userId;

    const mercadoPagoUserId = context.mercadoPagoUserId || order?.user_id || null;
    if (mercadoPagoUserId) {
      const connection = await get(
        this.db,
        'SELECT user_id FROM mercado_pago_connections WHERE mercado_pago_user_id = ? ORDER BY id DESC LIMIT 1',
        [String(mercadoPagoUserId)],
      );
      if (connection?.user_id) return connection.user_id;
    }

    const terminalId = order?.config?.point?.terminal_id;
    if (terminalId) {
      const terminal = await get(
        this.db,
        'SELECT user_id FROM point_terminals WHERE mercado_pago_terminal_id = ? AND active = TRUE ORDER BY id DESC LIMIT 1',
        [terminalId],
      );
      if (terminal?.user_id) return terminal.user_id;
    }

    const users = await all(this.db, 'SELECT id FROM users WHERE active = TRUE ORDER BY id LIMIT 2');
    return users.length === 1 ? users[0].id : null;
  }

  mapPaymentMethod(paymentMethod) {
    if (paymentMethod === 'CARD') {
      const cardType = this.env.MERCADOPAGO_CARD_DEFAULT_TYPE;
      if (!['credit_card', 'debit_card'].includes(cardType)) {
        throw new AppError(
          'MERCADOPAGO_CARD_DEFAULT_TYPE deve ser credit_card ou debit_card.',
          500,
          'INVALID_CARD_DEFAULT_TYPE',
        );
      }
      return cardType;
    }

    if (paymentMethod === 'PIX') {
      if (!this.env.MERCADOPAGO_ENABLE_QR) {
        throw new AppError(
          'Pix/QR no Point esta desabilitado. Habilite somente apos validar suporte da sua conta e terminal.',
          400,
          'PIX_QR_NOT_ENABLED',
        );
      }
      return 'qr';
    }

    throw new AppError('Metodo de pagamento invalido.', 400, 'INVALID_PAYMENT_METHOD');
  }
}

async function upsertPayment(db, input) {
  await run(
    db,
    `INSERT INTO payments
     (sale_id, provider, transaction_id, provider_order_id, amount_cents, payment_method, status,
      status_detail, installments, provider_payment_method_id, provider_payment_method_type,
      provider_terminal_id, provider_created_at, provider_updated_at, card_brand, card_type,
      external_reference, provider_user_id, provider_action, raw_response)
     VALUES (?, 'mercadopago', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, provider_order_id)
     DO UPDATE SET
       transaction_id = COALESCE(excluded.transaction_id, payments.transaction_id),
       amount_cents = excluded.amount_cents,
       payment_method = excluded.payment_method,
       status = excluded.status,
       status_detail = excluded.status_detail,
       installments = excluded.installments,
       provider_payment_method_id = excluded.provider_payment_method_id,
       provider_payment_method_type = excluded.provider_payment_method_type,
       provider_terminal_id = excluded.provider_terminal_id,
       provider_created_at = COALESCE(payments.provider_created_at, excluded.provider_created_at),
       provider_updated_at = excluded.provider_updated_at,
       card_brand = excluded.card_brand,
       card_type = excluded.card_type,
       external_reference = excluded.external_reference,
       provider_user_id = excluded.provider_user_id,
       provider_action = excluded.provider_action,
       raw_response = excluded.raw_response,
       updated_at = CURRENT_TIMESTAMP`,
    [
      input.saleId,
      input.transactionId,
      input.providerOrderId,
      input.amountCents,
      input.paymentMethod,
      input.status,
      input.statusDetail,
      input.installments,
      input.providerPaymentMethodId,
      input.providerPaymentMethodType,
      input.providerTerminalId,
      input.providerCreatedAt,
      input.providerUpdatedAt,
      input.cardBrand,
      input.cardType,
      input.externalReference,
      input.providerUserId,
      input.providerAction,
      JSON.stringify(input.rawResponse || {}),
    ],
  );
}

function extractPrimaryPayment(order) {
  return order?.transactions?.payments?.[0] || null;
}

function extractTransactionId(payment) {
  return payment?.id || payment?.reference?.id || payment?.reference_id || payment?.referenceId || null;
}

function extractPaidAmountCents(order, payment) {
  if (payment?.paid_amount !== undefined) return decimalToCents(String(payment.paid_amount));
  if (payment?.amount !== undefined) return decimalToCents(String(payment.amount));
  if (order?.total_paid_amount !== undefined) return decimalToCents(String(order.total_paid_amount));
  return 0;
}

function extractProviderAmountCents(order, payment) {
  if (payment?.amount !== undefined) return decimalToCents(String(payment.amount));
  if (order?.total_amount !== undefined) return decimalToCents(String(order.total_amount));
  if (order?.total_paid_amount !== undefined) return decimalToCents(String(order.total_paid_amount));
  return extractPaidAmountCents(order, payment);
}

function mapProviderPaymentMethod(payment, order) {
  const type = String(payment?.payment_method?.type || order?.config?.payment_method?.default_type || '').toLowerCase();

  if (type === 'qr' || type === 'pix') return 'PIX';
  return 'CARD';
}

function extractProviderMetadata(order, payment, context = {}) {
  const installments = payment?.payment_method?.installments;
  const paymentMethodType = payment?.payment_method?.type || order?.config?.payment_method?.default_type || null;

  return {
    installments:
      installments !== undefined && installments !== null && Number.isInteger(Number(installments))
        ? Number(installments)
        : null,
    providerPaymentMethodId: payment?.payment_method?.id || null,
    providerPaymentMethodType: paymentMethodType,
    providerTerminalId: order?.config?.point?.terminal_id || null,
    providerCreatedAt: order?.created_date || order?.date_created || null,
    providerUpdatedAt: order?.last_updated_date || order?.date_last_updated || null,
    cardBrand: payment?.payment_method?.id || null,
    cardType: paymentMethodType && paymentMethodType.includes('card') ? paymentMethodType : null,
    externalReference: order?.external_reference || null,
    providerUserId: context.mercadoPagoUserId || order?.user_id || null,
    providerAction: context.action || null,
  };
}

function sanitizeExternalReference(externalReference, providerOrderId) {
  const normalized = String(externalReference || '').trim();
  if (normalized) return normalized;
  return `MP_ORDER_${providerOrderId}`;
}

async function upsertTerminalFromOrder(db, order, userId = null) {
  const terminalId = order?.config?.point?.terminal_id;
  if (!terminalId) return;

  await run(
    db,
    `INSERT INTO terminals (provider, provider_terminal_id, operating_mode, active, last_synced_at)
     VALUES ('mercadopago', ?, 'PDV', TRUE, CURRENT_TIMESTAMP)
     ON CONFLICT(provider, provider_terminal_id)
     DO UPDATE SET
       operating_mode = COALESCE(terminals.operating_mode, excluded.operating_mode),
       last_synced_at = CURRENT_TIMESTAMP`,
    [terminalId],
  );

  if (!userId) return;

  await run(
    db,
    `INSERT INTO point_terminals
     (user_id, mercado_pago_terminal_id, operating_mode, active, last_synced_at)
     VALUES (?, ?, 'PDV', TRUE, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, mercado_pago_terminal_id)
     DO UPDATE SET
       operating_mode = COALESCE(point_terminals.operating_mode, excluded.operating_mode),
       last_synced_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP`,
    [userId, terminalId],
  );
}

function mapOrderToInternalStatus(order, payment = null) {
  const orderStatus = String(order?.status || '').toLowerCase();
  const orderDetail = String(order?.status_detail || '').toLowerCase();
  const paymentStatus = String(payment?.status || '').toLowerCase();
  const paymentDetail = String(payment?.status_detail || '').toLowerCase();

  if (
    orderStatus === 'processed' &&
    (paymentStatus === '' || paymentStatus === 'processed') &&
    (orderDetail === '' || orderDetail === 'processed' || orderDetail === 'accredited') &&
    (paymentDetail === '' || paymentDetail === 'accredited')
  ) {
    return 'APPROVED';
  }

  if (orderStatus === 'failed' || paymentStatus === 'failed') return 'REJECTED';
  if (orderStatus === 'canceled' || orderStatus === 'cancelled' || paymentStatus === 'canceled') {
    return 'CANCELLED';
  }
  if (orderStatus === 'expired' || paymentStatus === 'expired') return 'EXPIRED';
  if (orderStatus === 'refunded' || paymentStatus === 'refunded') return 'REFUNDED';
  if (orderStatus === 'action_required' || paymentStatus === 'action_required') {
    return 'ACTION_REQUIRED';
  }

  return 'PENDING';
}

module.exports = {
  PaymentService,
  extractPaidAmountCents,
  extractPrimaryPayment,
  extractTransactionId,
  extractProviderAmountCents,
  mapOrderToInternalStatus,
  mapProviderPaymentMethod,
};
