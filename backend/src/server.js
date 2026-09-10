const { createApp } = require('./app');

(async () => {
  const app = await createApp({ seed: true });
  const PORT = process.env.PORT || app.locals.env.PORT || 3000;

  app.listen(PORT, () => {
    console.log(`Big Lanche rodando na porta ${PORT}`);
  });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
