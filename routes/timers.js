function registerTimerRoutes(app, { requireModSession, getDatabaseConnected, getChatTimerManager }) {
  function unavailable(res) {
    return res.status(503).json({ success: false, error: 'Timers require MongoDB to be connected.' });
  }

  app.post('/timers/list', requireModSession, async (req, res) => {
    const manager = getChatTimerManager();
    if (!getDatabaseConnected() || !manager) return unavailable(res);
    try {
      const timers = await manager.listTimers();
      return res.json({ success: true, timers });
    } catch (err) {
      console.error('[Timers] Could not list timers:', err.message || err);
      return res.status(500).json({ success: false, error: err.message || 'Could not load timers.' });
    }
  });

  app.post('/timers/save', requireModSession, async (req, res) => {
    const manager = getChatTimerManager();
    if (!getDatabaseConnected() || !manager) return unavailable(res);
    try {
      const timer = await manager.saveTimer(req.body || {});
      return res.json({ success: true, timer });
    } catch (err) {
      console.error('[Timers] Could not save timer:', err.message || err);
      return res.status(400).json({ success: false, error: err.message || 'Could not save timer.' });
    }
  });

  app.post('/timers/delete', requireModSession, async (req, res) => {
    const manager = getChatTimerManager();
    if (!getDatabaseConnected() || !manager) return unavailable(res);
    try {
      await manager.deleteTimer(String(req.body?.id || ''));
      return res.json({ success: true });
    } catch (err) {
      console.error('[Timers] Could not delete timer:', err.message || err);
      return res.status(400).json({ success: false, error: err.message || 'Could not delete timer.' });
    }
  });

  app.post('/timers/toggle', requireModSession, async (req, res) => {
    const manager = getChatTimerManager();
    if (!getDatabaseConnected() || !manager) return unavailable(res);
    try {
      const timer = await manager.setEnabled(String(req.body?.id || ''), Boolean(req.body?.enabled));
      return res.json({ success: true, timer });
    } catch (err) {
      console.error('[Timers] Could not toggle timer:', err.message || err);
      return res.status(400).json({ success: false, error: err.message || 'Could not update timer.' });
    }
  });
}

module.exports = { registerTimerRoutes };
