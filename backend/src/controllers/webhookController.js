function createWebhookController(webhookService) {
  return {
    async mercadoPago(req, res) {
      const result = await webhookService.handleMercadoPago(req);
      res.status(200).json(result);
    },
  };
}

module.exports = { createWebhookController };
