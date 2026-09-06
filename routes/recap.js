const { generateRecap, SUMMARY_PREFIX } = require('../commands/recap');
const { getStreamLore, buildEffectiveLore } = require('../services/streamLore');
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
      if (req.body.action === 'pause-generation' || req.body.action === 'stop') {
        result = await recapManager.pauseGeneration({ channel: channelName, displayName: 'WebUI MOD', announce: false });
      } else if (req.body.action === 'start') {
        result = await recapManager.startRecap({ channel: channelName, displayName: 'WebUI MOD', announce: false });
      } else if (req.body.action === 'stop-system') {
        result = await recapManager.stopRecapSystem({ displayName: 'WebUI MOD' });
      } else if (req.body.action === 'clear-window') {
        result = await recapManager.clearCurrentWindow({ displayName: 'WebUI MOD' });
      } else if (req.body.action === 'abort-clear') {
        result = await recapManager.abortAndClearRecap({ displayName: 'WebUI MOD' });
      } else {
        return res.status(400).json({ success: false, error: 'Invalid recap-control action.' });
      }
      return res.json(result);
    } catch (err) {
      console.error('[Recap] WebUI recap-control error:', err);
      return res.status(500).json({ success: false, error: err.message || 'Failed to change recap state. No durable success was confirmed.' });
    }
  });

  app.post('/test-summary', requireModSession, async (req, res) => {
    const recapManager = getRecapManager();
    if (!recapManager) return res.status(503).json({ success: false, error: 'Recap manager is not ready.' });
    try {
      const preview = await recapManager.runPreview(async () => {
        const logs = recapManager.getCurrentWindowLogs({ structured: true });
        const streamContexts = recapManager.getCurrentWindowContexts();
        const twitchEvents = recapManager.getCurrentWindowEvents();
        if (logs.length === 0 && twitchEvents.length === 0) {
          const err = new Error('There are currently no messages or Twitch events in the active automatic recap window.');
          err.status = 400; throw err;
        }
        const previousRecaps = await recapManager.getCurrentStreamRecapHistory(5);
        let streamLore = '';
        if (getDatabaseConnected()) {
          const loreRecord = await getStreamLore(channelName);
          const loreMatchSource = [...logs.map((record) => String(record.text || record.rawMessage || '')),
            ...twitchEvents.map((event) => String(event?.text || ''))].join('\n');
          streamLore = buildEffectiveLore(loreRecord?.manualEntries || [], loreRecord?.learnedObservations || [], loreMatchSource, { includeGlobal: true });
        }
        const recapStatus = recapManager.getStatus();
        const generatedAtMs = Date.now();
        const streamTiming = { startedAtMs: recapStatus.twitchStreamStartedAt || 0, generatedAtMs,
          uptimeMs: recapStatus.twitchStreamStartedAt ? Math.max(0, generatedAtMs - recapStatus.twitchStreamStartedAt) : null };
        const result = await generateRecap(logs, streamContexts, twitchEvents, previousRecaps, streamLore,
          streamTiming, channelName, process.env.TWITCH_BOT_USERNAME || '');
        const fullOutput = SUMMARY_PREFIX + result.summary;
        return { success: true, source: 'stored', messageCount: logs.length, totalValidMessages: logs.length,
          streamContextCount: streamContexts.length, twitchEventCount: twitchEvents.length,
          previousRecapContextCount: previousRecaps.length, streamLoreCharacterCount: streamLore.length,
          output: fullOutput, characterCount: fullOutput.length,
          sanitized: result.sanitization.sanitized, censoredCount: result.sanitization.censoredCount,
          affectedMessages: result.sanitization.affectedMessages };
      });
      return res.json(preview);
    } catch (err) {
      console.error('[Recap] Summary test error:', err.message);
      return res.status(err.cancelled ? 409 : err.status || 500).json({ success: false,
        error: { message: err.message, name: err.name, inputBlocked: err.inputBlocked || false, cancelled: Boolean(err.cancelled) } });
    }
  });

}

module.exports = { registerRecapRoutes };
