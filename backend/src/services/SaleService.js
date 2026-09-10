const { randomUUID } = require('node:crypto');
const { all, get, insert, run, withTransaction } = require('../database/connection');
const { AppError } = require('../utils/errors');
const { decimalToCents } = require('../utils/money');
const { buildSaleExternalReference } = require('./MercadoPagoProvider');

class SaleService {
  constructor(db, cashRegisterService) {
    this.db = db;
    this.cashRegisterService = cashRegisterService;
  }

  async createSale(input, context = {}) {
    const paymentMethod = normalizePaymentMethod(input.payment_method);
    const totalCents = normalizeAmountCents(input);

    let createdSaleId;
    await withTransaction(this.db, async (tx) => {
      const cashRegister = await this.cashRegisterService.ensureOpen(context.userId, tx);
      const temporaryExternalReference = `SALE_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      const idempotencyKey = randomUUID();

      const saleId = await insert(
        tx,
        `INSERT INTO sales
         (user_id, total_cents, status, payment_method, external_reference, idempotency_key, cash_register_id)
         VALUES (?, ?, 'PENDING', ?, ?, ?, ?)`,
        [context.userId || null, totalCents, paymentMethod, temporaryExternalReference, idempotencyKey, cashRegister.id],
      );

      const externalReference = buildSaleExternalReference(saleId);
      await run(tx, 'UPDATE sales SET external_reference = ? WHERE id = ?', [
        externalReference,
        saleId,
      ]);
      createdSaleId = saleId;

    });

    return this.getSale(createdSaleId, context);
  }

  async getSale(id, context = {}) {
    const sale = context.userId
      ? await get(this.db, 'SELECT * FROM sales WHERE id = ? AND user_id = ?', [Number(id), context.userId])
      : await get(this.db, 'SELECT * FROM sales WHERE id = ?', [Number(id)]);
    if (!sale) throw new AppError('Venda não encontrada.', 404, 'SALE_NOT_FOUND');
    return this.serializeSale(sale);
  }

  async listSales({ limit = 50, userId, status, paymentMethod, search } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const clauses = [];
    const params = [];

    if (userId) {
      clauses.push('user_id = ?');
      params.push(userId);
    }
    if (status) {
      clauses.push('status = ?');
      params.push(String(status).toUpperCase());
    }
    if (paymentMethod) {
      clauses.push('payment_method = ?');
      params.push(String(paymentMethod).toUpperCase());
    }
    if (search) {
      clauses.push('(external_reference LIKE ? OR provider_order_id LIKE ? OR provider_payment_id LIKE ?)');
      const term = `%${String(search).trim()}%`;
      params.push(term, term, term);
    }

    const rows = await all(
      this.db,
      `SELECT *
       FROM sales
       ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [...params, safeLimit],
    );

    return Promise.all(rows.map((sale) => this.serializeSale(sale)));
  }

  async getSaleByProviderOrderId(providerOrderId) {
    const sale = await get(this.db, 'SELECT * FROM sales WHERE provider_order_id = ?', [providerOrderId]);
    return sale ? this.serializeSale(sale) : null;
  }

  async getSaleByExternalReference(externalReference) {
    const sale = await get(this.db, 'SELECT * FROM sales WHERE external_reference = ?', [externalReference]);
    return sale ? this.serializeSale(sale) : null;
  }

  async getPayment(saleId) {
    return get(this.db, 'SELECT * FROM payments WHERE sale_id = ? ORDER BY id DESC LIMIT 1', [
      Number(saleId),
    ]);
  }

  async serializeSale(row) {
    const payment = await this.getPayment(row.id);

    return {
      id: row.id,
      user_id: row.user_id,
      total_cents: row.total_cents,
      total: row.total_cents / 100,
      status: row.status,
      payment_method: row.payment_method,
      external_reference: row.external_reference,
      provider_order_id: row.provider_order_id,
      provider_payment_id: row.provider_payment_id,
      idempotency_key: row.idempotency_key,
      cash_register_id: row.cash_register_id,
      source: row.source || 'PDV',
      created_at: row.created_at,
      updated_at: row.updated_at,
      items: [],
      payment: payment
        ? {
            id: payment.id,
            provider: payment.provider,
            transaction_id: payment.transaction_id,
            provider_order_id: payment.provider_order_id,
            amount_cents: payment.amount_cents,
            payment_method: payment.payment_method,
            status: payment.status,
            status_detail: payment.status_detail,
            installments: payment.installments,
            provider_payment_method_id: payment.provider_payment_method_id,
            provider_payment_method_type: payment.provider_payment_method_type,
            provider_terminal_id: payment.provider_terminal_id,
            provider_created_at: payment.provider_created_at,
            provider_updated_at: payment.provider_updated_at,
            card_brand: payment.card_brand,
            card_type: payment.card_type,
            external_reference: payment.external_reference,
            provider_user_id: payment.provider_user_id,
            provider_action: payment.provider_action,
            created_at: payment.created_at,
            updated_at: payment.updated_at,
          }
        : null,
    };
  }
}

function normalizePaymentMethod(method) {
  const normalized = String(method || '').trim().toUpperCase();
  if (normalized !== 'CARD' && normalized !== 'PIX') {
    throw new AppError('Método de pagamento inválido.', 400, 'INVALID_PAYMENT_METHOD');
  }
  return normalized;
}

function normalizeAmountCents(input) {
  const directAmount = Number(input.amount_cents);
  const parsedAmount = Number.isInteger(directAmount)
    ? directAmount
    : decimalToCents(String(input.amount || '0'));

  if (!Number.isInteger(parsedAmount) || parsedAmount <= 0) {
    throw new AppError('Informe um valor de venda maior que zero.', 400, 'INVALID_SALE_AMOUNT');
  }

  return parsedAmount;
}

module.exports = { SaleService, normalizePaymentMethod, normalizeAmountCents };
