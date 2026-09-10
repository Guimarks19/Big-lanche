function createDashboardController(dashboardService) {
  return {
    async show(req, res) {
      res.json({ dashboard: await dashboardService.getDashboard(req.user?.id) });
    },
  };
}

module.exports = { createDashboardController };
