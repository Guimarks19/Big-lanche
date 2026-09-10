const { createDatabase, get, run } = require('./connection');
const { migrate } = require('./migrate');

async function seed(db) {
  const openCashRegister = await get(db, "SELECT id FROM cash_registers WHERE status = 'OPEN' LIMIT 1");
  if (!openCashRegister) {
    const user = await get(db, 'SELECT id FROM users ORDER BY id LIMIT 1');
    await run(db, 'INSERT INTO cash_registers (opening_balance_cents, created_by, user_id) VALUES (?, ?, ?)', [
      0,
      user?.id || null,
      user?.id || null,
    ]);
  }
}

if (require.main === module) {
  (async () => {
    const db = createDatabase();
    await migrate(db);
    await seed(db);
    await db.close();
    console.log('Dados iniciais inseridos com sucesso.');
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { seed };
