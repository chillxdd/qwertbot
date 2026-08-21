const {
  DEFAULT_NATIVE_RESPONSES,
  MAX_RESPONSE_LENGTH,
  getNativeCommandResponses,
  saveNativeCommandResponses
} = require('../services/nativeCommandResponses');

function registerNativeCommandRoutes(app, { requireModSession, getDatabaseConnected, channelName }) {
  app.post('/native-commands/responses/get', requireModSession, async (req, res) => {
    if (!getDatabaseConnected()) return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
    try {
      const responses = await getNativeCommandResponses(channelName);
      return res.json({ success: true, responses, defaults: DEFAULT_NATIVE_RESPONSES, maxLength: MAX_RESPONSE_LENGTH });
    } catch (err) {
      console.error('[Native Commands] Could not load response settings:', err.message || err);
      return res.status(500).json({ success: false, error: 'Could not load native command responses.' });
    }
  });

  app.post('/native-commands/responses/save', requireModSession, async (req, res) => {
    if (!getDatabaseConnected()) return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
    try {
      const responses = await saveNativeCommandResponses(channelName, req.body?.responses || {});
      return res.json({ success: true, responses });
    } catch (err) {
      console.error('[Native Commands] Could not save response settings:', err.message || err);
      return res.status(400).json({ success: false, error: err.message || 'Could not save native command responses.' });
    }
  });
}

module.exports = { registerNativeCommandRoutes };
