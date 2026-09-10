const { all, get, run } = require('../database/connection');
const { AppError } = require('../utils/errors');

class TerminalService {
  constructor(db, provider, env, connectionService = null) {
    this.db = db;
    this.provider = provider;
    this.env = env;
    this.connectionService = connectionService;
  }

  async getActiveTerminalId(userId = null) {
    if (userId && this.connectionService) {
      const status = await this.connectionService.getStatus(userId);
      return status.active_terminal?.mercado_pago_terminal_id || '';
    }

    const setting = await get(this.db, "SELECT value FROM app_settings WHERE key = 'mercadopago.active_terminal_id'");
    return setting?.value || this.env.MERCADO_PAGO_TERMINAL_ID || '';
  }

  async getCurrentTerminal(userId = null) {
    const activeTerminalId = await this.getActiveTerminalId(userId);
    if (userId && this.connectionService) {
      const status = await this.connectionService.getStatus(userId);
      return {
        provider: 'mercadopago',
        provider_terminal_id: activeTerminalId || null,
        configured: Boolean(activeTerminalId),
        source: status.connected ? 'oauth' : 'none',
        terminal: status.active_terminal || null,
      };
    }

    const terminal = activeTerminalId
      ? await get(
          this.db,
          'SELECT * FROM terminals WHERE provider = ? AND provider_terminal_id = ?',
          ['mercadopago', activeTerminalId],
        )
      : null;

    return {
      provider: 'mercadopago',
      provider_terminal_id: activeTerminalId || null,
      configured: Boolean(activeTerminalId),
      source: terminal ? 'database' : activeTerminalId ? 'env' : null,
      terminal: terminal || null,
    };
  }

  async setActiveTerminal(providerTerminalId, userId = null) {
    const normalized = String(providerTerminalId || '').trim();
    if (!normalized) {
      throw new AppError('Informe o ID da maquininha.', 400, 'TERMINAL_ID_REQUIRED');
    }

    if (userId && this.connectionService) {
      await this.connectionService.setActiveTerminal(userId, normalized);
      return this.getCurrentTerminal(userId);
    }

    await run(
      this.db,
      `INSERT INTO terminals (provider, provider_terminal_id, active)
       VALUES ('mercadopago', ?, TRUE)
       ON CONFLICT(provider, provider_terminal_id)
       DO UPDATE SET active = TRUE`,
      [normalized],
    );

    await run(
      this.db,
      `INSERT INTO app_settings (key, value)
       VALUES ('mercadopago.active_terminal_id', ?)
       ON CONFLICT(key)
       DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      [normalized],
    );

    return this.getCurrentTerminal(userId);
  }

  async syncTerminals(filters = {}, userId = null) {
    if (userId && this.connectionService) {
      return this.connectionService.syncTerminals(userId);
    }

    const response = await this.provider.listTerminals(filters);
    const terminals = response?.data?.terminals || response?.terminals || [];

    for (const terminal of terminals) {
      await run(
        this.db,
        `INSERT INTO terminals
         (provider, provider_terminal_id, pos_id, store_id, external_pos_id, operating_mode, last_synced_at)
         VALUES ('mercadopago', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(provider, provider_terminal_id)
         DO UPDATE SET
           pos_id = excluded.pos_id,
           store_id = excluded.store_id,
           external_pos_id = excluded.external_pos_id,
           operating_mode = excluded.operating_mode,
           last_synced_at = CURRENT_TIMESTAMP`,
        [
          terminal.id,
          terminal.pos_id || null,
          terminal.store_id || null,
          terminal.external_pos_id || null,
          terminal.operating_mode || null,
        ],
      );
    }

    return this.listLocalTerminals(userId);
  }

  async listLocalTerminals(userId = null) {
    if (userId && this.connectionService) return this.connectionService.listTerminals(userId);
    return all(this.db, 'SELECT * FROM terminals ORDER BY provider_terminal_id');
  }

  async setupMode(providerTerminalId, operatingMode, userId = null) {
    if (operatingMode !== 'PDV') {
      throw new AppError('Para integração automática, o modo deve ser PDV.', 400, 'INVALID_TERMINAL_MODE');
    }

    const accessToken = userId && this.connectionService ? await this.connectionService.getAccessTokenForUser(userId) : null;
    const response = await this.provider.setupTerminalMode(providerTerminalId, operatingMode, accessToken);
    await this.syncTerminals({}, userId);
    await this.setActiveTerminal(providerTerminalId, userId);
    return response;
  }
}

module.exports = { TerminalService };
