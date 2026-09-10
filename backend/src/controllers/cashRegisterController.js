function createCashRegisterController(cashRegisterService) {
  return {
    async current(req, res) {
      res.json({ cash_register: await cashRegisterService.ensureOpen(req.user?.id) });
    },

    async open(req, res) {
      const cashRegister = await cashRegisterService.open({
        ...(req.body || {}),
        user_id: req.user?.id,
        created_by: req.user?.id,
      });
      res.status(201).json({ cash_register: cashRegister });
    },

    async close(req, res) {
      const cashRegister = await cashRegisterService.close(req.params.id, req.user?.id);
      res.json({ cash_register: cashRegister });
    },

    async summary(req, res) {
      res.json({ summary: await cashRegisterService.getSummary(req.params.id, req.user?.id) });
    },
  };
}

module.exports = { createCashRegisterController };
