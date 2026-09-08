function createDashboardController(dashboardService) {
  return {
    show(req, res) {
      res.json({ dashboard: dashboardService.getDashboard() });
    },
  };
}

module.exports = { createDashboardController };
