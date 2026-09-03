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
}

module.exports = { registerNativeCommandRoutes };
