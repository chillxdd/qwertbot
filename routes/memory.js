const { MAX_STREAM_LORE_LENGTH, getStreamLore, saveStreamLore, setLearnedObservationEnabled, deleteLearnedObservation } = require('../services/streamLore');
const { getViewerProfileSettings, saveViewerProfileSettings, listViewerProfiles, getViewerProfile, saveViewerProfile, setFactEnabled, deleteViewerFact, deleteViewerProfile } = require('../services/viewerProfiles');

function registerMemoryRoutes(app, { requireModSession, getDatabaseConnected, getBotPersonalityManager, getRecapManager, channelName }) {
  app.post('/stream-lore/get', requireModSession, async (req, res) => {
    if (!getDatabaseConnected()) {
      return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
    }
    try {
      const lore = await getStreamLore(channelName);
      return res.json({ success: true, text: lore.text, learnedObservations: lore.learnedObservations, updatedAt: lore.updatedAt, maxLength: MAX_STREAM_LORE_LENGTH });
    } catch (err) {
      console.error('[Memory] Could not load stream-specific lore:', err.message || err);
      return res.status(500).json({ success: false, error: 'Could not load stream-specific lore.' });
    }
  });

  app.post('/stream-lore/save', requireModSession, async (req, res) => {
    if (!getDatabaseConnected()) {
      return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
    }
    const text = typeof req.body.text === 'string' ? req.body.text : '';
    if (text.length > MAX_STREAM_LORE_LENGTH) {
      return res.status(400).json({ success: false, error: `Lore is too long. Maximum is ${MAX_STREAM_LORE_LENGTH} characters.` });
    }
    try {
      const lore = await saveStreamLore(channelName, text);
      console.log(`[Memory] Stream-specific lore saved to MongoDB (${lore.text.length} characters).`);
      return res.json({ success: true, text: lore.text, learnedObservations: lore.learnedObservations, updatedAt: lore.updatedAt, maxLength: MAX_STREAM_LORE_LENGTH });
    } catch (err) {
      console.error('[Memory] Could not save stream-specific lore:', err.message || err);
      return res.status(500).json({ success: false, error: err.message || 'Could not save stream-specific lore.' });
    }
  });

  app.post('/stream-lore/observation-toggle', requireModSession, async (req, res) => {
    if (!getDatabaseConnected()) return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
    try {
      const lore = await setLearnedObservationEnabled(channelName, req.body?.observationId, req.body?.enabled);
      return res.json({ success: true, learnedObservations: lore.learnedObservations, updatedAt: lore.updatedAt });
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message || 'Could not update learned stream lore.' });
    }
  });

  app.post('/stream-lore/observation-unlearn', requireModSession, async (req, res) => {
    if (!getDatabaseConnected()) return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
    try {
      const lore = await deleteLearnedObservation(channelName, req.body?.observationId);
      return res.json({ success: true, learnedObservations: lore.learnedObservations, updatedAt: lore.updatedAt });
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message || 'Could not unlearn stream lore observation.' });
    }
  });

  app.post('/bot-personality/get', requireModSession, async (req, res) => {
    const manager = getBotPersonalityManager();
    if (!getDatabaseConnected() || !manager) {
      return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
    }
    try {
      const config = await manager.loadConfig();
      return res.json({ success: true, ...config });
    } catch (err) {
      console.error('[Tagged Questions] Could not load settings:', err.message || err);
      return res.status(500).json({ success: false, error: 'Could not load bot personality settings.' });
    }
  });

  app.post('/bot-personality/save', requireModSession, async (req, res) => {
    const manager = getBotPersonalityManager();
    if (!getDatabaseConnected() || !manager) {
      return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
    }
    try {
      const config = await manager.saveConfig({
        name: req.body?.name,
        personality: req.body?.personality,
        audience: req.body?.audience,
        cooldownSeconds: req.body?.cooldownSeconds,
        modsBypassCooldown: req.body?.modsBypassCooldown,
        cooldownResponse: req.body?.cooldownResponse,
        aiRetry: req.body?.aiRetry,
        sessionMemory: req.body?.sessionMemory
      });
      console.log(`[Tagged Questions] Settings saved (name=${config.name || 'none'}, personality=${config.personality.length} characters, audience=${config.audience}, cooldown=${config.cooldownSeconds}s, modsBypass=${config.modsBypassCooldown}).`);
      return res.json({ success: true, ...config });
    } catch (err) {
      console.error('[Tagged Questions] Could not save settings:', err.message || err);
      return res.status(400).json({ success: false, error: err.message || 'Could not save bot personality settings.' });
    }
  });

  app.post('/session-memory/status', requireModSession, async (req, res) => {
    if (!getDatabaseConnected()) {
      return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
    }
    const manager = typeof getRecapManager === 'function' ? getRecapManager() : null;
    if (!manager?.getSessionMemoryStatus) {
      return res.json({ success: true, enabled: false, streamLive: false, blockCount: 0, detailedCharacters: 0, compactCharacters: 0, currentWindowMessages: 0 });
    }
    try {
      const status = await manager.getSessionMemoryStatus();
      return res.json({ success: true, ...status });
    } catch (err) {
      console.error('[Session Memory] Could not load status:', err.message || err);
      return res.status(500).json({ success: false, error: 'Could not load session memory status.' });
    }
  });

  app.post('/session-memory/clear', requireModSession, async (req, res) => {
    if (!getDatabaseConnected()) {
      return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
    }
    const manager = typeof getRecapManager === 'function' ? getRecapManager() : null;
    if (!manager?.clearCurrentSessionMemory) {
      return res.status(503).json({ success: false, error: 'Recap manager is not ready.' });
    }
    try {
      const result = await manager.clearCurrentSessionMemory();
      return res.status(result.success ? 200 : 409).json(result);
    } catch (err) {
      console.error('[Session Memory] Could not clear current stream memory:', err.message || err);
      return res.status(500).json({ success: false, error: 'Could not clear current stream session memory.' });
    }
  });
  app.post('/viewer-profiles/settings/get', requireModSession, async (req, res) => {
    if (!getDatabaseConnected()) return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
    try {
      const settings = await getViewerProfileSettings(channelName);
      return res.json({ success: true, settings });
    } catch (err) {
      console.error('[Viewer Profiles] Could not load settings:', err.message || err);
      return res.status(500).json({ success: false, error: 'Could not load viewer profile settings.' });
    }
  });

  app.post('/viewer-profiles/settings/save', requireModSession, async (req, res) => {
    if (!getDatabaseConnected()) return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
    try {
      const settings = await saveViewerProfileSettings(channelName, req.body || {});
      return res.json({ success: true, settings });
    } catch (err) {
      console.error('[Viewer Profiles] Could not save settings:', err.message || err);
      return res.status(400).json({ success: false, error: err.message || 'Could not save viewer profile settings.' });
    }
  });

  app.post('/viewer-profiles/list', requireModSession, async (req, res) => {
    if (!getDatabaseConnected()) return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
    try {
      const profiles = await listViewerProfiles(channelName);
      return res.json({ success: true, profiles });
    } catch (err) {
      console.error('[Viewer Profiles] Could not list profiles:', err.message || err);
      return res.status(500).json({ success: false, error: 'Could not load viewer profiles.' });
    }
  });

  app.post('/viewer-profiles/get', requireModSession, async (req, res) => {
    if (!getDatabaseConnected()) return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
    try {
      const profile = await getViewerProfile(channelName, req.body?.id || req.body?.username);
      if (!profile) return res.status(404).json({ success: false, error: 'Viewer profile not found.' });
      return res.json({ success: true, profile });
    } catch (err) {
      return res.status(500).json({ success: false, error: 'Could not load viewer profile.' });
    }
  });

  app.post('/viewer-profiles/save', requireModSession, async (req, res) => {
    if (!getDatabaseConnected()) return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
    try {
      const profile = await saveViewerProfile(channelName, req.body || {});
      return res.json({ success: true, profile });
    } catch (err) {
      console.error('[Viewer Profiles] Could not save profile:', err.message || err);
      return res.status(400).json({ success: false, error: err.message || 'Could not save viewer profile.' });
    }
  });

  app.post('/viewer-profiles/fact-toggle', requireModSession, async (req, res) => {
    if (!getDatabaseConnected()) return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
    try {
      const profile = await setFactEnabled(channelName, req.body?.profileId, req.body?.factId, req.body?.enabled);
      return res.json({ success: true, profile });
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message || 'Could not update viewer fact.' });
    }
  });

  app.post('/viewer-profiles/fact-unlearn', requireModSession, async (req, res) => {
    if (!getDatabaseConnected()) return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
    try {
      const profile = await deleteViewerFact(channelName, req.body?.profileId, req.body?.factId);
      return res.json({ success: true, profile });
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message || 'Could not unlearn viewer fact.' });
    }
  });

  app.post('/viewer-profiles/delete', requireModSession, async (req, res) => {
    if (!getDatabaseConnected()) return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
    try {
      const result = await deleteViewerProfile(channelName, req.body?.id);
      return res.json({ success: true, ...result });
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message || 'Could not delete viewer profile.' });
    }
  });

}

module.exports = { registerMemoryRoutes };
