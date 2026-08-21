const { MAX_AUTOMATION_SPACING_SECONDS } = require('../services/automationSpacing');

function registerAutomationRoutes(app, { requireModSession, getDatabaseConnected, getAutomationSpacingManager }) {
  function managerOrUnavailable(res) {
    const manager = getAutomationSpacingManager();
    if (!getDatabaseConnected() || !manager) {
      res.status(503).json({ success: false, error: 'Automation settings require MongoDB to be connected.' });
      return null;
    }
    return manager;
  }

  app.post('/automation/settings', requireModSession, async (req, res) => {
    const manager = managerOrUnavailable(res);
    if (!manager) return;
    try {
      return res.json({ success: true, settings: manager.getSettings(), limits: { maxSpacingSeconds: MAX_AUTOMATION_SPACING_SECONDS } });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message || 'Could not load automation settings.' });
    }
  });

  app.post('/automation/settings/save', requireModSession, async (req, res) => {
    const manager = managerOrUnavailable(res);
    if (!manager) return;
    try {
      const settings = await manager.saveSettings(req.body || {});
      return res.json({ success: true, settings, limits: { maxSpacingSeconds: MAX_AUTOMATION_SPACING_SECONDS } });
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message || 'Could not save automation settings.' });
    }
  });
}

module.exports = { registerAutomationRoutes };
