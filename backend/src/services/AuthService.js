const bcrypt = require('bcryptjs');
const { all, get, insert, run, withTransaction } = require('../database/connection');
const { AppError } = require('../utils/errors');
const {
  addDays,
  addHours,
  addMinutes,
  assertStrongPassword,
  assertValidEmail,
  hashToken,
  maskEmail,
  normalizeEmail,
  randomToken,
  serializeUser,
  toSqlDate,
} = require('../utils/security');

class AuthService {
  constructor(db, emailService, env) {
    this.db = db;
    this.emailService = emailService;
    this.env = env;
  }

  async register(input) {
    const name = String(input?.name || '').trim();
    const email = assertValidEmail(input?.email);
    const password = String(input?.password || '');
    const confirmation = String(input?.password_confirmation || input?.confirm_password || '');

    if (name.length < 2) {
      throw new AppError('Informe seu nome.', 400, 'INVALID_NAME');
    }
    if (password !== confirmation) {
      throw new AppError('As senhas nao conferem.', 400, 'PASSWORD_CONFIRMATION_MISMATCH');
    }
    assertStrongPassword(password);

    const existing = await get(this.db, 'SELECT id FROM users WHERE email = ?', [email]);
    if (existing) throw new AppError('Este e-mail ja esta cadastrado.', 409, 'EMAIL_ALREADY_EXISTS');

    const passwordHash = await bcrypt.hash(password, this.env.BCRYPT_ROUNDS);
    const userId = await insert(
      this.db,
      `INSERT INTO users (name, email, password_hash, email_verified, role, active)
       VALUES (?, ?, ?, FALSE, 'owner', TRUE)`,
      [name, email, passwordHash],
    );

    const user = await this.getUserById(userId);
    await this.sendVerification(user);

    return {
      user,
      masked_email: maskEmail(user.email),
    };
  }

  async login(input, req = null) {
    const email = normalizeEmail(input?.email);
    const password = String(input?.password || '');
    const userRow = await get(this.db, 'SELECT * FROM users WHERE email = ?', [email]);

    if (!userRow || !userRow.password_hash) {
      throw new AppError('E-mail ou senha invalidos.', 401, 'INVALID_CREDENTIALS');
    }

    const valid = await bcrypt.compare(password, userRow.password_hash);
    if (!valid) throw new AppError('E-mail ou senha invalidos.', 401, 'INVALID_CREDENTIALS');
    if (!userRow.active) throw new AppError('Usuario inativo.', 403, 'USER_INACTIVE');
    if (!Boolean(userRow.email_verified)) {
      throw new AppError('Confirme seu e-mail antes de entrar.', 403, 'EMAIL_NOT_VERIFIED');
    }

    const session = await this.createSession(userRow.id, req);
    return {
      user: serializeUser(userRow),
      session,
    };
  }

