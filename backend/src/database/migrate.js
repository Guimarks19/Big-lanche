const fs = require('node:fs');
const path = require('node:path');
const { createDatabase } = require('./connection');

function migrate(db) {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);
  applyCompatibleAlterations(db);
}

function applyCompatibleAlterations(db) {
  ensureColumn(db, 'sales', 'source', "TEXT NOT NULL DEFAULT 'PDV'");
  ensureColumn(db, 'payments', 'installments', 'INTEGER');
  ensureColumn(db, 'payments', 'provider_payment_method_id', 'TEXT');
  ensureColumn(db, 'payments', 'provider_payment_method_type', 'TEXT');
  ensureColumn(db, 'payments', 'provider_terminal_id', 'TEXT');
  ensureColumn(db, 'payments', 'provider_created_at', 'TEXT');
  ensureColumn(db, 'payments', 'provider_updated_at', 'TEXT');
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some((column) => column.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

if (require.main === module) {
  const db = createDatabase();
  migrate(db);
  db.close();
  console.log('Banco SQLite migrado com sucesso.');
}

module.exports = { migrate };
