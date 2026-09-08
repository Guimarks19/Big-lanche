function createCashRegisterController(cashRegisterService) {
  return {
    current(req, res) {
      res.json({ cash_register: cashRegisterService.ensureOpen() });
    },

    open(req, res) {
      const cashRegister = cashRegisterService.open(req.body || {});
      res.status(201).json({ cash_register: cashRegister });
    },

    close(req, res) {
      const cashRegister = cashRegisterService.close(req.params.id);
      res.json({ cash_register: cashRegister });
    },

    summary(req, res) {
      res.json({ summary: cashRegisterService.getSummary(req.params.id) });
    },
  };
}

module.exports = { createCashRegisterController };
