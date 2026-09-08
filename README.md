# PDV Mercado Pago Point Smart

Sistema inicial de PDV para loja, com backend Node.js, frontend HTML/CSS/JS, SQLite e integracao exclusiva com Mercado Pago Point via Orders API.

Nesta versao o fluxo principal e venda por valor: nao e necessario declarar produtos. O sistema registra uma venda interna generica, envia a cobranca para a Point Smart e so considera vendido quando o Mercado Pago confirmar o pagamento.

## O que ja esta construido

- Venda por valor, sem obrigar cadastro de produtos.
- Venda interna com status `PENDING`, `APPROVED`, `REJECTED`, `CANCELLED`, `REFUNDED`, `EXPIRED` e `ACTION_REQUIRED`.
- Integracao isolada em `PaymentService -> MercadoPagoProvider`.
- Criacao de order Point em `POST /v1/orders` com `X-Idempotency-Key`.
- Consulta de status em `GET /v1/orders/{order_id}`.
- Webhook `Order (Mercado Pago)` com validacao oficial por `WebhookSignatureValidator`.
- Movimento de caixa somente apos pagamento aprovado confirmado.
- Protecao contra webhook duplicado.
- Aba `Vendas` com valor, botoes de pagamento, credenciais Mercado Pago, cadastro/status da Point Smart e ultima transacao.
- Aba `Historico` com faturamento, vendas, ticket medio, formas de pagamento e movimentacoes.
- Testes automatizados para os 12 cenarios solicitados.

## Documentacao oficial usada

- Point e fluxo integrado: https://www.mercadopago.com.br/developers/pt/docs/mp-point/payment-processing
- Configuracao do terminal em modo PDV: https://www.mercadopago.com.br/developers/pt/docs/mp-point/configure-terminal
- Criar order Point: https://www.mercadopago.com.br/developers/pt/reference/in-person-payments/point/orders/create-order/post
- Consultar order: https://www.mercadopago.com.br/developers/pt/reference/in-person-payments/point/orders/get-order/get
- Webhooks de orders: https://www.mercadopago.com.br/developers/pt/docs/mp-point/notifications
- Status de order/transacao: https://www.mercadopago.com.br/developers/pt/docs/mp-point/resources/status-order-transaction
- Simular status em teste: https://www.mercadopago.com.br/developers/pt/reference/in-person-payments/point/orders/simulate-order/post
- Migracao Payment Intents para Orders API: https://www.mercadopago.com.br/developers/pt/docs/mp-point/migrate-payment-intent-to-orders

## Estrutura

```text
backend/
  src/
    config/
    controllers/
    database/
    middlewares/
    routes/
    services/
    utils/
frontend/
  css/
  js/
  index.html
tests/
.env
.env.example
package.json
README.md
```

## Variaveis de ambiente

As credenciais ficam apenas no backend. Nunca coloque Access Token no frontend.

```env
MERCADOPAGO_PUBLIC_KEY=
MERCADOPAGO_ACCESS_TOKEN=
MERCADOPAGO_CLIENT_ID=
MERCADOPAGO_CLIENT_SECRET=
MERCADOPAGO_WEBHOOK_SECRET=
MERCADOPAGO_TERMINAL_ID=
MERCADOPAGO_CARD_DEFAULT_TYPE=credit_card
MERCADOPAGO_ENABLE_QR=false
```

`MERCADOPAGO_TERMINAL_ID` deve usar o ID retornado por `GET /terminals/v1/list`, por exemplo `NEWLAND_N950__SBX0000001` em teste.

Pela documentacao oficial, `Access Token` e `Client Secret` sao chaves privadas e ficam somente no backend. A tela do PDV envia esses valores para `PUT /api/mercadopago/credentials`, o backend grava no `.env` e a interface passa a mostrar apenas valores mascarados.

Para enviar cobrancas para a Point Smart da propria conta, o fluxo usa principalmente:

- `MERCADOPAGO_ACCESS_TOKEN`
- `MERCADOPAGO_TERMINAL_ID`
- `MERCADOPAGO_WEBHOOK_SECRET`

