const express = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const { createSaleController } = require('../controllers/saleController');
const { createPaymentController } = require('../controllers/paymentController');
const { createWebhookController } = require('../controllers/webhookController');
const { createDashboardController } = require('../controllers/dashboardController');
const { createCashRegisterController } = require('../controllers/cashRegisterController');
const { createTerminalController } = require('../controllers/terminalController');
const { createDevController } = require('../controllers/devController');
const { createCheckoutController } = require('../controllers/checkoutController');
const { createCredentialController } = require('../controllers/credentialController');

function createRoutes(services, env) {
  const router = express.Router();
  const saleController = createSaleController(services.saleService, services.paymentService);
  const paymentController = createPaymentController(services.paymentService);
  const webhookController = createWebhookController(services.webhookService);
  const dashboardController = createDashboardController(services.dashboardService);
  const cashRegisterController = createCashRegisterController(services.cashRegisterService);
  const terminalController = createTerminalController(services.terminalService);
  const devController = createDevController(services.mercadoPagoProvider, env);
  const checkoutController = createCheckoutController(services.saleService, services.paymentService);
  const credentialController = createCredentialController(
    services.credentialService,
    services.terminalService,
  );

  router.get('/health', (req, res) => res.json({ ok: true }));
  router.get('/config', (req, res) => {
    const terminal = services.terminalService.getCurrentTerminal();
    res.json({
      mercadopago: {
        terminal_configured: terminal.configured,
        terminal_id: terminal.provider_terminal_id,
        pix_qr_enabled: env.MERCADOPAGO_ENABLE_QR,
        card_default_type: env.MERCADOPAGO_CARD_DEFAULT_TYPE,
      },
    });
  });

  router.get('/sales', saleController.list);
  router.post('/sales', saleController.create);
  router.get('/sales/:id', saleController.get);
  router.get('/sales/:id/status', asyncHandler(saleController.status));
  router.post('/sales/:saleId/payments', asyncHandler(paymentController.start));
  router.post('/sales/:saleId/cancel', asyncHandler(paymentController.cancel));
  router.post('/checkout/point', asyncHandler(checkoutController.point));

  router.get('/dashboard', dashboardController.show);

  router.get('/cash-registers/current', cashRegisterController.current);
  router.post('/cash-registers/open', cashRegisterController.open);
  router.post('/cash-registers/:id/close', cashRegisterController.close);
  router.get('/cash-registers/:id/summary', cashRegisterController.summary);

  router.get('/terminals/current', terminalController.current);
  router.get('/terminals', asyncHandler(terminalController.list));
  router.post('/terminals', terminalController.save);
  router.patch('/terminals/:providerTerminalId/mode', asyncHandler(terminalController.setupMode));

  router.get('/mercadopago/credentials', credentialController.status);
  router.put('/mercadopago/credentials', credentialController.save);

  router.post('/webhooks/mercadopago', asyncHandler(webhookController.mercadoPago));
  router.post('/dev/mercadopago/orders/:orderId/events', asyncHandler(devController.simulateOrderEvent));

  return router;
}

module.exports = { createRoutes };
