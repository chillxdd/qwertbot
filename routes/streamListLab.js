'use strict';

const path = require('node:path');

function registerStreamListLabRoutes(app, { requireModSession, youtubeManager, viewsDir, adminPath }) {
  const lab = () => youtubeManager?.getStreamListLab?.();

  app.get(`${adminPath}/streamlist-lab`, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    return res.sendFile(path.join(viewsDir, 'streamlist-lab.html'));
  });

  app.post('/streamlist-lab/state', requireModSession, async (req, res) => {
    try { return res.json({ success: true, state: await lab().getState() }); }
    catch (err) { return res.status(500).json({ success: false, error: err?.message || 'Could not load StreamList Lab state.' }); }
  });

  app.post('/streamlist-lab/recheck', requireModSession, async (req, res) => {
    try { return res.json({ success: true, state: await lab().recheckEnvironment() }); }
    catch (err) { return res.status(500).json({ success: false, error: err?.message || 'Could not re-check StreamList Lab environment.' }); }
  });

  app.post('/streamlist-lab/start', requireModSession, async (req, res) => {
    try {
      const state = await lab().start({
        retryMinutes: req.body?.retryMinutes,
        nodeProbeEnabled: req.body?.nodeProbeEnabled !== false,
        pythonProbeEnabled: req.body?.pythonProbeEnabled !== false
      });
      return res.json({ success: true, state });
    } catch (err) {
      return res.status(400).json({ success: false, error: err?.message || 'Could not start StreamList Lab.' });
    }
  });

  app.post('/streamlist-lab/stop', requireModSession, async (req, res) => {
    try { return res.json({ success: true, state: await lab().stop('manual-stop') }); }
    catch (err) { return res.status(500).json({ success: false, error: err?.message || 'Could not stop StreamList Lab.' }); }
  });

  app.post('/streamlist-lab/clear-history', requireModSession, async (req, res) => {
    try { return res.json({ success: true, state: await lab().clearHistory() }); }
    catch (err) { return res.status(400).json({ success: false, error: err?.message || 'Could not clear StreamList Lab history.' }); }
  });
}

module.exports = { registerStreamListLabRoutes };
