const crypto = require('node:crypto');
const { all, get, insert, run, withTransaction } = require('../database/connection');
const { decryptSecret, encryptSecret } = require('../utils/cryptoBox');
const { AppError } = require('../utils/errors');
const { addMinutes, hashToken, randomToken, toSqlDate } = require('../utils/security');

class MercadoPagoConnectionService {
  constructor(db, provider, env) {
    this.db = db;
    this.provider = provider;
    this.env = env;
  }

  async buildConnectUrl(userId) {
    this.assertOAuthConfigured();
    const state = randomToken(32);
    const codeVerifier = randomToken(48);
    const codeChallenge = createS256Challenge(codeVerifier);

    await insert(
      this.db,
      `INSERT INTO mercado_pago_oauth_states (user_id, state_hash, code_verifier, expires_at)
       VALUES (?, ?, ?, ?)`,
      [userId, hashToken(state), codeVerifier, toSqlDate(addMinutes(new Date(), 10))],
    );

    const url = new URL(this.env.MERCADO_PAGO_AUTH_URL);
    url.searchParams.set('client_id', this.env.MERCADO_PAGO_CLIENT_ID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('platform_id', 'mp');
    url.searchParams.set('state', state);
    url.searchParams.set('redirect_uri', this.env.MERCADO_PAGO_REDIRECT_URI);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  async handleCallback({ code, state }) {
    if (!code || !state) throw new AppError('Callback OAuth incompleto.', 400, 'OAUTH_CALLBACK_INVALID');
    this.assertOAuthConfigured();

    const stateRow = await get(
      this.db,
      `SELECT * FROM mercado_pago_oauth_states
       WHERE state_hash = ? AND used_at IS NULL AND expires_at > ?
       LIMIT 1`,
      [hashToken(state), toSqlDate(new Date())],
    );
    if (!stateRow) throw new AppError('State OAuth inválido ou expirado.', 400, 'OAUTH_STATE_INVALID');

    const tokenResponse = await this.provider.exchangeOAuthCode({
      code,
      redirectUri: this.env.MERCADO_PAGO_REDIRECT_URI,
      codeVerifier: stateRow.code_verifier,
      testToken: this.env.MERCADO_PAGO_OAUTH_TEST_TOKEN,
    });

    const expiresAt = tokenResponse.expires_in
      ? new Date(Date.now() + Number(tokenResponse.expires_in) * 1000)
      : null;

    await withTransaction(this.db, async (tx) => {
      await run(tx, 'UPDATE mercado_pago_oauth_states SET used_at = CURRENT_TIMESTAMP WHERE id = ?', [
        stateRow.id,
      ]);
      await run(
        tx,
        `INSERT INTO mercado_pago_connections
         (user_id, mercado_pago_user_id, access_token_encrypted, refresh_token_encrypted, token_expires_at, scope)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id)
         DO UPDATE SET
           mercado_pago_user_id = excluded.mercado_pago_user_id,
           access_token_encrypted = excluded.access_token_encrypted,
           refresh_token_encrypted = excluded.refresh_token_encrypted,
           token_expires_at = excluded.token_expires_at,
           scope = excluded.scope,
           updated_at = CURRENT_TIMESTAMP`,
        [
          stateRow.user_id,
          tokenResponse.user_id ? String(tokenResponse.user_id) : null,
          encryptSecret(tokenResponse.access_token, this.env),
          encryptSecret(tokenResponse.refresh_token, this.env),
          expiresAt ? toSqlDate(expiresAt) : null,
          tokenResponse.scope || null,
        ],
      );
    });

    return this.getStatus(stateRow.user_id);
  }

  async getConnection(userId) {
    const row = await get(this.db, 'SELECT * FROM mercado_pago_connections WHERE user_id = ?', [userId]);
    return row ? this.serializeConnection(row) : null;
  }

  async getConnectionByMercadoPagoUserId(mercadoPagoUserId) {
    if (!mercadoPagoUserId) return null;
    const row = await get(
      this.db,
      'SELECT * FROM mercado_pago_connections WHERE mercado_pago_user_id = ? ORDER BY id DESC LIMIT 1',
      [String(mercadoPagoUserId)],
    );
    return row ? this.serializeConnection(row) : null;
  }

  async getAccessTokenForUser(userId) {
    const row = await get(this.db, 'SELECT * FROM mercado_pago_connections WHERE user_id = ?', [userId]);
    if (!row) return this.env.MERCADO_PAGO_ACCESS_TOKEN || null;
    return this.getFreshAccessToken(row);
  }

  async getAccessTokenForMercadoPagoUser(mercadoPagoUserId) {
    const row = await get(
      this.db,
      'SELECT * FROM mercado_pago_connections WHERE mercado_pago_user_id = ? ORDER BY id DESC LIMIT 1',
      [String(mercadoPagoUserId || '')],
    );
    if (!row) return this.env.MERCADO_PAGO_ACCESS_TOKEN || null;
    return this.getFreshAccessToken(row);
  }

  async getFreshAccessToken(row) {
    const expiresAt = row.token_expires_at ? new Date(row.token_expires_at) : null;
    if (!expiresAt || expiresAt.getTime() > Date.now() + 10 * 60 * 1000) {
      return decryptSecret(row.access_token_encrypted, this.env);
    }

    const refreshToken = decryptSecret(row.refresh_token_encrypted, this.env);
    if (!refreshToken) return decryptSecret(row.access_token_encrypted, this.env);

    const refreshed = await this.provider.refreshOAuthToken(refreshToken);
    const nextExpiresAt = refreshed.expires_in
      ? new Date(Date.now() + Number(refreshed.expires_in) * 1000)
      : null;

    await run(
      this.db,
      `UPDATE mercado_pago_connections
       SET access_token_encrypted = ?,
           refresh_token_encrypted = COALESCE(?, refresh_token_encrypted),
           token_expires_at = ?,
           scope = COALESCE(?, scope),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        encryptSecret(refreshed.access_token, this.env),
        refreshed.refresh_token ? encryptSecret(refreshed.refresh_token, this.env) : null,
        nextExpiresAt ? toSqlDate(nextExpiresAt) : null,
        refreshed.scope || null,
        row.id,
      ],
    );

    return refreshed.access_token;
  }

  async syncTerminals(userId) {
    const accessToken = await this.getAccessTokenForUser(userId);
    if (!accessToken) throw new AppError('Conecte o Mercado Pago antes de sincronizar terminais.', 400, 'MERCADO_PAGO_NOT_CONNECTED');

    const response = await this.provider.listTerminals({ accessToken });
    const terminals = response?.data?.terminals || response?.terminals || [];

    for (const terminal of terminals) {
      await run(
        this.db,
        `INSERT INTO point_terminals
         (user_id, mercado_pago_terminal_id, pos_id, store_id, external_pos_id, operating_mode, nickname, raw_response, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, mercado_pago_terminal_id)
         DO UPDATE SET
           pos_id = excluded.pos_id,
           store_id = excluded.store_id,
           external_pos_id = excluded.external_pos_id,
           operating_mode = excluded.operating_mode,
           nickname = COALESCE(excluded.nickname, point_terminals.nickname),
           raw_response = excluded.raw_response,
           last_synced_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP`,
        [
          userId,
          terminal.id,
          terminal.pos_id || null,
          terminal.store_id || null,
          terminal.external_pos_id || null,
          terminal.operating_mode || null,
          terminal.nickname || terminal.name || null,
          JSON.stringify(terminal),
        ],
      );
    }

    return this.listTerminals(userId);
  }

  async listTerminals(userId) {
    return all(
      this.db,
      `SELECT * FROM point_terminals
       WHERE user_id = ?
       ORDER BY active DESC, nickname, mercado_pago_terminal_id`,
      [userId],
    );
  }

  async setActiveTerminal(userId, terminalId) {
    const normalized = String(terminalId || '').trim();
    if (!normalized) throw new AppError('Informe o ID da Point.', 400, 'TERMINAL_ID_REQUIRED');

    await run(this.db, 'UPDATE point_terminals SET active = FALSE WHERE user_id = ?', [userId]);
    await run(
      this.db,
      `INSERT INTO point_terminals (user_id, mercado_pago_terminal_id, active)
       VALUES (?, ?, TRUE)
       ON CONFLICT(user_id, mercado_pago_terminal_id)
       DO UPDATE SET active = TRUE, updated_at = CURRENT_TIMESTAMP`,
      [userId, normalized],
    );
    return this.listTerminals(userId);
  }

  async getStatus(userId) {
    const connection = await this.getConnection(userId);
    const terminals = await this.listTerminals(userId);
    const activeTerminal = terminals.find((terminal) => Boolean(terminal.active));
    return {
      connected: Boolean(connection),
      connection,
      terminals,
      active_terminal: activeTerminal || null,
      env_access_token_configured: Boolean(this.env.MERCADO_PAGO_ACCESS_TOKEN),
    };
  }

  async disconnect(userId) {
    await run(this.db, 'DELETE FROM mercado_pago_connections WHERE user_id = ?', [userId]);
    await run(this.db, 'UPDATE point_terminals SET active = FALSE WHERE user_id = ?', [userId]);
    return { disconnected: true };
  }

  serializeConnection(row) {
    return {
      id: row.id,
      user_id: row.user_id,
      mercado_pago_user_id: row.mercado_pago_user_id,
      token_expires_at: row.token_expires_at,
      scope: row.scope,
      connected_at: row.connected_at,
      updated_at: row.updated_at,
    };
  }

  assertOAuthConfigured() {
    if (!this.env.MERCADO_PAGO_CLIENT_ID || !this.env.MERCADO_PAGO_CLIENT_SECRET || !this.env.MERCADO_PAGO_REDIRECT_URI) {
      throw new AppError(
        'Configure MERCADO_PAGO_CLIENT_ID, MERCADO_PAGO_CLIENT_SECRET e MERCADO_PAGO_REDIRECT_URI.',
        500,
        'MERCADO_PAGO_OAUTH_NOT_CONFIGURED',
      );
    }
  }
}

function createS256Challenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

module.exports = { MercadoPagoConnectionService, createS256Challenge };
