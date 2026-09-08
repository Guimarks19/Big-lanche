function createWebhookController(webhookService) {
  return {
    async mercadoPago(req, res) {
      console.log('BODY:', req.body);
      console.log('QUERY:', req.query);

      const result = await webhookService.handleMercadoPago(req);
      res.status(200).json(result);
    },
  };
}

module.exports = { createWebhookController };
