function createSaleController(saleService, paymentService) {
  return {
    async list(req, res) {
      res.json({
        sales: await saleService.listSales({
          limit: req.query.limit,
          userId: req.user?.id,
          status: req.query.status,
          paymentMethod: req.query.payment_method,
          search: req.query.search,
        }),
      });
    },

    async create(req, res) {
      const sale = await saleService.createSale(req.body, { userId: req.user?.id });
      res.status(201).json({ sale });
    },

    async get(req, res) {
      const sale = await saleService.getSale(req.params.id, { userId: req.user?.id });
      res.json({ sale });
    },

    async status(req, res) {
      const sale = await paymentService.syncSalePaymentStatus(req.params.id, { userId: req.user?.id });
      res.json({ sale });
    },
  };
}

module.exports = { createSaleController };
