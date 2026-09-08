const { createDatabase, get, run } = require('./connection');
const { migrate } = require('./migrate');

function seed(db) {
  const userCount = get(db, 'SELECT COUNT(*) AS count FROM users').count;
  if (userCount === 0) {
    run(db, 'INSERT INTO users (name, role) VALUES (?, ?)', ['Operador', 'operator']);
  }

  const openCashRegister = get(db, "SELECT id FROM cash_registers WHERE status = 'OPEN' LIMIT 1");
  if (!openCashRegister) {
    const user = get(db, 'SELECT id FROM users ORDER BY id LIMIT 1');
    run(db, 'INSERT INTO cash_registers (opening_balance_cents, created_by) VALUES (?, ?)', [
      0,
      user?.id || null,
    ]);
  }
}

if (require.main === module) {
  const db = createDatabase();
  migrate(db);
  seed(db);
  db.close();
  console.log('Dados iniciais inseridos com sucesso.');
}

module.exports = { seed };
