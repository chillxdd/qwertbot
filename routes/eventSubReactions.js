const { EVENT_TYPES, MAX_ACTIONS, MAX_HOLD_SECONDS, MAX_ACTION_DELAY_SECONDS } = require('../services/eventSubReactions');

function registerEventSubReactionRoutes(app, { requireModSession, getDatabaseConnected, getEventSubReactionManager }) {
  const unavailable = (res) => res.status(503).json({ success: false, error: 'EventSub Reactions require MongoDB to be connected.' });

  app.post('/eventsub-reactions/list', requireModSession, async (req, res) => {
    const manager = getEventSubReactionManager();
    if (!getDatabaseConnected() || !manager) return unavailable(res);
    try {
      const reactions = await manager.listReactions();
      return res.json({ success: true, reactions, eventTypes: EVENT_TYPES, automationSpacingSeconds: Number(manager.getAutomationSpacingSeconds?.() || 0), limits: { maxActions: MAX_ACTIONS, maxHoldSeconds: MAX_HOLD_SECONDS, maxActionDelaySeconds: MAX_ACTION_DELAY_SECONDS } });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message || 'Could not load EventSub reactions.' });
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
