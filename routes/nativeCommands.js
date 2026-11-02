const {
  DEFAULT_NATIVE_RESPONSES,
  MAX_RESPONSE_LENGTH,
  getNativeCommandResponses,
  saveNativeCommandResponses
} = require('../services/nativeCommandResponses');

function registerNativeCommandRoutes(app, { requireModSession, getDatabaseConnected, getClipCommandManager, channelName }) {
  app.post('/native-commands/responses/get', requireModSession, async (req, res) => {
    if (!getDatabaseConnected()) return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
    try {
      const responses = await getNativeCommandResponses(channelName);
      const clipState = typeof getClipCommandManager === 'function'
        ? await getClipCommandManager()?.getAdminState?.()
        : null;
      return res.json({
        success: true,
        responses,
        defaults: DEFAULT_NATIVE_RESPONSES,
        maxLength: MAX_RESPONSE_LENGTH,
        clipSettings: clipState?.settings || null,
        lastClip: clipState?.lastClip || null,
        lastText: clipState?.lastText || null,
        clipCooldowns: clipState?.cooldowns || null,
        approvedPokemonCategories: clipState?.approvedPokemonCategories || []
      });
    } catch (err) {
      console.error('[Native Commands] Could not load response settings:', err.message || err);
      return res.status(500).json({ success: false, error: 'Could not load native command responses.' });
    }
  });

  app.post('/native-commands/responses/save', requireModSession, async (req, res) => {
    if (!getDatabaseConnected()) return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
    try {
      const responses = await saveNativeCommandResponses(channelName, req.body?.responses || {});
      let clipSettings = null;
      if (req.body?.clipSettings && typeof getClipCommandManager === 'function') {
        clipSettings = await getClipCommandManager()?.saveSettings?.(req.body.clipSettings);
      }
      return res.json({ success: true, responses, clipSettings });
    } catch (err) {
      console.error('[Native Commands] Could not save response settings:', err.message || err);
      return res.status(400).json({ success: false, error: err.message || 'Could not save native command responses.' });
    }
  });

  app.post('/native-commands/last/manual', requireModSession, async (req, res) => {
    if (!getDatabaseConnected()) return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
    try {
      const manager = typeof getClipCommandManager === 'function' ? getClipCommandManager() : null;
      if (!manager?.saveManualLastText) {
        return res.status(503).json({ success: false, error: 'The !last manager is unavailable.' });
      }
      await manager.saveManualLastText(req.body?.message);
      const state = await manager.getAdminState();
      return res.json({
        success: true,
        lastClip: state?.lastClip || null,
        lastText: state?.lastText || null
      });
    } catch (err) {
      console.error('[Native Commands] Could not manually update !last:', err.message || err);
      return res.status(400).json({ success: false, error: err.message || 'Could not manually update !last.' });
    }
  });
}

module.exports = { registerNativeCommandRoutes };
