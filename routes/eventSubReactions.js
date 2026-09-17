const { EVENT_TYPES, MAX_ACTIONS, MAX_HOLD_SECONDS, MAX_ACTION_DELAY_SECONDS, MAX_DISCORD_EMBED_FIELDS } = require('../services/eventSubReactions');

function registerEventSubReactionRoutes(app, { requireModSession, getDatabaseConnected, getEventSubReactionManager, getPersistentPinManager = null }) {
  const unavailable = (res) => res.status(503).json({ success: false, error: 'EventSub Reactions require MongoDB to be connected.' });

  app.post('/eventsub-reactions/list', requireModSession, async (req, res) => {
    const manager = getEventSubReactionManager();
    if (!getDatabaseConnected() || !manager) return unavailable(res);
    try {
      const reactions = await manager.listReactions();
      const persistentPinManager = typeof getPersistentPinManager === 'function' ? getPersistentPinManager() : null;
      const persistentPin = persistentPinManager?.getConfig?.() || null;
      return res.json({
        success: true,
        reactions,
        persistentPin,
        eventTypes: EVENT_TYPES,
        automationSpacingSeconds: Number(manager.getAutomationSpacingSeconds?.() || 0),
        discordWebhookStorage: manager.getDiscordSecretStatus?.() || { ready: false, preferredSource: null, usingFallback: false },
        limits: { maxActions: MAX_ACTIONS, maxHoldSeconds: MAX_HOLD_SECONDS, maxActionDelaySeconds: MAX_ACTION_DELAY_SECONDS, maxDiscordEmbedFields: MAX_DISCORD_EMBED_FIELDS }
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message || 'Could not load EventSub reactions.' });
    }
  });


  app.post('/eventsub-reactions/persistent-pin', requireModSession, async (req, res) => {
    if (!getDatabaseConnected()) return unavailable(res);
    const manager = typeof getPersistentPinManager === 'function' ? getPersistentPinManager() : null;
    if (!manager?.saveConfig) return res.status(503).json({ success: false, error: 'Rotating Pinned Banners are unavailable.' });
    try { return res.json({ success: true, persistentPin: await manager.saveConfig(req.body || {}) }); }
    catch (err) { return res.status(400).json({ success: false, error: err.message || 'Could not save Rotating Pinned Banners.' }); }
  });

  app.post('/eventsub-reactions/test-discord', requireModSession, async (req, res) => {
    const manager = getEventSubReactionManager();
    if (!getDatabaseConnected() || !manager) return unavailable(res);
    try {
      await manager.testDiscordNotification({
        webhookUrl: String(req.body?.webhookUrl || ''),
        webhookId: String(req.body?.webhookId || ''),
        content: String(req.body?.content || ''),
        discordEmbed: req.body?.discordEmbed || null,
        eventType: String(req.body?.eventType || '')
      });
      return res.json({ success: true });
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message || 'Could not send Discord webhook test.' });
    }
  });

  app.post('/eventsub-reactions/save', requireModSession, async (req, res) => {
    const manager = getEventSubReactionManager();
    if (!getDatabaseConnected() || !manager) return unavailable(res);
    try { return res.json({ success: true, reaction: await manager.saveReaction(req.body || {}) }); }
    catch (err) { return res.status(400).json({ success: false, error: err.message || 'Could not save EventSub reaction.' }); }
  });

  app.post('/eventsub-reactions/delete', requireModSession, async (req, res) => {
    const manager = getEventSubReactionManager();
    if (!getDatabaseConnected() || !manager) return unavailable(res);
    try { await manager.deleteReaction(String(req.body?.id || '')); return res.json({ success: true }); }
    catch (err) { return res.status(400).json({ success: false, error: err.message || 'Could not delete EventSub reaction.' }); }
  });

  app.post('/eventsub-reactions/toggle', requireModSession, async (req, res) => {
    const manager = getEventSubReactionManager();
    if (!getDatabaseConnected() || !manager) return unavailable(res);
    try { return res.json({ success: true, reaction: await manager.setEnabled(String(req.body?.id || ''), Boolean(req.body?.enabled)) }); }
    catch (err) { return res.status(400).json({ success: false, error: err.message || 'Could not update EventSub reaction.' }); }
  });
}

module.exports = { registerEventSubReactionRoutes };
