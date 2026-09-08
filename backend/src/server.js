const { createApp } = require('./app');

const app = createApp({ seed: true });
const port = process.env.PORT || app.locals.env.PORT || 3000;

app.listen(port, () => {
  console.log(`PDV Mercado Pago rodando na porta ${port}`);
});
