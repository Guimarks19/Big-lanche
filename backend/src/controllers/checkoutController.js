function createCheckoutController(saleService, paymentService) {
  return {
    async point(req, res) {
      paymentService.assertCanStart(req.body.payment_method);
      const sale = await saleService.createSale(req.body, { userId: req.user?.id });
      const saleWithPayment = await paymentService.startPayment(sale.id, sale.payment_method, { userId: req.user?.id });
      res.status(201).json({ sale: saleWithPayment });
    },
  };
}

module.exports = { createCheckoutController };
