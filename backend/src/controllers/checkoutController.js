function createCheckoutController(saleService, paymentService) {
  return {
    async point(req, res) {
      paymentService.assertCanStart(req.body.payment_method);
      const sale = saleService.createSale(req.body);
      const saleWithPayment = await paymentService.startPayment(sale.id, sale.payment_method);
      res.status(201).json({ sale: saleWithPayment });
    },
  };
}

module.exports = { createCheckoutController };
