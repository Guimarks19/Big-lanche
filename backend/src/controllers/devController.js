const { AppError } = require('../utils/errors');

function createDevController(provider, env) {
  return {
    async simulateOrderEvent(req, res) {
      if (!env.ENABLE_TEST_ENDPOINTS) {
        throw new AppError('Rotas de teste estao desabilitadas.', 404, 'TEST_ENDPOINT_DISABLED');
      }

      await provider.simulateOrderEvent(req.params.orderId, req.body);
      res.status(204).end();
    },
  };
}

module.exports = { createDevController };
