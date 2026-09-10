function createTerminalController(terminalService) {
  return {
    async current(req, res) {
      res.json({ terminal: await terminalService.getCurrentTerminal(req.user?.id) });
    },

    async list(req, res) {
      const shouldSync = req.query.sync === 'true';
      const terminals = shouldSync
        ? await terminalService.syncTerminals(req.query, req.user?.id)
        : await terminalService.listLocalTerminals(req.user?.id);
      res.json({ terminals });
    },

    async save(req, res) {
      const terminal = await terminalService.setActiveTerminal(req.body.provider_terminal_id, req.user?.id);
      res.status(201).json({ terminal });
    },

    async setupMode(req, res) {
      const result = await terminalService.setupMode(
        req.params.providerTerminalId,
        req.body.operating_mode,
        req.user?.id,
      );
      res.json({ result });
    },
  };
}

module.exports = { createTerminalController };
