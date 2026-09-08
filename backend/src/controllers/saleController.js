function createSaleController(saleService, paymentService) {
  return {
    list(req, res) {
      res.json({ sales: saleService.listSales({ limit: req.query.limit }) });
    },

    create(req, res) {
      const sale = saleService.createSale(req.body);
      res.status(201).json({ sale });
    },

    get(req, res) {
      const sale = saleService.getSale(req.params.id);
      res.json({ sale });
    },

    async status(req, res) {
      const sale = await paymentService.syncSalePaymentStatus(req.params.id);
      res.json({ sale });
    },
  };
}

module.exports = { createSaleController };
