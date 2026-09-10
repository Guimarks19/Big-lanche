# Big Lanche

Sistema de acompanhamento de vendas Mercado Pago Point Smart para a Big Lanche.

O fluxo principal nao e checkout manual. A venda acontece primeiro no Mercado Pago/Point, o Mercado Pago envia o webhook `Order (Mercado Pago)`, o backend consulta/confirma a Order oficial e registra a venda automaticamente no banco.

```text
Point Smart
  -> Mercado Pago
  -> POST /api/mercadopago/webhook
  -> consulta GET /v1/orders/{id}
  -> registro automatico da venda
  -> dashboard atualizado
```

## Stack

- Backend Node.js + Express.
- Frontend HTML, CSS e JavaScript puro.
- Banco local SQLite para desenvolvimento.
- PostgreSQL para producao no Render via `DATABASE_URL`.
- Migrations com tabela `schema_migrations`.
- Mercado Pago via SDK/API oficial.
- Autenticacao com bcrypt, cookies HttpOnly e CSRF para rotas privadas.

## Documentacao oficial usada

- Webhooks Point/Orders: https://www.mercadopago.com.br/developers/pt/docs/mp-point/notifications
- Criar Order Point: https://www.mercadopago.com.br/developers/pt/reference/in-person-payments/point/orders/create-order/post
- Consultar Order Point: https://www.mercadopago.com.br/developers/pt/reference/in-person-payments/point/orders/get-order/get
- OAuth Mercado Pago: https://www.mercadopago.com.br/developers/pt/docs/security/oauth/creation
- Terminais Point: endpoint oficial `GET https://api.mercadopago.com/terminals/v1/list`

## Estrutura

```text
backend/
  src/
    config/
    controllers/
    database/
      migrations/
    middlewares/
    routes/
    services/
    utils/
frontend/
  css/
  js/
  index.html
tests/
.env.example
package.json
README.md
```

## Rotas principais

- `POST /api/mercadopago/webhook`: recebe `Order (Mercado Pago)`.
- `GET /api/mercadopago/connect`: inicia OAuth Mercado Pago.
- `GET /api/mercadopago/oauth/callback`: callback OAuth.
- `GET /api/mercadopago/status`: status da conta e terminais do usuario.
- `POST /api/mercadopago/sync-terminals`: consulta terminais da conta.
- `POST /api/mercadopago/active-terminal`: define Point ativa.
- `GET /api/sales`: lista vendas do usuario logado.
- `GET /api/dashboard`: resumo do dia.
- `POST /api/auth/register`, `/login`, `/logout`, `/verify-email`, `/forgot-password`, `/reset-password`.

As rotas legadas que criam cobranca Point foram preservadas para compatibilidade e testes, mas a interface principal nao expõe checkout manual.

## Variaveis de ambiente

Copie `.env.example` para `.env` no ambiente local. No Render, cadastre as variaveis pelo painel do serviço.

```env
NODE_ENV=production
PORT=3000
APP_BASE_URL=https://big-lanche.onrender.com
DATABASE_URL=postgres://...
DATABASE_SSL=true
SESSION_COOKIE_NAME=big_lanche_session
CSRF_COOKIE_NAME=big_lanche_csrf
BCRYPT_ROUNDS=12
ENCRYPTION_KEY=base64_32_bytes
SMTP_HOST=smtp.exemplo.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=usuario_smtp
SMTP_PASS=senha_smtp
SMTP_FROM="Big Lanche <no-reply@seudominio.com>"
MERCADO_PAGO_CLIENT_ID=
MERCADO_PAGO_CLIENT_SECRET=
MERCADO_PAGO_REDIRECT_URI=https://big-lanche.onrender.com/api/mercadopago/oauth/callback
MERCADO_PAGO_WEBHOOK_SECRET=
MERCADO_PAGO_ACCESS_TOKEN=
MERCADOPAGO_API_BASE_URL=https://api.mercadopago.com
MERCADOPAGO_WEBHOOK_SIGNATURE_REQUIRED=true
ENABLE_TEST_ENDPOINTS=false
```

Gere `ENCRYPTION_KEY` assim:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Nunca envie `.env`, Access Token, Refresh Token ou Client Secret para o GitHub.

## Render

1. Crie ou vincule um PostgreSQL no Render.
2. Configure `DATABASE_URL` com a URL do PostgreSQL.
3. Configure `APP_BASE_URL=https://big-lanche.onrender.com`.
4. Configure SMTP para verificacao de e-mail e recuperacao de senha.
5. Configure as credenciais OAuth do Mercado Pago.
6. Use `npm install` como build command.
7. Use `npm start` como start command.

O servidor usa `process.env.PORT || 3000`, entao funciona corretamente no Render.

## Mercado Pago

Webhook de producao:

```text
https://big-lanche.onrender.com/api/mercadopago/webhook
```

Callback OAuth:

```text
https://big-lanche.onrender.com/api/mercadopago/oauth/callback
```

No painel Mercado Pago:

1. Configure Webhooks.
2. Selecione o evento `Order (Mercado Pago)`.
3. Cole a URL de producao acima.
4. Copie a chave secreta do webhook para `MERCADO_PAGO_WEBHOOK_SECRET`.
5. Configure o redirect URI OAuth igual ao callback acima.

Nao use URL de repositorio GitHub como webhook. A URL precisa ser um backend HTTPS em execucao.

## Webhook

A rota aceita notificacoes com dados no body ou query string, por exemplo:

```text
POST /api/mercadopago/webhook?data.id=123456&type=order
```

Comportamento:

- valida `type === "order"`;
- aceita `data.id` no body ou `req.query["data.id"]`;
- responde `200` para simulacoes validas;
- nao retorna `500` quando o simulador usa ID numerico sem Order real;
- processa Orders reais com ID iniciado em `ORD`;
- valida assinatura oficial quando aplicavel;
- consulta `GET /v1/orders/{id}`;
- grava venda e pagamento com idempotencia.

## Rodar localmente

```bash
npm install
npm run db:migrate
npm start
```

Acesse:

```text
http://localhost:3000
```

Sem SMTP em desenvolvimento, os e-mails ficam no outbox em memoria e o link aparece nos metadados usados pelos testes.

## Testes

```bash
npm test
```

A suite cobre criacao de venda, pagamento aprovado/recusado/cancelado, webhook duplicado, order inexistente, valor divergente, caixa e falha de comunicacao com Mercado Pago.

## Testar webhook antes da producao

Opcoes seguras:

- Use a URL do Render em staging/producao.
- Ou exponha o local com HTTPS usando ngrok/Cloudflare Tunnel:

```bash
ngrok http 3000
```

Depois configure no Mercado Pago:

```text
https://SEU-SUBDOMINIO.ngrok-free.app/api/mercadopago/webhook
```

No simulador do Mercado Pago, um `data.id` como `123456` pode nao existir. Isso e esperado: o backend registra log de simulacao e responde `200`.

## Banco

Em desenvolvimento, o sistema usa SQLite em `backend/data/pdv.sqlite`.

Em producao, use PostgreSQL com `DATABASE_URL`. As tabelas incluem:

- `users`
- `sessions`
- `email_verification_tokens`
- `password_reset_tokens`
- `mercado_pago_connections`
- `mercado_pago_oauth_states`
- `point_terminals`
- `sales`
- `payments`
- `cash_registers`
- `cash_movements`
- `webhook_events`

Tokens Mercado Pago sao armazenados criptografados. Senhas ficam apenas como `password_hash`.
