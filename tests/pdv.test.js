const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { createApp } = require('../backend/src/app');
const { createDatabase, get } = require('../backend/src/database/connection');
const { MercadoPagoError } = require('../backend/src/utils/errors');
const { centsToDecimal } = require('../backend/src/utils/money');

class FakeMercadoPagoProvider {
  constructor() {
    this.orders = new Map();
    this.failCreate = false;
    this.counter = 1;
    this.lastCreatedOrderInput = null;
  }

  validateWebhookSignature() {}

  async listTerminals() {
    return {
      terminals: [
        {
          id: 'NEWLAND_N950__SBX0000001',
          operating_mode: 'PDV',
          pos_id: 'POS_TEST',
          store_id: 'STORE_TEST',
        },
      ],
    };
  }

  async setupTerminalMode(providerTerminalId, operatingMode) {
    return { id: providerTerminalId, operating_mode: operatingMode };
  }

  async createPointOrder(input) {
    if (this.failCreate) {
      throw new MercadoPagoError('Falha simulada de comunicacao.', 502, 'MP_COMMUNICATION_FAILED');
    }

    this.lastCreatedOrderInput = input;
    const id = `ORD_TEST_${this.counter}`;
    const paymentId = `PAY_TEST_${this.counter}`;
    this.counter += 1;

    const order = {
      id,
      type: 'point',
      external_reference: input.externalReference,
      status: 'created',
      status_detail: 'created',
      transactions: {
        payments: [
          {
            id: paymentId,
            amount: centsToDecimal(input.amountCents),
            status: 'created',
            status_detail: 'created',
          },
        ],
      },
      config: {
        point: {
          terminal_id: input.terminalId,
        },
        payment_method: {
          default_type: input.mercadoPagoPaymentType,
        },
      },
    };

    this.orders.set(id, order);
    return order;
  }

  async createPointCharge(input) {
    return this.createPointOrder({
      amountCents: input.amountCents,
      externalReference: `VENDA_${input.saleId}`,
      idempotencyKey: input.idempotencyKey,
      mercadoPagoPaymentType: input.paymentType || 'credit_card',
      terminalId: input.terminalId,
      description: input.description,
    });
  }

  async getOrder(orderId) {
    const order = this.orders.get(orderId);
    if (!order) throw new MercadoPagoError('Order nao encontrada.', 404, 'order_not_found');
    return order;
  }

  async cancelOrder(orderId) {
    this.setStatus(orderId, 'canceled', 'canceled');
    return this.orders.get(orderId);
  }

