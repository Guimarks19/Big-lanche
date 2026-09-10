const path = require('node:path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const morgan = require('morgan');
const { loadEnv } = require('./config/env');
const { createDatabase } = require('./database/connection');
const { migrate } = require('./database/migrate');
const { seed } = require('./database/seed');
const { errorHandler } = require('./middlewares/errorHandler');
const { createRoutes } = require('./routes');
const { CashRegisterService } = require('./services/CashRegisterService');
const { SaleService } = require('./services/SaleService');
const { MercadoPagoProvider } = require('./services/MercadoPagoProvider');
const { PaymentService } = require('./services/PaymentService');
const { WebhookService } = require('./services/WebhookService');
const { TerminalService } = require('./services/TerminalService');
const { DashboardService } = require('./services/DashboardService');
const { CredentialService } = require('./services/CredentialService');
const { EmailService } = require('./services/EmailService');
const { AuthService } = require('./services/AuthService');
const { MercadoPagoConnectionService } = require('./services/MercadoPagoConnectionService');
const { createAuthMiddleware } = require('./middlewares/auth');

async function createApp(options = {}) {
  const env = loadEnv(options.env || {});
  const db = options.db || createDatabase(env.DATABASE_PATH, { env });

  if (options.migrate !== false) await migrate(db);
  if (options.seed === true) await seed(db);

  const emailService = options.emailService || new EmailService(env, options.mailTransport);
  const authService = new AuthService(db, emailService, env);
  const cashRegisterService = new CashRegisterService(db);
  const saleService = new SaleService(db, cashRegisterService);
  const mercadoPagoProvider =
    options.mercadoPagoProvider || new MercadoPagoProvider(env, options.fetchImpl || global.fetch);
  const mercadoPagoConnectionService = new MercadoPagoConnectionService(db, mercadoPagoProvider, env);
  const terminalService = new TerminalService(db, mercadoPagoProvider, env, mercadoPagoConnectionService);
  const paymentService = new PaymentService(
    db,
    saleService,
    cashRegisterService,
    mercadoPagoProvider,
    env,
    terminalService,
  );
  const webhookService = new WebhookService(db, paymentService, mercadoPagoProvider, mercadoPagoConnectionService);
  const dashboardService = new DashboardService(db, cashRegisterService);
  const credentialService = new CredentialService(env, { envFilePath: options.envFilePath });
  const authMiddleware = createAuthMiddleware(authService, env);

  const services = {
    authMiddleware,
    authService,
    cashRegisterService,
    credentialService,
    dashboardService,
    emailService,
    mercadoPagoConnectionService,
    mercadoPagoProvider,
    paymentService,
    saleService,
    terminalService,
    webhookService,
  };

  const app = express();
  app.locals.db = db;
  app.locals.env = env;
  app.locals.services = services;

  app.set('trust proxy', 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:'],
        },
      },
    }),
  );
  app.use(cors());
  app.use(express.json());
  app.use(cookieParser());
  app.use(morgan(env.NODE_ENV === 'test' ? 'tiny' : 'dev'));
  app.use(authMiddleware.attachUser);

  app.use('/api', createRoutes(services, env));
  app.use(express.static(path.join(__dirname, '../../frontend')));
  app.get('/favicon.ico', (req, res) => res.status(204).end());

  app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, '../../frontend/index.html'));
  });

  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
