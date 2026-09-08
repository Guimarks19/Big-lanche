const path = require('node:path');
const express = require('express');
const cors = require('cors');
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

function createApp(options = {}) {
  const env = loadEnv(options.env || {});
  const db = options.db || createDatabase(env.DATABASE_PATH);

  if (options.migrate !== false) migrate(db);
  if (options.seed === true) seed(db);

  const cashRegisterService = new CashRegisterService(db);
  const saleService = new SaleService(db, cashRegisterService);
  const mercadoPagoProvider =
    options.mercadoPagoProvider || new MercadoPagoProvider(env, options.fetchImpl || global.fetch);
  const terminalService = new TerminalService(db, mercadoPagoProvider, env);
  const paymentService = new PaymentService(
    db,
    saleService,
    cashRegisterService,
    mercadoPagoProvider,
    env,
    terminalService,
  );
  const webhookService = new WebhookService(db, paymentService, mercadoPagoProvider);
  const dashboardService = new DashboardService(db, cashRegisterService);
  const credentialService = new CredentialService(env, { envFilePath: options.envFilePath });

  const services = {
    cashRegisterService,
    credentialService,
    dashboardService,
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

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());
  app.use(express.json());
  app.use(morgan(env.NODE_ENV === 'test' ? 'tiny' : 'dev'));

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