`Public Key`, `Client ID` e `Client Secret` ficam cadastrados para completar a configuracao da aplicacao e preparar fluxos futuros, como OAuth, mas nao sao necessarios para criar uma order Point da propria conta.

## Como rodar

```bash
npm install
npm run db:seed
npm start
```

Acesse:

```text
http://localhost:3000
```

## Como cadastrar a maquininha no sistema

Pela documentacao oficial do Mercado Pago, o cadastro real da Point Smart acontece em duas partes:

1. No Mercado Pago/app da maquininha, a Point precisa estar associada a uma conta, loja e caixa.
2. No PDV, voce salva o `terminal_id` dessa Point para o sistema saber para qual maquininha enviar a cobranca.

No sistema:

1. Abra a aba `Vendas`.
2. No bloco `Credenciais Mercado Pago`, preencha as chaves da sua aplicacao e clique em `Salvar credenciais`.
3. No bloco `Point Smart`, informe o ID da maquininha.
4. Clique em `Salvar`.
5. Clique em `Ativar PDV`.

O ID oficial da maquininha vem do endpoint:

```http
GET https://api.mercadopago.com/terminals/v1/list
```

Ele tem este formato:

```text
NEWLAND_N950__N950NCB801293324
```

Os ultimos caracteres devem bater com o serial da maquininha fisica.

Tambem e possivel clicar em `Sincronizar` na aba `Vendas`, desde que `MERCADOPAGO_ACCESS_TOKEN` esteja preenchido. O sistema busca os terminais da sua conta pelo endpoint oficial e permite escolher um.

## Como testar automatizado

```bash
npm test
```

Os testes usam um provider falso para simular respostas oficiais da Orders API sem cobrança real.

## Como testar com Mercado Pago sem cobrança real

1. Crie uma aplicacao no painel Mercado Pago.
2. Use as credenciais de teste no `.env`.
3. Configure/crie loja e caixa conforme a documentacao oficial.
4. Associe o terminal de teste ou use o serial sandbox `SBX0000001`, quando disponivel para sua conta.
5. Configure `MERCADOPAGO_TERMINAL_ID`.
6. Configure o Webhook no topico `Order (Mercado Pago)` apontando para:

```text
https://seu-dominio-publico/api/webhooks/mercadopago
```

Para ambiente local, exponha a porta 3000 com uma ferramenta como ngrok ou Cloudflare Tunnel.

7. Informe R$ 15,00 no PDV.
8. Clique em `Cartao`.
9. A order sera criada no Mercado Pago e a venda continuara `PENDING`.
10. Para simular o resultado oficial sem pagamento real, habilite temporariamente:

```env
ENABLE_TEST_ENDPOINTS=true
```

Depois chame:

```bash
curl -X POST http://localhost:3000/api/dev/mercadopago/orders/ORDER_ID/events \
  -H "Content-Type: application/json" \
  -d "{\"status\":\"processed\",\"payment_method_type\":\"credit_card\",\"installments\":1,\"payment_method_id\":\"visa\",\"status_detail\":\"accredited\"}"
```

Esse endpoint local chama a simulacao oficial do Mercado Pago: `POST /v1/orders/{order_id}/events`.

## Fluxo atual

```text
Operador informa apenas o valor na aba Vendas
↓
Sistema cria venda interna PENDING
↓
Sistema cria order Point no Mercado Pago
↓
Point Smart cobra o cliente
↓
Mercado Pago confirma por Webhook/consulta
↓
Se aprovado: venda APPROVED e valor entra no caixa
↓
Se recusado/cancelado/expirado: nao entra no caixa
```

## Observacao sobre Pix

A Orders API documenta `qr` como tipo possivel para simulacao/default de metodo, mas a documentacao de modo PDV tambem informa que o modo integrado PDV recebe pagamentos com cartao. Por isso `MERCADOPAGO_ENABLE_QR` vem `false`. Habilite Pix somente depois de confirmar suporte real da sua conta, terminal e teste oficial.
