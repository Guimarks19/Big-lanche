const { all } = require('../connection');

module.exports = {
  id: '002_ensure_admin_user_columns',

  async up(db) {
    const textDate = db.dialect === 'postgres' ? 'TIMESTAMPTZ' : 'TEXT';
    const booleanTrue = db.dialect === 'postgres' ? 'BOOLEAN NOT NULL DEFAULT true' : 'INTEGER NOT NULL DEFAULT 1';
    const booleanFalse = db.dialect === 'postgres' ? 'BOOLEAN NOT NULL DEFAULT false' : 'INTEGER NOT NULL DEFAULT 0';

    await ensureColumn(db, 'users', 'name', "TEXT NOT NULL DEFAULT 'Usuário'");
    await ensureColumn(db, 'users', 'email', 'TEXT');
    await ensureColumn(db, 'users', 'password_hash', 'TEXT');
    await ensureColumn(db, 'users', 'email_verified', booleanFalse);
    await ensureColumn(db, 'users', 'email_verified_at', textDate);
    await ensureColumn(db, 'users', 'role', "TEXT NOT NULL DEFAULT 'operator'");
    await ensureColumn(db, 'users', 'active', booleanTrue);
    await ensureColumn(db, 'users', 'created_at', `${textDate} NOT NULL DEFAULT CURRENT_TIMESTAMP`);
    await ensureColumn(db, 'users', 'updated_at', `${textDate} NOT NULL DEFAULT CURRENT_TIMESTAMP`);
  },
};

async function ensureColumn(db, tableName, columnName, definition) {
  if (await hasColumn(db, tableName, columnName)) return;
  await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

async function hasColumn(db, tableName, columnName) {
  if (db.dialect === 'postgres') {
    const rows = await all(
      db,
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = ? AND column_name = ?
       LIMIT 1`,
      [tableName, columnName],
    );
    return rows.length > 0;
  }

  const rows = await all(db, `PRAGMA table_info(${tableName})`);
  return rows.some((column) => column.name === columnName);
}