  setStatus(orderId, status, statusDetail = status, options = {}) {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Missing order ${orderId}`);

    const payment = order.transactions.payments[0];
    order.status = status;
    order.status_detail = statusDetail;
    payment.status = status === 'processed' ? 'processed' : status;
    payment.status_detail = status === 'processed' ? 'accredited' : statusDetail;

    if (options.amount) {
      payment.amount = options.amount;
      payment.paid_amount = options.amount;
      order.total_paid_amount = options.amount;
    }

    if (status === 'processed') {
      payment.reference = { id: `MP_${payment.id}` };
    }
  }
}

function setup(env = {}, options = {}) {
  const db = createDatabase(':memory:');
  const provider = new FakeMercadoPagoProvider();
  const app = createApp({
    db,
    seed: false,
    mercadoPagoProvider: provider,
    envFilePath: options.envFilePath,
    env: {
      NODE_ENV: 'test',
      MERCADO_PAGO_ACCESS_TOKEN: 'TEST_TOKEN',
      MERCADO_PAGO_TERMINAL_ID: 'NEWLAND_N950__SBX0000001',
      MERCADOPAGO_WEBHOOK_SIGNATURE_REQUIRED: 'false',
      MERCADOPAGO_ENABLE_QR: 'true',
      ...env,
    },
  });

  return { app, db, provider, http: request(app) };
}

function createTempEnvFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, '.env');
}

function buildPointOrder({
  id = 'ORD_DIRECT_1',
  paymentId = 'PAY_DIRECT_1',
  amount = '15.00',
  status = 'processed',
  statusDetail = 'processed',
  paymentStatus = 'processed',
  paymentStatusDetail = 'accredited',
  paymentMethodType = 'credit_card',
  paymentMethodId = 'visa',
  installments = 1,
  terminalId = 'NEWLAND_N950__DIRECT001',
  externalReference = null,
} = {}) {
  return {
    id,
    type: 'point',
    external_reference: externalReference,
    status,
    status_detail: statusDetail,
    total_paid_amount: amount,
    created_date: '2026-09-08T15:20:00.000Z',
    last_updated_date: '2026-09-08T15:21:00.000Z',
    transactions: {
      payments: [
        {
          id: paymentId,
          amount,
          paid_amount: amount,
          status: paymentStatus,
          status_detail: paymentStatusDetail,
          payment_method: {
            type: paymentMethodType,
            id: paymentMethodId,
            installments,
          },
        },
      ],
    },
    config: {
      point: {
        terminal_id: terminalId,
      },
    },
  };
}

async function createSale(http, paymentMethod = 'CARD', amountCents = 1500) {
  const response = await http.post('/api/sales').send({
    payment_method: paymentMethod,
    amount_cents: amountCents,
  });
  assert.equal(response.status, 201);
  return response.body.sale;
}

async function createSaleAndPayment(http, paymentMethod = 'CARD', amountCents = 1500) {
  const sale = await createSale(http, paymentMethod, amountCents);
  const response = await http
    .post(`/api/sales/${sale.id}/payments`)
    .send({ payment_method: paymentMethod });
  assert.equal(response.status, 201);
  return response.body.sale;
}

test('cria uma venda pendente somente por valor', async (t) => {
  const { db, http } = setup();
  t.after(() => db.close());

  const sale = await createSale(http);

  assert.equal(sale.status, 'PENDING');
  assert.equal(sale.total_cents, 1500);
  assert.equal(sale.items.length, 0);
  assert.equal(sale.external_reference, `VENDA_${sale.id}`);
});

test('checkout automatico cria venda e envia cobranca em uma unica chamada', async (t) => {
  const { db, http, provider } = setup();
  t.after(() => db.close());

  const response = await http.post('/api/checkout/point').send({
    payment_method: 'CARD',
    amount_cents: 1500,
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.sale.status, 'PENDING');
  assert.equal(response.body.sale.provider_order_id, 'ORD_TEST_1');
  assert.equal(provider.lastCreatedOrderInput.terminalId, 'NEWLAND_N950__SBX0000001');
  assert.equal(provider.lastCreatedOrderInput.externalReference, `VENDA_${response.body.sale.id}`);
  assert.equal(get(db, 'SELECT COUNT(*) AS count FROM sales').count, 1);
  assert.equal(get(db, 'SELECT COUNT(*) AS count FROM payments').count, 1);
});

test('cadastro local da maquininha passa a ser usado nas cobrancas', async (t) => {
  const { db, http, provider } = setup({ MERCADO_PAGO_TERMINAL_ID: '' });
  t.after(() => db.close());

  const terminal = await http
    .post('/api/terminals')
    .send({ provider_terminal_id: 'NEWLAND_N950__SERIAL_REAL' });
  assert.equal(terminal.status, 201);

  const checkout = await http.post('/api/checkout/point').send({
    payment_method: 'CARD',
    amount_cents: 1500,
  });

  assert.equal(checkout.status, 201);
  assert.equal(provider.lastCreatedOrderInput.terminalId, 'NEWLAND_N950__SERIAL_REAL');
});

test('sincroniza terminais oficiais da conta', async (t) => {
  const { db, http } = setup();
  t.after(() => db.close());

  const response = await http.get('/api/terminals?sync=true');

  assert.equal(response.status, 200);
  assert.equal(response.body.terminals[0].provider_terminal_id, 'NEWLAND_N950__SBX0000001');
});

test('salva credenciais Mercado Pago no backend com retorno mascarado', async (t) => {
  const envFilePath = createTempEnvFile(t);
  const { db, http } = setup(
    {
      MERCADO_PAGO_PUBLIC_KEY: '',
      MERCADO_PAGO_ACCESS_TOKEN: '',
      MERCADO_PAGO_CLIENT_ID: '',
      MERCADO_PAGO_CLIENT_SECRET: '',
      MERCADO_PAGO_WEBHOOK_SECRET: '',
      MERCADO_PAGO_TERMINAL_ID: '',
    },
    { envFilePath },
  );
  t.after(() => db.close());

  const response = await http.put('/api/mercadopago/credentials').send({
    public_key: 'APP_USR_PUBLIC_TEST',
    access_token: 'APP_USR_ACCESS_TEST_TOKEN',
    client_id: '123456789',
    client_secret: 'CLIENT_SECRET_TEST',
    webhook_secret: 'WEBHOOK_SECRET_TEST',
    terminal_id: 'NEWLAND_N950__SERIAL_CFG',
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.credentials.access_token.configured, true);
  assert.equal(response.body.credentials.access_token.masked, 'APP_...OKEN');
  assert.notEqual(response.body.credentials.access_token.masked, 'APP_USR_ACCESS_TEST_TOKEN');
  assert.equal(response.body.terminal.provider_terminal_id, 'NEWLAND_N950__SERIAL_CFG');

  const envFile = fs.readFileSync(envFilePath, 'utf8');
  assert.match(envFile, /MERCADO_PAGO_ACCESS_TOKEN=APP_USR_ACCESS_TEST_TOKEN/);
  assert.match(envFile, /MERCADO_PAGO_CLIENT_SECRET=CLIENT_SECRET_TEST/);

  const config = await http.get('/api/config');
  assert.equal(config.body.mercadopago.terminal_configured, true);
  assert.equal(config.body.mercadopago.terminal_id, 'NEWLAND_N950__SERIAL_CFG');
});

test('cria pagamento no Mercado Pago e mantem venda pendente', async (t) => {
  const { db, http, provider } = setup();
  t.after(() => db.close());

  const sale = await createSaleAndPayment(http);

  assert.equal(sale.status, 'PENDING');
  assert.equal(sale.provider_order_id, 'ORD_TEST_1');
  assert.equal(provider.orders.size, 1);
  assert.equal(get(db, 'SELECT COUNT(*) AS count FROM payments').count, 1);
});

test('pagamento aprovado contabiliza caixa', async (t) => {
  const { db, http, provider } = setup();
  t.after(() => db.close());

  const sale = await createSaleAndPayment(http);
  provider.setStatus(sale.provider_order_id, 'processed', 'processed', { amount: '15.00' });

  const response = await http.get(`/api/sales/${sale.id}/status`);

  assert.equal(response.status, 200);
  assert.equal(response.body.sale.status, 'APPROVED');
  assert.equal(get(db, 'SELECT SUM(amount_cents) AS total FROM cash_movements').total, 1500);
});

test('pagamento recusado nao contabiliza caixa', async (t) => {
  const { db, http, provider } = setup();
  t.after(() => db.close());

  const sale = await createSaleAndPayment(http);
  provider.setStatus(sale.provider_order_id, 'failed', 'rejected_by_issuer');

  const response = await http.get(`/api/sales/${sale.id}/status`);

  assert.equal(response.body.sale.status, 'REJECTED');
  assert.equal(get(db, 'SELECT COUNT(*) AS count FROM cash_movements').count, 0);
});

test('pagamento cancelado nao contabiliza caixa', async (t) => {
  const { db, http, provider } = setup();
  t.after(() => db.close());

  const sale = await createSaleAndPayment(http);
  provider.setStatus(sale.provider_order_id, 'canceled', 'canceled_on_terminal');

  const response = await http.get(`/api/sales/${sale.id}/status`);

  assert.equal(response.body.sale.status, 'CANCELLED');
  assert.equal(get(db, 'SELECT COUNT(*) AS count FROM cash_movements').count, 0);
});

test('webhook recebido confirma order consultando provider', async (t) => {
  const { db, http, provider } = setup();
  t.after(() => db.close());

  const sale = await createSaleAndPayment(http);
  provider.setStatus(sale.provider_order_id, 'processed', 'processed', { amount: '15.00' });

  const response = await http
    .post(`/api/webhooks/mercadopago?data.id=${sale.provider_order_id}&type=order`)
    .set('x-request-id', 'request-1')
    .send({
      action: 'order.processed',
      type: 'order',
      data: { id: sale.provider_order_id },
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.sale.status, 'APPROVED');
});

test('webhook duplicado nao duplica caixa', async (t) => {
  const { db, http, provider } = setup();
  t.after(() => db.close());

  const sale = await createSaleAndPayment(http);
  provider.setStatus(sale.provider_order_id, 'processed', 'processed', { amount: '15.00' });
  const url = `/api/webhooks/mercadopago?data.id=${sale.provider_order_id}&type=order`;

  await http.post(url).set('x-request-id', 'request-duplicate').send({
    action: 'order.processed',
    type: 'order',
    data: { id: sale.provider_order_id },
  });
  const second = await http.post(url).set('x-request-id', 'request-duplicate').send({
    action: 'order.processed',
    type: 'order',
    data: { id: sale.provider_order_id },
  });

  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(get(db, "SELECT COUNT(*) AS count FROM cash_movements WHERE type = 'SALE'").count, 1);
});

test('webhook de venda feita na Point cria venda local automaticamente', async (t) => {
  const { db, http, provider } = setup();
  t.after(() => db.close());

  provider.orders.set('ORD_DIRECT_1', buildPointOrder());

  const response = await http
    .post('/api/mercadopago/webhook?data.id=ORD_DIRECT_1&type=order')
    .set('x-request-id', 'request-direct')
    .send({ action: 'order.processed', type: 'order', data: { id: 'ORD_DIRECT_1' } });

  assert.equal(response.status, 200);
  assert.equal(response.body.sale.status, 'APPROVED');
  assert.equal(response.body.sale.source, 'MERCADOPAGO_WEBHOOK');
  assert.equal(response.body.sale.payment.transaction_id, 'PAY_DIRECT_1');
  assert.equal(response.body.sale.payment.installments, 1);
  assert.equal(response.body.sale.payment.provider_terminal_id, 'NEWLAND_N950__DIRECT001');
  assert.equal(get(db, "SELECT COUNT(*) AS count FROM sales WHERE status = 'APPROVED'").count, 1);
  assert.equal(get(db, "SELECT COUNT(*) AS count FROM cash_movements WHERE type = 'SALE'").count, 1);
});

test('webhook repetido de venda direta nao duplica venda nem caixa', async (t) => {
  const { db, http, provider } = setup();
  t.after(() => db.close());

  provider.orders.set('ORD_DIRECT_DUP', buildPointOrder({ id: 'ORD_DIRECT_DUP', paymentId: 'PAY_DIRECT_DUP' }));
  const url = '/api/mercadopago/webhook?data.id=ORD_DIRECT_DUP&type=order';

  await http
    .post(url)
    .set('x-request-id', 'request-direct-1')
    .send({ action: 'order.processed', type: 'order', data: { id: 'ORD_DIRECT_DUP' } });
  const second = await http
    .post(url)
    .set('x-request-id', 'request-direct-2')
    .send({ action: 'order.processed', type: 'order', data: { id: 'ORD_DIRECT_DUP' } });

  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(get(db, 'SELECT COUNT(*) AS count FROM sales').count, 1);
  assert.equal(get(db, 'SELECT COUNT(*) AS count FROM payments').count, 1);
  assert.equal(get(db, "SELECT COUNT(*) AS count FROM cash_movements WHERE type = 'SALE'").count, 1);
});

test('webhook com order inexistente na API oficial e ignorado sem venda local', async (t) => {
  const { db, http } = setup();
  t.after(() => db.close());

  const response = await http
    .post('/api/mercadopago/webhook?data.id=ORD_MISSING&type=order')
    .set('x-request-id', 'request-missing')
    .send({ action: 'order.processed', type: 'order', data: { id: 'ORD_MISSING' } });

  assert.equal(response.status, 200);
  assert.equal(response.body.ignored, true);
  assert.equal(response.body.reason, 'order_not_found');
  assert.equal(get(db, 'SELECT COUNT(*) AS count FROM sales').count, 0);
});

test('valor divergente nao aprova venda', async (t) => {
  const { db, http, provider } = setup();
  t.after(() => db.close());

  const sale = await createSaleAndPayment(http);
  provider.setStatus(sale.provider_order_id, 'processed', 'processed', { amount: '14.00' });

  const response = await http.get(`/api/sales/${sale.id}/status`);

  assert.equal(response.body.sale.status, 'ACTION_REQUIRED');
  assert.equal(response.body.sale.payment.status, 'AMOUNT_MISMATCH');
  assert.equal(get(db, 'SELECT COUNT(*) AS count FROM cash_movements').count, 0);
});

test('aprovacao repetida contabiliza caixa apenas uma vez', async (t) => {
  const { db, http, provider } = setup();
  t.after(() => db.close());

  const sale = await createSaleAndPayment(http);
  provider.setStatus(sale.provider_order_id, 'processed', 'processed', { amount: '15.00' });

  await http.get(`/api/sales/${sale.id}/status`);
  await http.get(`/api/sales/${sale.id}/status`);

  assert.equal(get(db, "SELECT COUNT(*) AS count FROM cash_movements WHERE type = 'SALE'").count, 1);
});

test('fechamento de caixa usa somente vendas aprovadas', async (t) => {
  const { db, http, provider } = setup();
  t.after(() => db.close());

  const approvedSale = await createSaleAndPayment(http);
  provider.setStatus(approvedSale.provider_order_id, 'processed', 'processed', { amount: '15.00' });
  await http.get(`/api/sales/${approvedSale.id}/status`);

  const rejectedSale = await createSaleAndPayment(http);
  provider.setStatus(rejectedSale.provider_order_id, 'failed', 'rejected_by_issuer');
  await http.get(`/api/sales/${rejectedSale.id}/status`);

  const current = await http.get('/api/cash-registers/current');
  const close = await http.post(`/api/cash-registers/${current.body.cash_register.id}/close`);
  const summary = await http.get(`/api/cash-registers/${current.body.cash_register.id}/summary`);

  assert.equal(close.body.cash_register.closing_balance_cents, 1500);
  assert.equal(summary.body.summary.gross_revenue_cents, 1500);
  assert.equal(summary.body.summary.sales.approved, 1);
  assert.equal(summary.body.summary.sales.rejected, 1);
});

test('erro de comunicacao com Mercado Pago nao marca venda como paga', async (t) => {
  const { db, http, provider } = setup();
  t.after(() => db.close());

  const sale = await createSale(http);
  provider.failCreate = true;

  const response = await http.post(`/api/sales/${sale.id}/payments`).send({ payment_method: 'CARD' });

  assert.equal(response.status, 502);
  assert.equal(get(db, 'SELECT status FROM sales WHERE id = ?', [sale.id]).status, 'PENDING');
  assert.equal(get(db, 'SELECT COUNT(*) AS count FROM payments').count, 0);
});
