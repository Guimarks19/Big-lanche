const { randomUUID } = require('node:crypto');
const { get, run, withTransaction } = require('../database/connection');
const { AppError } = require('../utils/errors');
const { decimalToCents } = require('../utils/money');

class PaymentService {
  constructor(db, saleService, cashRegisterService, provider, env, terminalService) {
    this.db = db;
    this.saleService = saleService;
    this.cashRegisterService = cashRegisterService;
    this.provider = provider;
    this.env = env;
    this.terminalService = terminalService;
  }

  async startPayment(saleId, requestedMethod) {
    const sale = this.saleService.getSale(saleId);
    const paymentMethod = requestedMethod ? String(requestedMethod).toUpperCase() : sale.payment_method;

    if (sale.status !== 'PENDING') {
      throw new AppError('Apenas vendas pendentes podem iniciar pagamento.', 409, 'SALE_NOT_PENDING');
    }
    if (paymentMethod !== sale.payment_method) {
      throw new AppError('Metodo de pagamento diferente do informado na venda.', 400, 'PAYMENT_METHOD_MISMATCH');
    }
    if (sale.provider_order_id) {
      return this.saleService.getSale(sale.id);
    }

    const mercadoPagoPaymentType = this.mapPaymentMethod(paymentMethod);
    const order = await this.provider.createPointOrder({
      amountCents: sale.total_cents,
      externalReference: sale.external_reference,
      idempotencyKey: sale.idempotency_key,
      mercadoPagoPaymentType,
      description: `Venda ${sale.external_reference}`,
      terminalId: this.getConfiguredTerminalId(),
    });

    return withTransaction(this.db, () => {
      const payment = extractPrimaryPayment(order);
      const transactionId = extractTransactionId(payment);

      run(
        this.db,
        `UPDATE sales
         SET provider_order_id = ?, provider_payment_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [order.id, transactionId, sale.id],
      );

      upsertPayment(this.db, {
        saleId: sale.id,
        providerOrderId: order.id,
        transactionId,
        amountCents: sale.total_cents,
        paymentMethod,
        status: mapOrderToInternalStatus(order, payment),
        statusDetail: order.status_detail || payment?.status_detail || null,
        rawResponse: order,
        ...extractProviderMetadata(order, payment),
      });

      return this.saleService.getSale(sale.id);
    });
  }

  assertCanStart(paymentMethod) {
    this.mapPaymentMethod(String(paymentMethod || '').toUpperCase());

    if (!this.env.MERCADOPAGO_ACCESS_TOKEN) {
      throw new AppError(
        'Configure MERCADOPAGO_ACCESS_TOKEN no backend antes de chamar o Mercado Pago.',
        400,
        'MERCADOPAGO_ACCESS_TOKEN_REQUIRED',
      );
    }

    if (!this.getConfiguredTerminalId()) {
      throw new AppError('Configure MERCADOPAGO_TERMINAL_ID no backend.', 400, 'TERMINAL_ID_REQUIRED');
    }
  }

  getConfiguredTerminalId() {
    return this.terminalService?.getActiveTerminalId() || this.env.MERCADOPAGO_TERMINAL_ID;
  }

  async syncSalePaymentStatus(saleId) {
    const sale = this.saleService.getSale(saleId);
    if (!sale.provider_order_id) return sale;
    const order = await this.provider.getOrder(sale.provider_order_id);
    return this.applyProviderOrder(order);
  }

  async cancelPendingPayment(saleId) {
    const sale = this.saleService.getSale(saleId);
    if (sale.status !== 'PENDING' && sale.status !== 'ACTION_REQUIRED') {
      throw new AppError('Apenas vendas pendentes podem ser canceladas.', 409, 'SALE_NOT_CANCELABLE');
    }

    if (sale.provider_order_id) {
      await this.provider.cancelOrder(sale.provider_order_id, randomUUID());
    }

    return withTransaction(this.db, () => {
      run(
        this.db,
        "UPDATE sales SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'APPROVED'",
        [sale.id],
      );
      return this.saleService.getSale(sale.id);
    });
  }

  applyProviderOrder(order) {
    const payment = extractPrimaryPayment(order);
    const transactionId = extractTransactionId(payment);
    const providerOrderId = order?.id;
    const externalReference = order?.external_reference;
    let sale =
      (providerOrderId && this.saleService.getSaleByProviderOrderId(providerOrderId)) ||
      (externalReference && this.saleService.getSaleByExternalReference(externalReference));

    if (!sale) {
      sale = this.createSaleFromProviderOrder(order);
    }

    const nextStatus = mapOrderToInternalStatus(order, payment);
    const amountCents = extractPaidAmountCents(order, payment) || sale.total_cents;
    const statusDetail = order.status_detail || payment?.status_detail || null;

    return withTransaction(this.db, () => {
      const currentSale = get(this.db, 'SELECT * FROM sales WHERE id = ?', [sale.id]);

      upsertPayment(this.db, {
        saleId: sale.id,
        providerOrderId: providerOrderId || currentSale.provider_order_id,
        transactionId,
        amountCents,
        paymentMethod: sale.payment_method,
        status: nextStatus,
        statusDetail,
        rawResponse: order,
        ...extractProviderMetadata(order, payment),
      });

      if (providerOrderId && !currentSale.provider_order_id) {
        run(this.db, 'UPDATE sales SET provider_order_id = ? WHERE id = ?', [providerOrderId, sale.id]);
      }
      if (transactionId) {
        run(this.db, 'UPDATE sales SET provider_payment_id = ? WHERE id = ?', [transactionId, sale.id]);
      }

      if (nextStatus === 'APPROVED') {
        if (amountCents !== currentSale.total_cents) {
          run(
            this.db,
            "UPDATE sales SET status = 'ACTION_REQUIRED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            [sale.id],
          );
          run(
            this.db,
            `UPDATE payments
             SET status = 'AMOUNT_MISMATCH',
                 status_detail = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE sale_id = ?`,
            [`paid=${amountCents}; expected=${currentSale.total_cents}`, sale.id],
          );
          return this.saleService.getSale(sale.id);
        }

        this.approveSale(currentSale, transactionId);
        return this.saleService.getSale(sale.id);
      }

      if (nextStatus === 'REFUNDED') {
        this.refundSale(currentSale, transactionId);
        return this.saleService.getSale(sale.id);
      }

      if (currentSale.status !== 'APPROVED' && currentSale.status !== 'REFUNDED') {
        run(
          this.db,
          'UPDATE sales SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [nextStatus, sale.id],
        );
      }

      return this.saleService.getSale(sale.id);
    });
  }

  createSaleFromProviderOrder(order) {
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

    return withTransaction(this.db, () => {
      const existing =
        this.saleService.getSaleByProviderOrderId(providerOrderId) ||
        (order.external_reference && this.saleService.getSaleByExternalReference(order.external_reference));
      if (existing) return existing;

      const cashRegister = this.cashRegisterService.ensureOpen();
      const externalReference = sanitizeExternalReference(order.external_reference, providerOrderId);
      const paymentMethod = mapProviderPaymentMethod(payment, order);

      // Venda criada por notificacao: ela so entra no caixa quando applyProviderOrder confirmar APPROVED.
      const saleResult = run(
        this.db,
        `INSERT INTO sales
         (total_cents, status, payment_method, external_reference, provider_order_id, provider_payment_id,
          idempotency_key, cash_register_id, source)
         VALUES (?, 'PENDING', ?, ?, ?, ?, ?, ?, 'MERCADOPAGO_WEBHOOK')`,
        [
          totalCents,
          paymentMethod,
          externalReference,
          providerOrderId,
          transactionId,
          `mp_order_${providerOrderId}`,
          cashRegister.id,
        ],
      );

      upsertTerminalFromOrder(this.db, order);
      return this.saleService.getSale(saleResult.lastInsertRowid);
    });
  }

  approveSale(currentSale, transactionId) {
    if (currentSale.status === 'APPROVED') return;

    run(
      this.db,
      "UPDATE sales SET status = 'APPROVED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [currentSale.id],
    );

    run(
      this.db,
      `INSERT OR IGNORE INTO cash_movements
       (cash_register_id, sale_id, type, amount_cents, payment_method, description, provider_payment_id)
       VALUES (?, ?, 'SALE', ?, ?, ?, ?)`,
      [
        currentSale.cash_register_id,
        currentSale.id,
        currentSale.total_cents,
        currentSale.payment_method,
        `Venda ${currentSale.external_reference}`,
        transactionId,
      ],
    );
  }

  refundSale(currentSale, transactionId) {
    if (currentSale.status === 'REFUNDED') return;

    if (currentSale.status === 'APPROVED') {
      run(
        this.db,
        `INSERT OR IGNORE INTO cash_movements
         (cash_register_id, sale_id, type, amount_cents, payment_method, description, provider_payment_id)
         VALUES (?, ?, 'REFUND', ?, ?, ?, ?)`,
        [
          currentSale.cash_register_id,
          currentSale.id,
          -currentSale.total_cents,
          currentSale.payment_method,
          `Estorno ${currentSale.external_reference}`,
          transactionId,
        ],
      );
    }

    run(
      this.db,
      "UPDATE sales SET status = 'REFUNDED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [currentSale.id],
    );
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

function upsertPayment(db, input) {
  run(
    db,
    `INSERT INTO payments
     (sale_id, provider, transaction_id, provider_order_id, amount_cents, payment_method, status,
      status_detail, installments, provider_payment_method_id, provider_payment_method_type,
      provider_terminal_id, provider_created_at, provider_updated_at, raw_response)
     VALUES (?, 'mercadopago', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      JSON.stringify(input.rawResponse || {}),
    ],
  );
}

function extractPrimaryPayment(order) {
  return order?.transactions?.payments?.[0] || null;
}

function extractTransactionId(payment) {
  return (
    payment?.id ||
    payment?.reference?.id ||
    payment?.reference_id ||
    payment?.referenceId ||
    null
  );
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
  const type = String(
    payment?.payment_method?.type ||
      order?.config?.payment_method?.default_type ||
      '',
  ).toLowerCase();

  if (type === 'qr' || type === 'pix') return 'PIX';
  return 'CARD';
}

function extractProviderMetadata(order, payment) {
  const installments = payment?.payment_method?.installments;

  return {
    installments:
      installments !== undefined && installments !== null && Number.isInteger(Number(installments))
        ? Number(installments)
        : null,
    providerPaymentMethodId: payment?.payment_method?.id || null,
    providerPaymentMethodType:
      payment?.payment_method?.type || order?.config?.payment_method?.default_type || null,
    providerTerminalId: order?.config?.point?.terminal_id || null,
    providerCreatedAt: order?.created_date || order?.date_created || null,
    providerUpdatedAt: order?.last_updated_date || order?.date_last_updated || null,
  };
}

function sanitizeExternalReference(externalReference, providerOrderId) {
  const normalized = String(externalReference || '').trim();
  if (normalized) return normalized;
  return `MP_ORDER_${providerOrderId}`;
}

function upsertTerminalFromOrder(db, order) {
  const terminalId = order?.config?.point?.terminal_id;
  if (!terminalId) return;

  run(
    db,
    `INSERT INTO terminals (provider, provider_terminal_id, operating_mode, active, last_synced_at)
     VALUES ('mercadopago', ?, 'PDV', 1, CURRENT_TIMESTAMP)
     ON CONFLICT(provider, provider_terminal_id)
     DO UPDATE SET
       operating_mode = COALESCE(terminals.operating_mode, excluded.operating_mode),
       last_synced_at = CURRENT_TIMESTAMP`,
    [terminalId],
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
