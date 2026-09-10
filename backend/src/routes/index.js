const express = require('express');
const rateLimit = require('express-rate-limit');
const { asyncHandler } = require('../utils/asyncHandler');
const { createAuthController } = require('../controllers/authController');
const { createSaleController } = require('../controllers/saleController');
const { createPaymentController } = require('../controllers/paymentController');
const { createWebhookController } = require('../controllers/webhookController');
const { createDashboardController } = require('../controllers/dashboardController');
const { createCashRegisterController } = require('../controllers/cashRegisterController');
const { createTerminalController } = require('../controllers/terminalController');
const { createDevController } = require('../controllers/devController');
const { createCheckoutController } = require('../controllers/checkoutController');
const { createCredentialController } = require('../controllers/credentialController');
const { createMercadoPagoController } = require('../controllers/mercadoPagoController');

function createRoutes(services, env) {
  const router = express.Router();
  const authController = createAuthController(services.authService, env);
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
  const mercadoPagoController = createMercadoPagoController(services.mercadoPagoConnectionService);
  const { requireAuth, requireCsrf } = services.authMiddleware;

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: env.NODE_ENV === 'test' ? 1000 : 20,
    standardHeaders: true,
    legacyHeaders: false,
  });
  const resendLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: env.NODE_ENV === 'test' ? 1000 : 2,
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.get('/health', (req, res) => res.json({ ok: true }));

  router.post('/auth/register', authLimiter, asyncHandler(authController.register));
  router.post('/auth/login', authLimiter, asyncHandler(authController.login));
  router.get('/auth/me', asyncHandler(authController.me));
  router.post('/auth/logout', requireAuth, requireCsrf, asyncHandler(authController.logout));
  router.get('/auth/verify-email', asyncHandler(authController.verifyEmail));
  router.post('/auth/verify-email', asyncHandler(authController.verifyEmail));
  router.post('/auth/resend-verification', resendLimiter, asyncHandler(authController.resendVerification));
  router.post('/auth/forgot-password', authLimiter, asyncHandler(authController.forgotPassword));
  router.post('/auth/reset-password', authLimiter, asyncHandler(authController.resetPassword));

  router.post('/mercadopago/webhook', asyncHandler(webhookController.mercadoPago));
  router.post('/webhooks/mercadopago', asyncHandler(webhookController.mercadoPago));
  router.get('/mercadopago/oauth/callback', asyncHandler(mercadoPagoController.callback));

  router.use(requireAuth);
  router.use(requireCsrf);

  router.get('/config', asyncHandler(async (req, res) => {
    const terminal = await services.terminalService.getCurrentTerminal(req.user.id);
    res.json({
      mercadopago: {
        terminal_configured: terminal.configured,
        terminal_id: terminal.provider_terminal_id,
        pix_qr_enabled: env.MERCADOPAGO_ENABLE_QR,
        card_default_type: env.MERCADOPAGO_CARD_DEFAULT_TYPE,
      },
    });
  }));

  router.get('/sales', asyncHandler(saleController.list));
  router.post('/sales', asyncHandler(saleController.create));
  router.get('/sales/:id', asyncHandler(saleController.get));
  router.get('/sales/:id/status', asyncHandler(saleController.status));
  router.post('/sales/:saleId/payments', asyncHandler(paymentController.start));
  router.post('/sales/:saleId/cancel', asyncHandler(paymentController.cancel));
  router.post('/checkout/point', asyncHandler(checkoutController.point));

  router.get('/dashboard', asyncHandler(dashboardController.show));

  router.get('/cash-registers/current', asyncHandler(cashRegisterController.current));
  router.post('/cash-registers/open', asyncHandler(cashRegisterController.open));
  router.post('/cash-registers/:id/close', asyncHandler(cashRegisterController.close));
  router.get('/cash-registers/:id/summary', asyncHandler(cashRegisterController.summary));

  router.get('/terminals/current', asyncHandler(terminalController.current));
  router.get('/terminals', asyncHandler(terminalController.list));
  router.post('/terminals', asyncHandler(terminalController.save));
  router.patch('/terminals/:providerTerminalId/mode', asyncHandler(terminalController.setupMode));

  router.get('/mercadopago/credentials', credentialController.status);
  router.put('/mercadopago/credentials', asyncHandler(credentialController.save));
  router.get('/mercadopago/connect', asyncHandler(mercadoPagoController.connect));
  router.get('/mercadopago/status', asyncHandler(mercadoPagoController.status));
  router.post('/mercadopago/sync-terminals', asyncHandler(mercadoPagoController.syncTerminals));
  router.post('/mercadopago/active-terminal', asyncHandler(mercadoPagoController.setActiveTerminal));
  router.post('/mercadopago/disconnect', asyncHandler(mercadoPagoController.disconnect));

  router.post('/dev/mercadopago/orders/:orderId/events', asyncHandler(devController.simulateOrderEvent));

  return router;
}

module.exports = { createRoutes };
