function createMercadoPagoController(connectionService) {
  return {
    async connect(req, res) {
      const redirectUrl = await connectionService.buildConnectUrl(req.user.id);
      res.redirect(302, redirectUrl);
    },

    async callback(req, res) {
      await connectionService.handleCallback({
        code: req.query.code,
        state: req.query.state,
      });
      res.redirect('/mercado-pago?connected=1');
    },

    async status(req, res) {
      res.json({ mercado_pago: await connectionService.getStatus(req.user.id) });
    },

    async syncTerminals(req, res) {
      const terminals = await connectionService.syncTerminals(req.user.id);
      res.json({ terminals });
    },

    async setActiveTerminal(req, res) {
      const terminals = await connectionService.setActiveTerminal(
        req.user.id,
        req.body?.mercado_pago_terminal_id,
      );
      res.json({ terminals });
    },

    async disconnect(req, res) {
      res.json(await connectionService.disconnect(req.user.id));
    },
  };
}

module.exports = { createMercadoPagoController };
