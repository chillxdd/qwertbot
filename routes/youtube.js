'use strict';

const path = require('node:path');
const YouTubeCustomCommand = require('../models/YouTubeCustomCommand');
const YouTubeCustomCommandSettings = require('../models/YouTubeCustomCommandSettings');
const YouTubeChatTimer = require('../models/YouTubeChatTimer');
const YouTubeConfig = require('../models/YouTubeConfig');
const YouTubeNativeCommandConfig = require('../models/YouTubeNativeCommandConfig');
const { normalizeCommandTrigger } = require('../features/youtube/pure');
const { DEFAULT_NATIVE_RESPONSE } = require('../services/youtubeCommands');

const MAX_MESSAGE_LENGTH = 200;
const TRIGGER_PATTERN = /^![a-z0-9][a-z0-9_-]{0,49}$/i;


function cleanCommandTriggers(values) {
  const raw = Array.isArray(values) ? values : [values];
  const seen = new Set();
  const triggers = [];
  for (const value of raw) {
    const trigger = normalizeCommandTrigger(value);
    if (!trigger) continue;
    if (!TRIGGER_PATTERN.test(trigger)) throw new Error('Each trigger must look like !command and use only letters, numbers, underscore, or hyphen.');
    if (trigger === '!commands') throw new Error('!commands is reserved as the built-in YouTube command list.');
    if (seen.has(trigger)) continue;
    seen.add(trigger);
    triggers.push(trigger);
  }
  if (!triggers.length) throw new Error('Add at least one YouTube command trigger.');
  if (triggers.length > 25) throw new Error('A YouTube custom command can have at most 25 triggers.');
  return triggers;
}

function cleanResponses(values) {
  const responses = (Array.isArray(values) ? values : []).map((value) => String(value || '').replace(/[\r\n]+/g, ' ').trim()).filter(Boolean);
  if (!responses.length || responses.length > 25) throw new Error('Provide between 1 and 25 responses.');
  if (responses.some((value) => value.length > MAX_MESSAGE_LENGTH)) throw new Error(`YouTube responses must be ${MAX_MESSAGE_LENGTH} characters or fewer.`);
  return responses;
}

