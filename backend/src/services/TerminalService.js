const { all, get, run } = require('../database/connection');
const { AppError } = require('../utils/errors');

class TerminalService {
  constructor(db, provider, env) {
    this.db = db;
    this.provider = provider;
    this.env = env;
  }

  getActiveTerminalId() {
    const setting = get(this.db, "SELECT value FROM app_settings WHERE key = 'mercadopago.active_terminal_id'");
    return setting?.value || this.env.MERCADOPAGO_TERMINAL_ID || '';
  }

  getCurrentTerminal() {
    const activeTerminalId = this.getActiveTerminalId();
    const terminal = activeTerminalId
      ? get(
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

  setActiveTerminal(providerTerminalId) {
    const normalized = String(providerTerminalId || '').trim();
    if (!normalized) {
      throw new AppError('Informe o ID da maquininha.', 400, 'TERMINAL_ID_REQUIRED');
    }

    run(
      this.db,
      `INSERT INTO terminals (provider, provider_terminal_id, active)
       VALUES ('mercadopago', ?, 1)
       ON CONFLICT(provider, provider_terminal_id)
       DO UPDATE SET active = 1`,
      [normalized],
    );

    run(
      this.db,
      `INSERT INTO app_settings (key, value)
       VALUES ('mercadopago.active_terminal_id', ?)
       ON CONFLICT(key)
       DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      [normalized],
    );

    return this.getCurrentTerminal();
  }

  async syncTerminals(filters = {}) {
    const response = await this.provider.listTerminals(filters);
    const terminals = response?.data?.terminals || response?.terminals || [];

    for (const terminal of terminals) {
      run(
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

    return this.listLocalTerminals();
  }

  listLocalTerminals() {
    return all(this.db, 'SELECT * FROM terminals ORDER BY provider_terminal_id');
  }

  async setupMode(providerTerminalId, operatingMode) {
    if (operatingMode !== 'PDV') {
      throw new AppError('Para integracao automatica, o modo deve ser PDV.', 400, 'INVALID_TERMINAL_MODE');
    }

    const response = await this.provider.setupTerminalMode(providerTerminalId, operatingMode);
    await this.syncTerminals();
    this.setActiveTerminal(providerTerminalId);
    return response;
  }
}

module.exports = { TerminalService };
