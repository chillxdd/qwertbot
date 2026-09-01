function registerTimerRoutes(app, { requireModSession, getDatabaseConnected, getChatTimerManager, getPersistentPinManager = null }) {
  function unavailable(res) {
    return res.status(503).json({ success: false, error: 'Timers require MongoDB to be connected.' });
  }

  function managerOrUnavailable(res) {
    const manager = getChatTimerManager();
    if (!getDatabaseConnected() || !manager) {
      unavailable(res);
      return null;
    }
    return manager;
  }

  app.post('/timers/list', requireModSession, async (req, res) => {
    const manager = managerOrUnavailable(res);
    if (!manager) return;
    try {
      const pinManager = typeof getPersistentPinManager === 'function' ? getPersistentPinManager() : null;
      const [timers, settings] = await Promise.all([manager.listTimers(), manager.getSettings()]);
      const persistentPin = pinManager?.getConfig?.() || null;
      return res.json({ success: true, timers, settings, persistentPin });
    } catch (err) {
      console.error('[Timers] Could not list timers:', err.message || err);
      return res.status(500).json({ success: false, error: err.message || 'Could not load timers.' });
    }
  });

  app.post('/timers/settings', requireModSession, async (req, res) => {
    const manager = managerOrUnavailable(res);
    if (!manager) return;
    try {
      const settings = await manager.saveSettings(req.body || {});
      return res.json({ success: true, settings });
    } catch (err) {
      console.error('[Timers] Could not save timer settings:', err.message || err);
      return res.status(400).json({ success: false, error: err.message || 'Could not save timer settings.' });
    }
  });

  app.post('/timers/save', requireModSession, async (req, res) => {
    const manager = managerOrUnavailable(res);
    if (!manager) return;
    try {
      const timer = await manager.saveTimer(req.body || {});
      return res.json({ success: true, timer });
    } catch (err) {
      console.error('[Timers] Could not save timer:', err.message || err);
      return res.status(400).json({ success: false, error: err.message || 'Could not save timer.' });
    }
  });

  app.post('/timers/delete', requireModSession, async (req, res) => {
    const manager = managerOrUnavailable(res);
    if (!manager) return;
    try {
      await manager.deleteTimer(String(req.body?.id || ''));
      return res.json({ success: true });
    } catch (err) {
      console.error('[Timers] Could not delete timer:', err.message || err);
      return res.status(400).json({ success: false, error: err.message || 'Could not delete timer.' });
    }
  });

  app.post('/timers/toggle', requireModSession, async (req, res) => {
    const manager = managerOrUnavailable(res);
    if (!manager) return;
    try {
      const timer = await manager.setEnabled(String(req.body?.id || ''), Boolean(req.body?.enabled));
      return res.json({ success: true, timer });
    } catch (err) {
      console.error('[Timers] Could not toggle timer:', err.message || err);
      return res.status(400).json({ success: false, error: err.message || 'Could not update timer.' });
    }
  });

  app.post('/timers/preview', requireModSession, async (req, res) => {
    const manager = managerOrUnavailable(res);
    if (!manager) return;
    try {
      const preview = await manager.previewTimer(String(req.body?.id || ''));
      return res.json({ success: true, preview });
    } catch (err) {
      console.error('[Timers] Could not preview timer:', err.message || err);
      return res.status(400).json({ success: false, error: err.message || 'Could not preview timer.' });
    }
  });

  app.post('/timers/test', requireModSession, async (req, res) => {
    const manager = managerOrUnavailable(res);
    if (!manager) return;
    try {
      const result = await manager.testTimer(String(req.body?.id || ''));
      return res.json({ success: true, result });
    } catch (err) {
      console.error('[Timers] Could not test timer:', err.message || err);
      return res.status(400).json({ success: false, error: err.message || 'Could not test timer.' });
    }
  });


  app.post('/timers/persistent-pin', requireModSession, async (req, res) => {
    if (!getDatabaseConnected()) return unavailable(res);
    const manager = typeof getPersistentPinManager === 'function' ? getPersistentPinManager() : null;
    if (!manager?.saveConfig) return res.status(503).json({ success: false, error: 'Persistent Stream Pin is unavailable.' });
    try {
      const persistentPin = await manager.saveConfig(req.body || {});
      return res.json({ success: true, persistentPin });
    } catch (err) {
      console.error('[Persistent Pin] Could not save settings:', err.message || err);
      return res.status(400).json({ success: false, error: err.message || 'Could not save Persistent Stream Pin settings.' });
    }
  });

  app.post('/timers/fire-now', requireModSession, async (req, res) => {
    const manager = managerOrUnavailable(res);
    if (!manager) return;
    try {
      const result = await manager.fireNow(String(req.body?.id || ''));
      return res.json({ success: true, result });
    } catch (err) {
      console.error('[Timers] Could not fire timer now:', err.message || err);
      return res.status(400).json({ success: false, error: err.message || 'Could not fire timer.' });
    }
  });
}

module.exports = { registerTimerRoutes };
