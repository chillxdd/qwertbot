'use strict';

const path = require('node:path');
const YouTubeCustomCommand = require('../models/YouTubeCustomCommand');
const YouTubeCustomCommandSettings = require('../models/YouTubeCustomCommandSettings');
const YouTubeChatTimer = require('../models/YouTubeChatTimer');
const YouTubeNativeCommandConfig = require('../models/YouTubeNativeCommandConfig');
const { normalizeCommandTrigger } = require('../features/youtube/pure');
const { DEFAULT_NATIVE_RESPONSE } = require('../services/youtubeCommands');

const MAX_MESSAGE_LENGTH = 200;
const TRIGGER_PATTERN = /^![a-z0-9][a-z0-9_-]{0,49}$/i;

function cleanResponses(values) {
  const responses = (Array.isArray(values) ? values : []).map((value) => String(value || '').replace(/[\r\n]+/g, ' ').trim()).filter(Boolean);
  if (!responses.length || responses.length > 25) throw new Error('Provide between 1 and 25 responses.');
  if (responses.some((value) => value.length > MAX_MESSAGE_LENGTH)) throw new Error(`YouTube responses must be ${MAX_MESSAGE_LENGTH} characters or fewer.`);
  return responses;
}

function registerYouTubeRoutes(app, { requireModSession, getDatabaseConnected, youtubeManager, channelKey, viewsDir }) {
  const requireDb = (res) => {
    if (getDatabaseConnected()) return true;
    res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
    return false;
  };

  app.get('/ytcommands', (req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.sendFile(path.join(viewsDir, 'youtube-commands.html'));
  });

  // Legacy public URL retained for compatibility with previously posted links.
  app.get('/youtube-commands', (req, res) => res.redirect(302, '/ytcommands'));

  app.get('/youtube-public-commands', async (req, res) => {
    if (!getDatabaseConnected()) return res.status(503).json({ success: false, error: 'Commands are temporarily unavailable.' });
    try {
      const [commands, native] = await Promise.all([
        YouTubeCustomCommand.find({ channelKey, enabled: true }).sort({ normalizedTrigger: 1 }).select('normalizedTrigger publicDescription').lean(),
        YouTubeNativeCommandConfig.findOne({ channelKey }).lean()
      ]);
      const items = [];
      if (native?.commandsEnabled !== false) items.push({ trigger: '!commands', description: 'Show this YouTube command list.' });
      for (const command of commands) items.push({ trigger: command.normalizedTrigger, description: command.publicDescription || '' });
      return res.json({ success: true, commands: items });
    } catch (err) {
      return res.status(500).json({ success: false, error: 'Could not load YouTube commands.' });
    }
  });

  app.post('/youtube/admin/state', requireModSession, async (req, res) => {
    if (!requireDb(res)) return;
    try { return res.json({ success: true, ...(await youtubeManager.getAdminState()) }); }
    catch (err) { return res.status(500).json({ success: false, error: err.message || 'Could not load YouTube state.' }); }
  });

  app.post('/youtube/admin/config', requireModSession, async (req, res) => {
    if (!requireDb(res)) return;
    try { return res.json({ success: true, config: await youtubeManager.saveConfig(req.body || {}) }); }
    catch (err) { return res.status(400).json({ success: false, error: err.message || 'Could not save YouTube settings.' }); }
  });

  app.post('/youtube/admin/preflight', requireModSession, async (req, res) => {
    if (!requireDb(res)) return;
    try { return res.json({ success: true, preflight: await youtubeManager.runPreflight() }); }
    catch (err) { return res.status(500).json({ success: false, error: err.message || 'Could not run YouTube preflight.' }); }
  });

  app.post('/youtube/admin/rediscover', requireModSession, async (req, res) => {
    if (!requireDb(res)) return;
    try { return res.json({ success: true, discovery: await youtubeManager.rediscoverNow() }); }
    catch (err) { return res.status(400).json({ success: false, error: err.message || 'Could not discover YouTube live chats.' }); }
  });

  app.post('/youtube/custom-commands/list', requireModSession, async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const [commands, settings] = await Promise.all([
        YouTubeCustomCommand.find({ channelKey }).sort({ normalizedTrigger: 1 }).lean(),
        YouTubeCustomCommandSettings.findOne({ channelKey }).lean()
      ]);
      return res.json({ success: true, commands, settings: { globalCooldownSeconds: Number(settings?.globalCooldownSeconds ?? 5) } });
    } catch (err) { return res.status(500).json({ success: false, error: 'Could not load YouTube custom commands.' }); }
  });

  app.post('/youtube/custom-commands/settings', requireModSession, async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const globalCooldownSeconds = Math.max(0, Math.min(86400, Math.floor(Number(req.body?.globalCooldownSeconds ?? 5))));
      await YouTubeCustomCommandSettings.findOneAndUpdate({ channelKey }, { $set: { globalCooldownSeconds }, $setOnInsert: { channelKey } }, { upsert: true, setDefaultsOnInsert: true });
      await youtubeManager.reloadCommands();
      return res.json({ success: true, settings: { globalCooldownSeconds } });
    } catch (err) { return res.status(400).json({ success: false, error: err.message || 'Could not save YouTube command settings.' }); }
  });

  app.post('/youtube/custom-commands/save', requireModSession, async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const trigger = normalizeCommandTrigger(req.body?.trigger);
      if (!TRIGGER_PATTERN.test(trigger)) throw new Error('Trigger must look like !command and use only letters, numbers, underscore, or hyphen.');
      if (trigger === '!commands') throw new Error('!commands is reserved as the built-in YouTube command list.');
      const responses = cleanResponses(req.body?.responses);
      const responseMode = ['equal', 'weighted'].includes(req.body?.responseMode) ? req.body.responseMode : 'equal';
      const responseWeights = responseMode === 'weighted'
        ? responses.map((_, index) => Math.max(0, Number(req.body?.responseWeights?.[index] ?? 1)))
        : [];
      const update = {
        channelKey,
        name: String(req.body?.name || trigger).trim().slice(0, 80),
        publicDescription: String(req.body?.publicDescription || '').trim().slice(0, 300),
        trigger,
        normalizedTrigger: trigger,
        responses,
        responseMode,
        responseWeights,
        avoidImmediateRepeat: Boolean(req.body?.avoidImmediateRepeat),
        userLevel: ['everyone', 'member', 'moderator', 'owner'].includes(req.body?.userLevel) ? req.body.userLevel : 'everyone',
        probability: Math.max(0, Math.min(100, Number(req.body?.probability ?? 100))),
        cooldownSeconds: Math.max(0, Math.min(86400, Math.floor(Number(req.body?.cooldownSeconds ?? 5)))),
        responseDelaySeconds: Math.max(0, Math.min(30, Number(req.body?.responseDelaySeconds ?? 0))),
        enabled: req.body?.enabled !== false
      };
      let saved;
      if (req.body?.id) saved = await YouTubeCustomCommand.findOneAndUpdate({ _id: req.body.id, channelKey }, { $set: update }, { new: true, runValidators: true });
      else saved = await YouTubeCustomCommand.create(update);
      if (!saved) throw new Error('YouTube command not found.');
      await youtubeManager.reloadCommands();
      return res.json({ success: true, command: saved.toObject() });
    } catch (err) {
      const message = err?.code === 11000 ? 'That YouTube command trigger already exists.' : (err.message || 'Could not save YouTube command.');
      return res.status(400).json({ success: false, error: message });
    }
  });

  app.post('/youtube/custom-commands/delete', requireModSession, async (req, res) => {
    if (!requireDb(res)) return;
    try {
      await YouTubeCustomCommand.deleteOne({ _id: req.body?.id, channelKey });
      await youtubeManager.reloadCommands();
      return res.json({ success: true });
    } catch (err) { return res.status(400).json({ success: false, error: 'Could not delete YouTube command.' }); }
  });

  app.post('/youtube/timers/list', requireModSession, async (req, res) => {
    if (!requireDb(res)) return;
    try { return res.json({ success: true, timers: await YouTubeChatTimer.find({ channelKey }).sort({ name: 1 }).lean() }); }
    catch (err) { return res.status(500).json({ success: false, error: 'Could not load YouTube timers.' }); }
  });

  app.post('/youtube/timers/save', requireModSession, async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const responses = cleanResponses(req.body?.responses);
      const intervalSeconds = Math.max(600, Math.min(86400, Math.floor(Number(req.body?.intervalSeconds ?? 900))));
      const startDelaySeconds = Math.max(0, Math.min(86400, Math.floor(Number(req.body?.startDelaySeconds ?? intervalSeconds))));
      const responseMode = ['equal', 'weighted'].includes(req.body?.responseMode) ? req.body.responseMode : 'equal';
      const responseWeights = responseMode === 'weighted'
        ? responses.map((_, index) => Math.max(0, Number(req.body?.responseWeights?.[index] ?? 1)))
        : [];
      const update = {
        channelKey,
        name: String(req.body?.name || 'YouTube Timer').trim().slice(0, 80),
        intervalSeconds,
        startDelaySeconds,
        responses,
        responseMode,
        responseWeights,
        avoidImmediateRepeat: Boolean(req.body?.avoidImmediateRepeat),
        enabled: req.body?.enabled !== false
      };
      let saved;
      if (req.body?.id) saved = await YouTubeChatTimer.findOneAndUpdate({ _id: req.body.id, channelKey }, { $set: update }, { new: true, runValidators: true });
      else saved = await YouTubeChatTimer.create(update);
      if (!saved) throw new Error('YouTube timer not found.');
      await youtubeManager.reloadTimers();
      return res.json({ success: true, timer: saved.toObject() });
    } catch (err) { return res.status(400).json({ success: false, error: err.message || 'Could not save YouTube timer.' }); }
  });

  app.post('/youtube/timers/delete', requireModSession, async (req, res) => {
    if (!requireDb(res)) return;
    try {
      await YouTubeChatTimer.deleteOne({ _id: req.body?.id, channelKey });
      await youtubeManager.reloadTimers();
      return res.json({ success: true });
    } catch (err) { return res.status(400).json({ success: false, error: 'Could not delete YouTube timer.' }); }
  });

  app.post('/youtube/timers/fire', requireModSession, async (req, res) => {
    if (!requireDb(res)) return;
    try { return res.json({ success: true, result: await youtubeManager.fireTimerNow(req.body?.id) }); }
    catch (err) { return res.status(400).json({ success: false, error: err.message || 'Could not fire YouTube timer.' }); }
  });

  app.post('/youtube/native/get', requireModSession, async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const doc = await YouTubeNativeCommandConfig.findOne({ channelKey }).lean();
      return res.json({ success: true, config: { commandsEnabled: doc?.commandsEnabled !== false, commandsResponse: doc?.commandsResponse || DEFAULT_NATIVE_RESPONSE } });
    } catch (err) { return res.status(500).json({ success: false, error: 'Could not load YouTube native command.' }); }
  });

  app.post('/youtube/native/save', requireModSession, async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const commandsResponse = String(req.body?.commandsResponse || DEFAULT_NATIVE_RESPONSE).replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_MESSAGE_LENGTH);
      const commandsEnabled = req.body?.commandsEnabled !== false;
      await YouTubeNativeCommandConfig.findOneAndUpdate({ channelKey }, { $set: { commandsResponse, commandsEnabled }, $setOnInsert: { channelKey } }, { upsert: true, setDefaultsOnInsert: true });
      await youtubeManager.reloadCommands();
      return res.json({ success: true, config: { commandsEnabled, commandsResponse } });
    } catch (err) { return res.status(400).json({ success: false, error: err.message || 'Could not save YouTube native command.' }); }
  });
}

module.exports = { registerYouTubeRoutes, cleanResponses, TRIGGER_PATTERN };