function registerYouTubeRoutes(app, { requireModSession, getDatabaseConnected, youtubeManager, channelKey, viewsDir, getAdvancedFilterManager = null }) {
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
      const [commands, native, globalConfig] = await Promise.all([
        YouTubeCustomCommand.find({ channelKey, enabled: true }).sort({ normalizedTrigger: 1 }).select('name triggers normalizedTrigger trigger publicDescription cooldownSeconds userLevel probability').lean(),
        YouTubeNativeCommandConfig.findOne({ channelKey }).lean(),
        YouTubeConfig.findOne({ channelKey }).select('commandsEnabled').lean()
      ]);
      const commandsEngineEnabled = globalConfig?.commandsEnabled !== false;
      const customCommands = commands.map((command) => {
        const triggers = (Array.isArray(command.triggers) && command.triggers.length
          ? command.triggers
          : [command.normalizedTrigger || command.trigger])
          .map(normalizeCommandTrigger)
          .filter(Boolean)
          .map((trigger) => ({ triggerType: 'command', trigger }));
        return {
          id: String(command._id),
          name: command.name || triggers[0]?.trigger || 'Custom Command',
          publicDescription: command.publicDescription || '',
          triggers,
          cooldownSeconds: Number(command.cooldownSeconds || 0),
          userLevel: command.userLevel || 'everyone',
          probability: Number(command.probability ?? 100)
        };
      });
      const nativeCommands = !commandsEngineEnabled || native?.commandsEnabled === false ? [] : [{
        name: '!commands',
        userLevel: 'everyone',
        description: 'Links to this public SqwertArmyBot YouTube command directory.'
      }];
      // Keep the legacy flat shape available for any old cached page while the
      // standardized public directory uses the richer split collections.
      const effectiveCustomCommands = commandsEngineEnabled ? customCommands : [];
      const items = [
        ...nativeCommands.map((command) => ({ trigger: command.name, description: command.description })),
        ...effectiveCustomCommands.flatMap((command) => command.triggers.map((item) => ({ trigger: item.trigger, description: command.publicDescription })))
      ];
      return res.json({ success: true, commandsEngineEnabled, commands: items, customCommands: effectiveCustomCommands, nativeCommands });
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
      const triggers = cleanCommandTriggers(
        Array.isArray(req.body?.triggers) && req.body.triggers.length ? req.body.triggers : req.body?.trigger
      );
      const trigger = triggers[0];
      const existingId = req.body?.id ? String(req.body.id) : '';
      const conflictQuery = {
        channelKey,
        $or: [
          { normalizedTrigger: { $in: triggers } },
          { triggers: { $in: triggers } }
        ]
      };
      if (existingId) conflictQuery._id = { $ne: existingId };
      const conflicting = await YouTubeCustomCommand.findOne(conflictQuery).select('_id name normalizedTrigger trigger triggers').lean();
      if (conflicting) {
        const otherTriggers = new Set((Array.isArray(conflicting.triggers) && conflicting.triggers.length
          ? conflicting.triggers
          : [conflicting.normalizedTrigger || conflicting.trigger]).map(normalizeCommandTrigger));
        const duplicate = triggers.find((item) => otherTriggers.has(item)) || trigger;
        throw new Error(`${duplicate} is already used by another YouTube custom command.`);
      }
      const responses = cleanResponses(req.body?.responses);
      const responseMode = ['equal', 'weighted'].includes(req.body?.responseMode) ? req.body.responseMode : 'equal';
      const responseWeights = responseMode === 'weighted'
        ? responses.map((_, index) => Math.max(0, Number(req.body?.responseWeights?.[index] ?? 1)))
        : [];
      const update = {
        channelKey,
        name: String(req.body?.name || trigger).trim().slice(0, 80),
        publicDescription: String(req.body?.publicDescription || '').trim().slice(0, 300),
        triggers,
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
      const message = err?.code === 11000 ? 'One of those YouTube command triggers is already in use.' : (err.message || 'Could not save YouTube command.');
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
    try { return res.json({ success: true, timers: await youtubeManager.listTimers() }); }
    catch (err) { return res.status(500).json({ success: false, error: 'Could not load YouTube timers.' }); }
  });

  app.post('/youtube/timers/save', requireModSession, async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const responses = cleanResponses(req.body?.responses);
      const intervalSeconds = Number(req.body?.intervalSeconds ?? 900);
      if (!Number.isFinite(intervalSeconds) || intervalSeconds < 30 || intervalSeconds > 86400) throw new Error('Interval must be between 30 and 86400 seconds.');

      const config = await YouTubeConfig.findOne({ channelKey }).lean();
      const globalStartDelaySeconds = Math.max(0, Math.min(86400, Math.floor(Number(config?.globalTimerStartDelaySeconds || 0))));
      const rawStartDelay = req.body?.startDelaySeconds;
      let startDelaySeconds = null;
      if (rawStartDelay !== null && rawStartDelay !== undefined && String(rawStartDelay).trim() !== '') {
        startDelaySeconds = Math.floor(Number(rawStartDelay));
        if (!Number.isInteger(startDelaySeconds) || startDelaySeconds < globalStartDelaySeconds || startDelaySeconds > 86400) {
          throw new Error(`Start Delay must be blank or a whole number from the global delay (${globalStartDelaySeconds}s) through 86400s.`);
        }
      }

      const jitterSeconds = Math.floor(Number(req.body?.jitterSeconds ?? 0));
      if (!Number.isInteger(jitterSeconds) || jitterSeconds < 0 || jitterSeconds > 86400) throw new Error('Jitter must be between 0 and 86400 seconds.');
      const minimumChatMessages = Math.floor(Number(req.body?.minimumChatMessages ?? 0));
      if (!Number.isInteger(minimumChatMessages) || minimumChatMessages < 0 || minimumChatMessages > 100000) throw new Error('Min Messages must be between 0 and 100000.');
      const minimumViewers = Math.floor(Number(req.body?.minimumViewers ?? 0));
      if (!Number.isInteger(minimumViewers) || minimumViewers < 0 || minimumViewers > 1000000) throw new Error('Min Viewers must be between 0 and 1000000.');
      const advancedFilterId = String(req.body?.advancedFilterId || '').trim();
      if (advancedFilterId) {
        const manager = typeof getAdvancedFilterManager === 'function' ? getAdvancedFilterManager() : null;
        if (!manager?.getFilterById?.(advancedFilterId)) throw new Error('Selected Advanced Filter was not found. Refresh the filter list and choose another filter.');
      }
      const priority = ['high', 'normal', 'low'].includes(String(req.body?.priority || '').toLowerCase()) ? String(req.body.priority).toLowerCase() : 'normal';

      const responseMode = ['equal', 'weighted'].includes(req.body?.responseMode) ? req.body.responseMode : 'equal';
      const responseWeights = responseMode === 'weighted'
        ? responses.map((_, index) => {
          const value = Number(req.body?.responseWeights?.[index] ?? 1);
          if (!Number.isFinite(value) || value <= 0) throw new Error('Specified Weight values must be greater than 0.');
          return value;
        })
        : [];
      const name = String(req.body?.name || '').trim();
      if (!name) throw new Error('Timer Name is required.');
      if (name.length > 80) throw new Error('Timer Name can contain at most 80 characters.');
      const update = {
        channelKey,
        name,
        intervalSeconds,
        startDelaySeconds,
        jitterSeconds,
        priority,
        minimumChatMessages,
        minimumViewers,
        advancedFilterId,
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
      return res.json({
        success: true,
        config: { commandsEnabled: doc?.commandsEnabled !== false, commandsResponse: doc?.commandsResponse || DEFAULT_NATIVE_RESPONSE },
        defaults: { commandsEnabled: true, commandsResponse: DEFAULT_NATIVE_RESPONSE },
        maxLength: MAX_MESSAGE_LENGTH
      });
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
