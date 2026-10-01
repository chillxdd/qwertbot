const { MAX_ACTIVITY_TEXT_LENGTH } = require('../services/discordPresence');

function registerDiscordPresenceRoutes(app, { requireModSession, getDatabaseConnected, getDiscordPresenceManager, getDiscordBotService }) {
  function managerOrUnavailable(res) {
    const manager = getDiscordPresenceManager();
    if (!getDatabaseConnected() || !manager) {
      res.status(503).json({ success: false, error: 'Discord presence settings require MongoDB to be connected.' });
      return null;
    }
    return manager;
  }

  app.post('/discord/presence/settings', requireModSession, async (req, res) => {
    const manager = managerOrUnavailable(res);
    if (!manager) return;
    try {
      if (!manager.isInitialized?.()) await manager.initialize();
      return res.json({
        success: true,
        settings: manager.getSettings(),
        botStatus: getDiscordBotService()?.status?.() || {},
        limits: { maxActivityTextLength: MAX_ACTIVITY_TEXT_LENGTH }
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message || 'Could not load Discord presence settings.' });
    }
  });

  app.post('/discord/presence/settings/save', requireModSession, async (req, res) => {
    const manager = managerOrUnavailable(res);
    if (!manager) return;
    try {
      const settings = await manager.saveSettings(req.body || {});
      return res.json({
        success: true,
        settings,
        botStatus: getDiscordBotService()?.status?.() || {},
        limits: { maxActivityTextLength: MAX_ACTIVITY_TEXT_LENGTH }
      });
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message || 'Could not save Discord presence settings.' });
    }
  });
}

module.exports = { registerDiscordPresenceRoutes };
