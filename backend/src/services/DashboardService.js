const { all, get } = require('../database/connection');

class DashboardService {
  constructor(db, cashRegisterService) {
    this.db = db;
    this.cashRegisterService = cashRegisterService;
  }

  async getDashboard(userId = null) {
    const { start, end } = getTodayRange();
    const userClause = userId ? ' AND user_id = ?' : ' AND user_id IS NULL';
    const userParams = userId ? [userId] : [];
    const createdAt = this.db.dialect === 'sqlite' ? 'datetime(created_at)' : 'created_at';
    const startValue = this.db.dialect === 'sqlite' ? 'datetime(?)' : '?';
    const endValue = this.db.dialect === 'sqlite' ? 'datetime(?)' : '?';

    const today = await get(
      this.db,
      `SELECT
         COUNT(*) AS sales_count,
         SUM(CASE WHEN status = 'APPROVED' THEN 1 ELSE 0 END) AS approved_sales,
         SUM(CASE WHEN status = 'REJECTED' THEN 1 ELSE 0 END) AS rejected_sales,
         SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled_sales,
         SUM(CASE WHEN status = 'REFUNDED' THEN 1 ELSE 0 END) AS refunded_sales,
         SUM(CASE WHEN status = 'APPROVED' THEN total_cents ELSE 0 END) AS revenue_cents,
         SUM(CASE WHEN status = 'APPROVED' AND payment_method = 'CARD' THEN total_cents ELSE 0 END) AS card_cents,
         SUM(CASE WHEN status = 'APPROVED' AND payment_method = 'PIX' THEN total_cents ELSE 0 END) AS pix_cents
       FROM sales
       WHERE ${createdAt} >= ${startValue} AND ${createdAt} < ${endValue}${userClause}`,
      [start, end, ...userParams],
    );

    const cashMovements = await all(
      this.db,
      `SELECT *
       FROM cash_movements
       WHERE ${createdAt} >= ${startValue} AND ${createdAt} < ${endValue}${userClause}
       ORDER BY created_at DESC, id DESC
       LIMIT 30`,
      [start, end, ...userParams],
    );

    const approvedCount = today.approved_sales || 0;

    return {
      revenue_cents: today.revenue_cents || 0,
      sales_count: today.sales_count || 0,
      approved_sales: approvedCount,
      rejected_sales: today.rejected_sales || 0,
      cancelled_sales: today.cancelled_sales || 0,
      refunded_sales: today.refunded_sales || 0,
      card_cents: today.card_cents || 0,
      pix_cents: today.pix_cents || 0,
      average_ticket_cents: approvedCount > 0 ? Math.round((today.revenue_cents || 0) / approvedCount) : 0,
      current_cash_register: await this.cashRegisterService.getCurrent(userId),
      cash_movements: cashMovements,
    };
  }
}

function getTodayRange() {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

module.exports = { DashboardService };
