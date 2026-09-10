function createCredentialController(credentialService, terminalService) {
  return {
    status(req, res) {
      res.json({ credentials: credentialService.getStatus() });
    },

    async save(req, res) {
      const credentials = credentialService.save(req.body);

      if (req.body?.terminal_id) {
        await terminalService.setActiveTerminal(req.body.terminal_id, req.user?.id);
      }

      res.json({ credentials, terminal: await terminalService.getCurrentTerminal(req.user?.id) });
    },
  };
}

module.exports = { createCredentialController };
