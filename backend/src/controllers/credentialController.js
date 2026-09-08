function createCredentialController(credentialService, terminalService) {
  return {
    status(req, res) {
      res.json({ credentials: credentialService.getStatus() });
    },

    save(req, res) {
      const credentials = credentialService.save(req.body);

      if (req.body?.terminal_id) {
        terminalService.setActiveTerminal(req.body.terminal_id);
      }

      res.json({ credentials, terminal: terminalService.getCurrentTerminal() });
    },
  };
}

module.exports = { createCredentialController };
