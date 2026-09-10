const { all, get, insert, run } = require('../database/connection');
const { AppError } = require('../utils/errors');

class CashRegisterService {
  constructor(db) {
    this.db = db;
  }

  async ensureOpen(userId = null, db = this.db) {
    const current = await this.getCurrent(userId, db);
    if (current) return current;
    return this.open({ opening_balance_cents: 0, user_id: userId, created_by: userId }, db);
  }

  async getCurrent(userId = null, db = this.db) {
    const row = userId
      ? await get(db, "SELECT * FROM cash_registers WHERE status = 'OPEN' AND user_id = ? ORDER BY id DESC LIMIT 1", [userId])
      : await get(db, "SELECT * FROM cash_registers WHERE status = 'OPEN' AND user_id IS NULL ORDER BY id DESC LIMIT 1");
    return row ? this.serializeCashRegister(row) : null;
  }

  async open({ opening_balance_cents = 0, created_by = null, user_id = null } = {}, db = this.db) {
    const existing = await this.getCurrent(user_id, db);
    if (existing) return existing;

    const amount = Number(opening_balance_cents);
    if (!Number.isInteger(amount) || amount < 0) {
      throw new AppError('Saldo inicial invalido.', 400, 'INVALID_OPENING_BALANCE');
    }

    const id = await insert(
      db,
      'INSERT INTO cash_registers (opening_balance_cents, created_by, user_id) VALUES (?, ?, ?)',
      [amount, created_by, user_id],
    );
    return this.getById(id, user_id, db);
  }

  async close(id, userId = null) {
    const cashRegister = await this.getById(id, userId);
    if (cashRegister.status === 'CLOSED') return cashRegister;

    const summary = await this.getSummary(id, userId);
    const closingBalance = cashRegister.opening_balance_cents + summary.total_received_cents;

    await run(
      this.db,
      "UPDATE cash_registers SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP, closing_balance_cents = ? WHERE id = ?",
      [closingBalance, Number(id)],
    );

    return this.getById(id, userId);
  }

  async getById(id, userId = null, db = this.db) {
    const row = userId
      ? await get(db, 'SELECT * FROM cash_registers WHERE id = ? AND user_id = ?', [Number(id), userId])
      : await get(db, 'SELECT * FROM cash_registers WHERE id = ?', [Number(id)]);
    if (!row) throw new AppError('Caixa nao encontrado.', 404, 'CASH_REGISTER_NOT_FOUND');
    return this.serializeCashRegister(row);
  }

  async getSummary(id, userId = null) {
    const cashRegister = await this.getById(id, userId);
    const movementRows = await all(
      this.db,
      `SELECT type, payment_method, amount_cents
       FROM cash_movements
       WHERE cash_register_id = ?`,
      [Number(id)],
    );

    const sales = await get(
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
      user_id: row.user_id,
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
