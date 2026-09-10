function createPaymentController(paymentService) {
  return {
    async start(req, res) {
      const sale = await paymentService.startPayment(req.params.saleId, req.body.payment_method, { userId: req.user?.id });
      res.status(201).json({ sale });
    },

    async cancel(req, res) {
      const sale = await paymentService.cancelPendingPayment(req.params.saleId, { userId: req.user?.id });
      res.json({ sale });
    },
  };
}

module.exports = { createPaymentController };