  async createSession(userId, req = null) {
    const token = randomToken(48);
    const csrfToken = randomToken(32);
    const expiresAt = addDays(new Date(), this.env.SESSION_TTL_DAYS);

    await insert(
      this.db,
      `INSERT INTO sessions
       (user_id, token_hash, csrf_token_hash, user_agent, ip_address, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        userId,
        hashToken(token),
        hashToken(csrfToken),
        req?.headers?.['user-agent'] || null,
        req?.ip || null,
        toSqlDate(expiresAt),
      ],
    );

    return {
      token,
      csrf_token: csrfToken,
      expires_at: expiresAt.toISOString(),
    };
  }

  async getSession(rawToken) {
    if (!rawToken) return null;
    const row = await get(
      this.db,
      `SELECT
         sessions.*,
         users.name,
         users.email,
         users.email_verified,
         users.email_verified_at,
         users.role,
         users.active,
         users.created_at AS user_created_at,
         users.updated_at AS user_updated_at
       FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = ?
         AND sessions.revoked_at IS NULL
         AND sessions.expires_at > ?
       LIMIT 1`,
      [hashToken(rawToken), toSqlDate(new Date())],
    );

    if (!row || !Boolean(row.active)) return null;

    return {
      id: row.id,
      user_id: row.user_id,
      csrf_token_hash: row.csrf_token_hash,
      expires_at: row.expires_at,
      user: {
        id: row.user_id,
        name: row.name,
        email: row.email,
        email_verified: Boolean(row.email_verified),
        email_verified_at: row.email_verified_at,
        role: row.role,
        active: Boolean(row.active),
        created_at: row.user_created_at,
        updated_at: row.user_updated_at,
      },
    };
  }

  async logout(sessionId) {
    if (!sessionId) return;
    await run(
      this.db,
      'UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [sessionId],
    );
  }

  async verifyEmail(token) {
    const tokenHash = hashToken(token || '');
    const tokenRow = await get(
      this.db,
      `SELECT * FROM email_verification_tokens
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
       LIMIT 1`,
      [tokenHash, toSqlDate(new Date())],
    );

    if (!tokenRow) throw new AppError('Token de verificacao invalido ou expirado.', 400, 'INVALID_VERIFICATION_TOKEN');

    await withTransaction(this.db, async (tx) => {
      await run(
        tx,
        `UPDATE users
         SET email_verified = TRUE, email_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [tokenRow.user_id],
      );
      await run(tx, 'UPDATE email_verification_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?', [tokenRow.id]);
    });

    return this.getUserById(tokenRow.user_id);
  }

  async resendVerification(userId) {
    const user = await this.getUserById(userId);
    if (user.email_verified) return { sent: false, already_verified: true };
    await this.sendVerification(user);
    return { sent: true };
  }

  async resendVerificationForEmail(emailInput) {
    const email = normalizeEmail(emailInput);
    const userRow = email ? await get(this.db, 'SELECT * FROM users WHERE email = ?', [email]) : null;

    if (userRow && !Boolean(userRow.email_verified)) {
      await this.sendVerification(serializeUser(userRow));
    }

    return { received: true };
  }

  async requestPasswordReset(emailInput) {
    const email = normalizeEmail(emailInput);
    const user = email ? await get(this.db, 'SELECT * FROM users WHERE email = ?', [email]) : null;

    if (user?.email_verified) {
      const token = randomToken(40);
      await insert(
        this.db,
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES (?, ?, ?)`,
        [user.id, hashToken(token), toSqlDate(addMinutes(new Date(), this.env.PASSWORD_RESET_TTL_MINUTES))],
      );
      await this.emailService.sendPasswordResetEmail(serializeUser(user), token);
    }

    return { received: true };
  }

  async resetPassword(token, password, confirmation) {
    if (String(password || '') !== String(confirmation || '')) {
      throw new AppError('As senhas nao conferem.', 400, 'PASSWORD_CONFIRMATION_MISMATCH');
    }
    assertStrongPassword(password);

    const tokenRow = await get(
      this.db,
      `SELECT * FROM password_reset_tokens
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
       LIMIT 1`,
      [hashToken(token || ''), toSqlDate(new Date())],
    );
    if (!tokenRow) throw new AppError('Token de redefinicao invalido ou expirado.', 400, 'INVALID_RESET_TOKEN');

    const passwordHash = await bcrypt.hash(password, this.env.BCRYPT_ROUNDS);

    await withTransaction(this.db, async (tx) => {
      await run(tx, 'UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
        passwordHash,
        tokenRow.user_id,
      ]);
      await run(tx, 'UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?', [tokenRow.id]);
      await run(tx, 'UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL', [
        tokenRow.user_id,
      ]);
    });

    return { reset: true };
  }

  async sendVerification(user) {
    const token = randomToken(40);
    await insert(
      this.db,
      `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
       VALUES (?, ?, ?)`,
      [user.id, hashToken(token), toSqlDate(addHours(new Date(), this.env.EMAIL_VERIFICATION_TTL_HOURS))],
    );
    await this.emailService.sendVerificationEmail(user, token);
  }

  async getUserById(id) {
    const row = await get(this.db, 'SELECT * FROM users WHERE id = ?', [Number(id)]);
    if (!row) throw new AppError('Usuario nao encontrado.', 404, 'USER_NOT_FOUND');
    return serializeUser(row);
  }

  async listUsers() {
    const rows = await all(this.db, 'SELECT * FROM users ORDER BY id');
    return rows.map(serializeUser);
  }
}

module.exports = { AuthService };
