function createTerminalController(terminalService) {
  return {
    current(req, res) {
      res.json({ terminal: terminalService.getCurrentTerminal() });
    },

    async list(req, res) {
      const shouldSync = req.query.sync === 'true';
      const terminals = shouldSync ? await terminalService.syncTerminals(req.query) : terminalService.listLocalTerminals();
      res.json({ terminals });
    },

    save(req, res) {
      const terminal = terminalService.setActiveTerminal(req.body.provider_terminal_id);
      res.status(201).json({ terminal });
    },

    async setupMode(req, res) {
      const result = await terminalService.setupMode(req.params.providerTerminalId, req.body.operating_mode);
      res.json({ result });
    },
  };
}

module.exports = { createTerminalController };
