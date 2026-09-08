const { all, get, run } = require('../database/connection');
const { AppError } = require('../utils/errors');

class CashRegisterService {
  constructor(db) {
    this.db = db;
  }

  ensureOpen() {
    const current = this.getCurrent();
    if (current) return current;
    return this.open({ opening_balance_cents: 0 });
  }

  getCurrent() {
    const row = get(this.db, "SELECT * FROM cash_registers WHERE status = 'OPEN' ORDER BY id DESC LIMIT 1");
    return row ? this.serializeCashRegister(row) : null;
  }

  open({ opening_balance_cents = 0, created_by = null } = {}) {
    const existing = this.getCurrent();
    if (existing) return existing;

    const amount = Number(opening_balance_cents);
    if (!Number.isInteger(amount) || amount < 0) {
      throw new AppError('Saldo inicial invalido.', 400, 'INVALID_OPENING_BALANCE');
    }

    const result = run(
      this.db,
      'INSERT INTO cash_registers (opening_balance_cents, created_by) VALUES (?, ?)',
      [amount, created_by],
    );
    return this.getById(result.lastInsertRowid);
  }

  close(id) {
    const cashRegister = this.getById(id);
    if (cashRegister.status === 'CLOSED') return cashRegister;

    const summary = this.getSummary(id);
    const closingBalance = cashRegister.opening_balance_cents + summary.total_received_cents;

    run(
      this.db,
      "UPDATE cash_registers SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP, closing_balance_cents = ? WHERE id = ?",
      [closingBalance, Number(id)],
    );

    return this.getById(id);
  }

  getById(id) {
    const row = get(this.db, 'SELECT * FROM cash_registers WHERE id = ?', [Number(id)]);
    if (!row) throw new AppError('Caixa nao encontrado.', 404, 'CASH_REGISTER_NOT_FOUND');
    return this.serializeCashRegister(row);
  }

  getSummary(id) {
    const cashRegister = this.getById(id);
    const movementRows = all(
      this.db,
      `SELECT type, payment_method, amount_cents
       FROM cash_movements
       WHERE cash_register_id = ?`,
      [Number(id)],
    );

    const sales = get(
      this.db,
      `SELECT
         COUNT(*) AS total_sales,
         SUM(CASE WHEN status = 'APPROVED' THEN 1 ELSE 0 END) AS approved_sales,
         SUM(CASE WHEN status = 'REJECTED' THEN 1 ELSE 0 END) AS rejected_sales,
         SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled_sales,
         SUM(CASE WHEN status = 'REFUNDED' THEN 1 ELSE 0 END) AS refunded_sales
       FROM sales
       WHERE cash_register_id = ?`,
      [Number(id)],
    );

    const totals = {
      gross_revenue_cents: 0,
      card_cents: 0,
      pix_cents: 0,
      cash_cents: 0,
      total_received_cents: 0,
      total_cancelled_cents: 0,
      total_refunded_cents: 0,
    };

    for (const movement of movementRows) {
      if (movement.type === 'SALE') {
        totals.gross_revenue_cents += movement.amount_cents;
        totals.total_received_cents += movement.amount_cents;
        if (movement.payment_method === 'CARD') totals.card_cents += movement.amount_cents;
        if (movement.payment_method === 'PIX') totals.pix_cents += movement.amount_cents;
        if (movement.payment_method === 'CASH') totals.cash_cents += movement.amount_cents;
      }
      if (movement.type === 'CANCEL') totals.total_cancelled_cents += Math.abs(movement.amount_cents);
      if (movement.type === 'REFUND') totals.total_refunded_cents += Math.abs(movement.amount_cents);
    }

    return {
      cash_register: cashRegister,
      ...totals,
      sales: {
        total: sales.total_sales || 0,
        approved: sales.approved_sales || 0,
        rejected: sales.rejected_sales || 0,
        cancelled: sales.cancelled_sales || 0,
        refunded: sales.refunded_sales || 0,
      },
    };
  }

  serializeCashRegister(row) {
    return {
      id: row.id,
      opened_at: row.opened_at,
      closed_at: row.closed_at,
      opening_balance_cents: row.opening_balance_cents,
      closing_balance_cents: row.closing_balance_cents,
      status: row.status,
      created_by: row.created_by,
    };
  }
}

module.exports = { CashRegisterService };
