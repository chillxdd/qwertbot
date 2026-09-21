'use strict';

function registerYouTubeAuthRoutes(app, { requireModSession, getDatabaseConnected, youtubeManager, adminPath }) {
  app.get('/auth/youtube/start', requireModSession, async (req, res) => {
    if (!getDatabaseConnected()) return res.status(503).send('MongoDB is not connected.');
    try {
      return res.redirect(youtubeManager.authManager.createAuthorizationUrl());
    } catch (err) {
      console.error('[YouTube OAuth] Could not start authorization:', err.message || err);
      return res.status(500).send(err.message || 'Could not start YouTube authorization.');
    }
  });

  app.get('/auth/youtube/callback', async (req, res) => {
    if (!getDatabaseConnected()) return res.status(503).send('MongoDB is not connected.');
    if (req.query?.error) return res.status(400).send(`YouTube authorization was not completed: ${String(req.query.error)}`);
    try {
      await youtubeManager.authManager.exchangeCode({ code: req.query?.code, state: req.query?.state });
      await youtubeManager.onAuthChanged();
      return res.redirect(`${adminPath}?youtube_oauth=success`);
    } catch (err) {
      console.error('[YouTube OAuth] Callback failed:', err.message || err);
      return res.status(400).send(`YouTube authorization failed: ${err.message || err}`);
    }
  });

  app.post('/youtube/oauth/status', requireModSession, async (req, res) => {
    if (!getDatabaseConnected()) return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
    try { return res.json({ success: true, auth: await youtubeManager.authManager.getStatus() }); }
    catch (err) { return res.status(500).json({ success: false, error: err.message || 'Could not load YouTube OAuth status.' }); }
  });

  app.post('/youtube/oauth/disconnect', requireModSession, async (req, res) => {
    if (!getDatabaseConnected()) return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
    try {
      await youtubeManager.authManager.disconnect();
      await youtubeManager.onAuthChanged();
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message || 'Could not disconnect YouTube OAuth.' });
    }
  });
}

module.exports = { registerYouTubeAuthRoutes };
