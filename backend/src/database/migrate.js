const path = require('node:path');
const { createDatabase } = require('./connection');
const { get, run } = require('./connection');

async function migrate(db) {
  await ensureMigrationsTable(db);
  if (db.dialect === 'sqlite') applyCompatibleAlterations(db);

  const migrations = loadMigrations();

  for (const migration of migrations) {
    const applied = await get(db, 'SELECT id FROM schema_migrations WHERE id = ?', [migration.id]);
    if (applied) continue;

    await migration.up(db);
    await run(db, 'INSERT INTO schema_migrations (id) VALUES (?)', [migration.id]);
  }

  if (db.dialect === 'sqlite') applyCompatibleAlterations(db);
}

async function ensureMigrationsTable(db) {
  if (db.dialect === 'postgres') {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    return;
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function loadMigrations() {
  const migrationsDir = path.join(__dirname, 'migrations');
  return allMigrationFiles(migrationsDir).map((fileName) => require(path.join(migrationsDir, fileName)));
}

function allMigrationFiles(migrationsDir) {
  return require('node:fs')
    .readdirSync(migrationsDir)
    .filter((fileName) => fileName.endsWith('.js'))
    .sort();
}

function applyCompatibleAlterations(db) {
  ensureColumn(db, 'users', 'email', 'TEXT');
  ensureColumn(db, 'users', 'password_hash', 'TEXT');
  ensureColumn(db, 'users', 'email_verified', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'email_verified_at', 'TEXT');
  ensureColumn(db, 'users', 'updated_at', 'TEXT');
  safeExec(db, 'UPDATE users SET updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)');
  ensureColumn(db, 'cash_registers', 'user_id', 'INTEGER');
  ensureColumn(db, 'sales', 'source', "TEXT NOT NULL DEFAULT 'PDV'");
  ensureColumn(db, 'sales', 'user_id', 'INTEGER');
  ensureColumn(db, 'payments', 'installments', 'INTEGER');
  ensureColumn(db, 'payments', 'provider_payment_method_id', 'TEXT');
  ensureColumn(db, 'payments', 'provider_payment_method_type', 'TEXT');
  ensureColumn(db, 'payments', 'provider_terminal_id', 'TEXT');
  ensureColumn(db, 'payments', 'provider_created_at', 'TEXT');
  ensureColumn(db, 'payments', 'provider_updated_at', 'TEXT');
  ensureColumn(db, 'payments', 'card_brand', 'TEXT');
  ensureColumn(db, 'payments', 'card_type', 'TEXT');
  ensureColumn(db, 'payments', 'external_reference', 'TEXT');
  ensureColumn(db, 'payments', 'provider_user_id', 'TEXT');
  ensureColumn(db, 'payments', 'provider_action', 'TEXT');
  ensureColumn(db, 'cash_movements', 'user_id', 'INTEGER');
  ensureColumn(db, 'webhook_events', 'user_id', 'INTEGER');
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.length === 0) return;
  if (columns.some((column) => column.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function safeExec(db, sql) {
  try {
    db.exec(sql);
  } catch {
    // Compatibility helpers are best-effort for older local SQLite files.
  }
}

if (require.main === module) {
  (async () => {
    const db = createDatabase();
    await migrate(db);
    await db.close();
    console.log(`${db.dialect === 'postgres' ? 'PostgreSQL' : 'SQLite'} migrado com sucesso.`);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { migrate };
