const { createApp } = require('./app');

const app = createApp({ seed: true });
const { PORT } = app.locals.env;

app.listen(PORT, () => {
  console.log(`PDV Mercado Pago rodando em http://localhost:${PORT}`);
});
