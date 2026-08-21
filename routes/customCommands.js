function registerCustomCommandRoutes(app, { requireModSession, getDatabaseConnected, getCustomCommandManager }) {
  function unavailable(res) {
    return res.status(503).json({ success: false, error: 'Custom commands require MongoDB to be connected.' });
  }


  app.get('/public-commands', async (req, res) => {
    const manager = getCustomCommandManager();
    if (!getDatabaseConnected() || !manager) return res.json({ success: true, commands: [] });
    try {
      const commands = await manager.listCommands();
      const publicCommands = commands
        .filter((command) => command.enabled !== false && command.userLevel === 'everyone' && Number(command.probability) === 100)
        .map((command) => ({
          id: command.id,
          name: command.name,
          triggers: Array.isArray(command.triggers) ? command.triggers : [],
          cooldownSeconds: Number(command.cooldownSeconds || 0)
        }));
      return res.json({ success: true, commands: publicCommands });
    } catch (err) {
      console.error('[Custom Commands] Could not list public commands:', err.message || err);
      return res.status(500).json({ success: false, error: 'Could not load public commands.' });
    }
  });

  app.post('/custom-commands/list', requireModSession, async (req, res) => {
    const manager = getCustomCommandManager();
    if (!getDatabaseConnected() || !manager) return unavailable(res);
    try {
      const commands = await manager.listCommands();
      return res.json({ success: true, commands });
    } catch (err) {
      console.error('[Custom Commands] Could not list commands:', err.message || err);
      return res.status(500).json({ success: false, error: err.message || 'Could not load custom commands.' });
    }
  });



  app.post('/custom-commands/settings', requireModSession, async (req, res) => {
    const manager = getCustomCommandManager();
    if (!getDatabaseConnected() || !manager) return unavailable(res);
    try {
      const settings = await manager.getSettings();
      return res.json({ success: true, settings });
    } catch (err) {
      console.error('[Custom Commands] Could not load settings:', err.message || err);
      return res.status(500).json({ success: false, error: err.message || 'Could not load custom-command settings.' });
    }
  });

  app.post('/custom-commands/settings/save', requireModSession, async (req, res) => {
    const manager = getCustomCommandManager();
    if (!getDatabaseConnected() || !manager) return unavailable(res);
    try {
      const settings = await manager.saveSettings(req.body || {});
      return res.json({ success: true, settings });
    } catch (err) {
      console.error('[Custom Commands] Could not save settings:', err.message || err);
      return res.status(400).json({ success: false, error: err.message || 'Could not save custom-command settings.' });
    }
  });

  app.post('/custom-commands/save', requireModSession, async (req, res) => {
    const manager = getCustomCommandManager();
    if (!getDatabaseConnected() || !manager) return unavailable(res);
    try {
      const command = await manager.saveCommand(req.body || {});
      return res.json({ success: true, command });
    } catch (err) {
      console.error('[Custom Commands] Could not save command:', err.message || err);
      return res.status(400).json({ success: false, error: err.message || 'Could not save custom command.' });
    }
  });

  app.post('/custom-commands/delete', requireModSession, async (req, res) => {
    const manager = getCustomCommandManager();
    if (!getDatabaseConnected() || !manager) return unavailable(res);
    try {
      await manager.deleteCommand(String(req.body?.id || ''));
      return res.json({ success: true });
    } catch (err) {
      console.error('[Custom Commands] Could not delete command:', err.message || err);
      return res.status(400).json({ success: false, error: err.message || 'Could not delete custom command.' });
    }
  });

  app.post('/custom-commands/toggle', requireModSession, async (req, res) => {
    const manager = getCustomCommandManager();
    if (!getDatabaseConnected() || !manager) return unavailable(res);
    try {
      const command = await manager.setEnabled(String(req.body?.id || ''), Boolean(req.body?.enabled));
      return res.json({ success: true, command });
    } catch (err) {
      console.error('[Custom Commands] Could not toggle command:', err.message || err);
      return res.status(400).json({ success: false, error: err.message || 'Could not update custom command.' });
    }
  });

  app.post('/custom-commands/set-counter', requireModSession, async (req, res) => {
    const manager = getCustomCommandManager();
    if (!getDatabaseConnected() || !manager) return unavailable(res);
    try {
      const command = await manager.setCounter(String(req.body?.id || ''), req.body?.counter);
      return res.json({ success: true, command });
    } catch (err) {
      console.error('[Custom Commands] Could not set counter:', err.message || err);
      return res.status(400).json({ success: false, error: err.message || 'Could not set custom command counter.' });
    }
  });
}

module.exports = { registerCustomCommandRoutes };
