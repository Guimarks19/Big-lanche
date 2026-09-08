const { randomUUID } = require('node:crypto');
const { all, get, run, withTransaction } = require('../database/connection');
const { AppError } = require('../utils/errors');
const { decimalToCents } = require('../utils/money');

class SaleService {
  constructor(db, cashRegisterService) {
    this.db = db;
    this.cashRegisterService = cashRegisterService;
  }

  createSale(input) {
    const paymentMethod = normalizePaymentMethod(input.payment_method);
    const totalCents = normalizeAmountCents(input);

    return withTransaction(this.db, () => {
      const cashRegister = this.cashRegisterService.ensureOpen();
      const externalReference = `SALE_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      const idempotencyKey = randomUUID();

      const saleResult = run(
        this.db,
        `INSERT INTO sales
         (total_cents, status, payment_method, external_reference, idempotency_key, cash_register_id)
         VALUES (?, 'PENDING', ?, ?, ?, ?)`,
        [totalCents, paymentMethod, externalReference, idempotencyKey, cashRegister.id],
      );

      return this.getSale(saleResult.lastInsertRowid);
    });
  }

  getSale(id) {
    const sale = get(this.db, 'SELECT * FROM sales WHERE id = ?', [Number(id)]);
    if (!sale) throw new AppError('Venda nao encontrada.', 404, 'SALE_NOT_FOUND');
    return this.serializeSale(sale);
  }

  listSales({ limit = 50 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return all(
      this.db,
      `SELECT *
       FROM sales
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [safeLimit],
    ).map((sale) => this.serializeSale(sale));
  }

  getSaleByProviderOrderId(providerOrderId) {
    const sale = get(this.db, 'SELECT * FROM sales WHERE provider_order_id = ?', [providerOrderId]);
    return sale ? this.serializeSale(sale) : null;
  }

  getSaleByExternalReference(externalReference) {
    const sale = get(this.db, 'SELECT * FROM sales WHERE external_reference = ?', [externalReference]);
    return sale ? this.serializeSale(sale) : null;
  }

  getPayment(saleId) {
    return get(this.db, 'SELECT * FROM payments WHERE sale_id = ? ORDER BY id DESC LIMIT 1', [
      Number(saleId),
    ]);
  }

  serializeSale(row) {
    const payment = this.getPayment(row.id);

    return {
      id: row.id,
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
    throw new AppError('Metodo de pagamento invalido.', 400, 'INVALID_PAYMENT_METHOD');
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
