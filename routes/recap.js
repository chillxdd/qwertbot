const { generateRecap, SUMMARY_PREFIX } = require('../commands/recap');
const { getStreamLore } = require('../services/streamLore');
const {
  MAX_PRIMARY_INSTRUCTIONS_LENGTH,
  MAX_EXPANSION_INSTRUCTIONS_LENGTH,
  getRecapPromptConfig,
  saveRecapPromptConfig
} = require('../services/recapPromptConfig');

function registerRecapRoutes(app, { requireModSession, getDatabaseConnected, getRecapManager, channelName }) {
  app.post('/recap-prompt/get', requireModSession, async (req, res) => {
    if (!getDatabaseConnected()) return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
    try {
      const promptConfig = await getRecapPromptConfig(channelName);
      return res.json({
        success: true,
        primaryInstructions: promptConfig.primaryInstructions,
        expansionInstructions: promptConfig.expansionInstructions,
        source: promptConfig.source,
        updatedAt: promptConfig.updatedAt,
        maxPrimaryLength: MAX_PRIMARY_INSTRUCTIONS_LENGTH,
        maxExpansionLength: MAX_EXPANSION_INSTRUCTIONS_LENGTH
      });
    } catch (err) {
      console.error('[Recap Prompt] Could not load prompt settings:', err.message || err);
      return res.status(500).json({ success: false, error: 'Could not load recap prompt settings.' });
    }
  });

  app.post('/recap-prompt/save', requireModSession, async (req, res) => {
    if (!getDatabaseConnected()) return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
    const primaryInstructions = typeof req.body.primaryInstructions === 'string' ? req.body.primaryInstructions : '';
    const expansionInstructions = typeof req.body.expansionInstructions === 'string' ? req.body.expansionInstructions : '';
    try {
      const promptConfig = await saveRecapPromptConfig({ channelName, primaryInstructions, expansionInstructions });
      console.log(`[Recap Prompt] Saved editable recap instructions to MongoDB (${promptConfig.primaryInstructions.length} primary chars, ${promptConfig.expansionInstructions.length} expansion chars).`);
      return res.json({
        success: true,
        primaryInstructions: promptConfig.primaryInstructions,
        expansionInstructions: promptConfig.expansionInstructions,
        source: promptConfig.source,
        updatedAt: promptConfig.updatedAt,
        maxPrimaryLength: MAX_PRIMARY_INSTRUCTIONS_LENGTH,
        maxExpansionLength: MAX_EXPANSION_INSTRUCTIONS_LENGTH
      });
    } catch (err) {
      console.error('[Recap Prompt] Could not save prompt settings:', err.message || err);
      return res.status(400).json({ success: false, error: err.message || 'Could not save recap prompt settings.' });
    }
  });

  app.post('/recap-control', requireModSession, async (req, res) => {
    const recapManager = getRecapManager();
    if (!recapManager) return res.status(503).json({ success: false, error: 'Recap manager is not ready.' });
    try {
      let result;
      if (req.body.action === 'stop') {
        result = await recapManager.stopRecap({ channel: channelName, displayName: 'WebUI MOD', announce: false });
      } else if (req.body.action === 'start') {
        result = await recapManager.startRecap({ channel: channelName, displayName: 'WebUI MOD', announce: false });
      } else {
        return res.status(400).json({ success: false, error: 'Invalid recap-control action.' });
      }
      return res.json(result);
    } catch (err) {
      console.error('[Recap] WebUI recap-control error:', err);
      return res.status(500).json({ success: false, error: 'Failed to change recap state.' });
    }
  });

  app.post('/test-summary', requireModSession, async (req, res) => {
    const recapManager = getRecapManager();
    if (!recapManager) return res.status(503).json({ success: false, error: 'Recap manager is not ready.' });

    const logs = recapManager.getCurrentWindowLogs();
    const streamContexts = recapManager.getCurrentWindowContexts();
    const twitchEvents = recapManager.getCurrentWindowEvents();
    let previousRecaps = [];
    let streamLore = '';

    try {
      previousRecaps = await recapManager.getCurrentStreamRecapHistory(5);
    } catch (historyErr) {
      console.error('[Recap] Could not load previous recap history for WebUI current-window test:', historyErr.message || historyErr);
    }

    try {
      if (getDatabaseConnected()) {
        const loreRecord = await getStreamLore(channelName);
        streamLore = String(loreRecord?.effectiveText || loreRecord?.text || '');
      }
    } catch (loreErr) {
      console.error('[Recap] Could not load stream-specific lore for WebUI current-window test:', loreErr.message || loreErr);
    }

    if (logs.length === 0 && twitchEvents.length === 0) {
      return res.status(400).json({ success: false, error: 'There are currently no messages or Twitch events in the active automatic recap window.' });
    }

    try {
      const recapStatus = recapManager.getStatus();
      const generatedAtMs = Date.now();
      const streamTiming = {
        startedAtMs: recapStatus.twitchStreamStartedAt || 0,
        generatedAtMs,
        uptimeMs: recapStatus.twitchStreamStartedAt ? Math.max(0, generatedAtMs - recapStatus.twitchStreamStartedAt) : null
      };
      const result = await generateRecap(logs, streamContexts, twitchEvents, previousRecaps, streamLore, streamTiming, channelName);
      const fullOutput = SUMMARY_PREFIX + result.summary;

      return res.json({
        success: true,
        source: 'stored',
        messageCount: logs.length,
        totalValidMessages: logs.length,
        streamContextCount: streamContexts.length,
        twitchEventCount: twitchEvents.length,
        previousRecapContextCount: previousRecaps.length,
        streamLoreCharacterCount: streamLore.length,
        output: fullOutput,
        characterCount: fullOutput.length,
        sanitized: result.sanitization.sanitized,
        censoredCount: result.sanitization.censoredCount,
        affectedMessages: result.sanitization.affectedMessages
      });
    } catch (err) {
      console.error('[Recap] Summary test error:', err);
      return res.status(500).json({
        success: false,
        error: { message: err.message, name: err.name, details: err.toString(), inputBlocked: err.inputBlocked || false }
      });
    }
  });
}

module.exports = { registerRecapRoutes };
