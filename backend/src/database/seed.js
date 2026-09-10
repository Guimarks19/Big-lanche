const bcrypt = require('bcryptjs');
const { loadEnv } = require('../config/env');
const { AppError } = require('../utils/errors');
const { assertStrongPassword, assertValidEmail, maskEmail } = require('../utils/security');
const { createDatabase, get, insert, run } = require('./connection');
const { migrate } = require('./migrate');

async function seed(db, env = loadEnv()) {
  const adminUser = await ensureAdminUser(db, env);
  const openCashRegister = await get(db, "SELECT id FROM cash_registers WHERE status = 'OPEN' LIMIT 1");
  if (!openCashRegister) {
    const user =
      adminUser ||
      (await get(
        db,
        "SELECT id FROM users ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, id LIMIT 1",
      ));
    await run(db, 'INSERT INTO cash_registers (opening_balance_cents, created_by, user_id) VALUES (?, ?, ?)', [
      0,
      user?.id || null,
      user?.id || null,
    ]);
  }
}

async function ensureAdminUser(db, env = {}) {
  const hasAdminEmail = Boolean(String(env.ADMIN_EMAIL || '').trim());
  const hasAdminPassword = Boolean(String(env.ADMIN_PASSWORD || '').trim());
  if (!hasAdminEmail && !hasAdminPassword) return null;

  if (!hasAdminEmail || !hasAdminPassword) {
    throw new AppError(
      'Configure ADMIN_EMAIL e ADMIN_PASSWORD para criar o administrador.',
      500,
      'ADMIN_BOOTSTRAP_INCOMPLETE',
    );
  }

  const email = assertValidEmail(env.ADMIN_EMAIL);
  const password = String(env.ADMIN_PASSWORD || '');
  const name = String(env.ADMIN_NAME || 'Administrador Big Lanche').trim() || 'Administrador Big Lanche';
  assertStrongPassword(password);

  const existing = await get(db, 'SELECT * FROM users WHERE email = ?', [email]);
  const currentHashMatches = existing?.password_hash
    ? await bcrypt.compare(password, existing.password_hash)
    : false;
  const passwordHash = currentHashMatches ? existing.password_hash : await bcrypt.hash(password, env.BCRYPT_ROUNDS || 12);

  if (existing) {
    const passwordChanged = !currentHashMatches;
    await run(
      db,
      `UPDATE users
       SET name = ?,
           password_hash = ?,
           email_verified = TRUE,
           email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP),
           role = 'admin',
           active = TRUE,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [name, passwordHash, existing.id],
    );
    if (passwordChanged) {
      await run(
        db,
        'UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL',
        [existing.id],
      );
    }
    console.info(`[Seed] Conta admin garantida: ${maskEmail(email)}`);
    return get(db, 'SELECT id FROM users WHERE email = ?', [email]);
  }

  const id = await insert(
    db,
    `INSERT INTO users
     (name, email, password_hash, email_verified, email_verified_at, role, active)
     VALUES (?, ?, ?, TRUE, CURRENT_TIMESTAMP, 'admin', TRUE)`,
    [name, email, passwordHash],
  );

  console.info(`[Seed] Conta admin criada: ${maskEmail(email)}`);
  return { id };
}

if (require.main === module) {
  (async () => {
    const env = loadEnv();
    const db = createDatabase(undefined, { env });
    await migrate(db);
    await seed(db, env);
    await db.close();
    console.log('Dados iniciais inseridos com sucesso.');
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { ensureAdminUser, seed };
