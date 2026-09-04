const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
let mockCreateClipCalls = 0;
let mockLiveInfoCalls = 0;
let mockGeminiPrompts = [];
let mockGeminiImpl = async () => 'Certified Gaming Moment';
let mockValidatedClipGameName = 'Pokémon Emerald';
const mockConfig = {
  clip: { defaultDuration: 45 },
  cliplast: { defaultDuration: 45 },
  lastClip: null
};
const mockClipCommandConfig = {
  findOne: () => ({ lean: async () => mockConfig }),
  findOneAndUpdate: async () => ({})
};
Module._load = function(request, parent, isMain) {
  if (request.endsWith('/models/ClipCommandConfig') || request === '../models/ClipCommandConfig') {
    return mockClipCommandConfig;
  }
  if (request === './twitchClips' || request.endsWith('/services/twitchClips')) {
    return {
      createClip: async () => {
        mockCreateClipCalls += 1;
        return { id: 'new-clip', url: 'https://clips.twitch.tv/NewClip', title: 'New Clip', duration: 45 };
      },
      getLiveStreamInfo: async () => {
        mockLiveInfoCalls += 1;
        return { live: true, gameName: 'Pokémon Emerald', startedAt: '2026-09-04T12:00:00.000Z' };
      },
      validateClipForChannel: async () => ({ id: 'set-clip', url: 'https://clips.twitch.tv/SetClip', title: 'Set Clip', duration: 45, gameId: '1', gameName: mockValidatedClipGameName })
    };
  }
  if (request === './geminiClient' || request.endsWith('/services/geminiClient')) {
    return {
      requestGeminiText: async (prompt, options) => {
        mockGeminiPrompts.push({ prompt, options });
        return mockGeminiImpl(prompt, options);
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  parseClipArguments,
  isOfficialPokemonCategory,
  normalizeClipSettings,
  LAST_COMMAND_COOLDOWN_MS,
  CLIP_COMMAND_COOLDOWN_MS,
  LAST_UPDATE_COOLDOWN_MS,
  AUTO_TITLE_TIMEOUT_MS,
  sanitizeGeneratedClipTitle,
  formatElapsedStreamTime,
  buildFallbackClipTitle,
  generateAutomaticClipTitle,
  createClipCommandManager
} = require('../services/clipCommands');
Module._load = originalLoad;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

const defaults = { defaultDuration: 45 };

test('plain command uses configured duration and requests an automatic title', () => {
  assert.deepStrictEqual(parseClipArguments('!clip', '!clip', defaults), {
    title: '', duration: 45, autoTitle: true, usedDefaults: true
  });
});

test('title-only input preserves a leading number as part of title', () => {
  const result = parseClipArguments('!clip 30 seconds to mars lmao', '!clip', defaults);
  assert.strictEqual(result.title, '30 seconds to mars lmao');
  assert.strictEqual(result.duration, 45);
  assert.strictEqual(result.autoTitle, false);
});

test('numeric duration with pipe is explicit', () => {
  const result = parseClipArguments('!clip 60 | big ending', '!clip', defaults);
  assert.strictEqual(result.title, 'big ending');
  assert.strictEqual(result.duration, 60);
  assert.strictEqual(result.autoTitle, false);
});

test('numeric duration with s and pipe is explicit', () => {
  const result = parseClipArguments('!clip 60s | big ending', '!clip', defaults);
  assert.strictEqual(result.title, 'big ending');
  assert.strictEqual(result.duration, 60);
  assert.strictEqual(result.autoTitle, false);
});

test('cliplast uses the same duration parser', () => {
  const result = parseClipArguments('!cliplast 25s | gym one disaster', '!cliplast', defaults);
  assert.strictEqual(result.title, 'gym one disaster');
  assert.strictEqual(result.duration, 25);
});

test('duration-only pipe requests an automatic title', () => {
  const result = parseClipArguments('!clip 60 |', '!clip', defaults);
  assert.strictEqual(result.title, '');
  assert.strictEqual(result.duration, 60);
  assert.strictEqual(result.autoTitle, true);
});

test('duration-only pipe accepts an s suffix', () => {
  const result = parseClipArguments('!cliplast 60s |', '!cliplast', defaults);
  assert.strictEqual(result.title, '');
  assert.strictEqual(result.duration, 60);
  assert.strictEqual(result.autoTitle, true);
});

test('duration below 5 is rejected', () => {
  assert.ok(parseClipArguments('!clip 4 | too short', '!clip', defaults).error);
});

test('duration above 60 is rejected', () => {
  assert.ok(parseClipArguments('!clip 61s | too long', '!clip', defaults).error);
});

test('official Pokemon category matches accent-insensitively', () => {
  assert.strictEqual(isOfficialPokemonCategory('Pokémon FireRed/LeafGreen'), true);
  assert.strictEqual(isOfficialPokemonCategory('Pokemon FireRed / LeafGreen'), true);
});

test('fan-game categories are excluded', () => {
  assert.strictEqual(isOfficialPokemonCategory('Pokémon Infinite Fusion'), false);
  assert.strictEqual(isOfficialPokemonCategory('PokéRogue'), false);
});

test('clip defaults clamp into Twitch duration range', () => {
  const normalized = normalizeClipSettings({
    clip: { defaultTitle: 'legacy ignored', defaultDuration: 90 },
    cliplast: { defaultTitle: 'legacy ignored', defaultDuration: 2 }
  });
  assert.strictEqual(normalized.clip.defaultDuration, 60);
  assert.strictEqual(normalized.cliplast.defaultDuration, 5);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(normalized.clip, 'defaultTitle'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(normalized.cliplast, 'defaultTitle'), false);
});

test('neutral clip-title sanitizer rejects obvious win/loss framing', () => {
  assert.strictEqual(sanitizeGeneratedClipTitle('Epic Victory Moment', 'clip'), '');
  assert.strictEqual(sanitizeGeneratedClipTitle('Certified Gaming Moment', 'clip'), 'Certified Gaming Moment');
});

test('stream timestamp fallback uses elapsed live time', () => {
  const now = Date.parse('2026-09-04T15:27:14.000Z');
  assert.strictEqual(formatElapsedStreamTime('2026-09-04T12:00:00.000Z', now), '03:27:14');
  const title = buildFallbackClipTitle('cliplast', { startedAt: '2026-09-04T12:00:00.000Z' }, now);
  assert.ok(/^Qwert Run Loss \d{2}\/\d{2}\/\d{2} 03:27:14$/.test(title));
});

test('automatic title timeout is fixed at three seconds', () => {
  assert.strictEqual(AUTO_TITLE_TIMEOUT_MS, 3000);
});

test('cooldowns are 30s for last, 60s for clip, and 60s for last updates', () => {
  assert.strictEqual(LAST_COMMAND_COOLDOWN_MS, 30000);
  assert.strictEqual(CLIP_COMMAND_COOLDOWN_MS, 60000);
  assert.strictEqual(LAST_UPDATE_COOLDOWN_MS, 60000);
});

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

(async () => {
  await asyncTest('blank !clip title uses the neutral Gemini rule with no chat context', async () => {
    mockGeminiPrompts = [];
    mockGeminiImpl = async () => 'Controller Activity Detected';
    const result = await generateAutomaticClipTitle('clip', { startedAt: '2026-09-04T12:00:00.000Z' });
    assert.strictEqual(result.title, 'Controller Activity Detected');
    assert.strictEqual(result.source, 'gemini');
    assert.strictEqual(mockGeminiPrompts.length, 1);
    assert.ok(/Neutral tone only/i.test(mockGeminiPrompts[0].prompt));
    assert.ok(!/recent chat|viewer|context:/i.test(mockGeminiPrompts[0].prompt));
  });

  await asyncTest('blank !cliplast title uses the generic run-loss Gemini rule', async () => {
    mockGeminiPrompts = [];
    mockGeminiImpl = async () => 'Another Run Goes Down';
    const result = await generateAutomaticClipTitle('cliplast', { startedAt: '2026-09-04T12:00:00.000Z' });
    assert.strictEqual(result.title, 'Another Run Goes Down');
    assert.strictEqual(result.source, 'gemini');
    assert.ok(/challenge run that was lost/i.test(mockGeminiPrompts[0].prompt));
    assert.ok(/Do not invent or mention specific games/i.test(mockGeminiPrompts[0].prompt));
  });

  await asyncTest('Gemini failure falls back to Qwert title plus stream timestamp', async () => {
    mockGeminiImpl = async () => { throw new Error('mock Gemini outage'); };
    const result = await generateAutomaticClipTitle('clip', { startedAt: '2026-09-04T12:00:00.000Z' }, Date.parse('2026-09-04T15:27:14.000Z'));
    assert.strictEqual(result.source, 'fallback');
    assert.ok(/^Qwert Clip \d{2}\/\d{2}\/\d{2} 03:27:14$/.test(result.title));
  });

  await asyncTest('missing stream timing after Gemini failure leaves title blank for Twitch fallback', async () => {
    mockGeminiImpl = async () => { throw new Error('mock Gemini outage'); };
    const result = await generateAutomaticClipTitle('cliplast', { startedAt: null });
    assert.deepStrictEqual(result, { title: '', source: 'twitch' });
  });

  await asyncTest('!clip explicitly checks live status before creating the clip', async () => {
    mockCreateClipCalls = 0;
    mockLiveInfoCalls = 0;
    mockGeminiImpl = async () => 'Controller Activity Detected';
    const manager = createClipCommandManager({
      channelName: 'generalqwert',
      sendMessage: async () => {},
      getNativeCommandResponse: async () => ''
    });
    const result = await manager.handleMessage({
      channel: '#generalqwert',
      rawMessage: '!clip explicit title',
      displayName: 'ModOne',
      tags: { username: 'modone', 'user-id': '1' },
      isModOrBroadcaster: true
    });
    assert.strictEqual(result.reason, 'success');
    assert.strictEqual(mockLiveInfoCalls, 1);
    assert.strictEqual(mockCreateClipCalls, 1);
  });

  await asyncTest('!setlast validates the saved clip category without requiring Qwert to be live', async () => {
    mockLiveInfoCalls = 0;
    mockValidatedClipGameName = 'Pokémon Emerald';
    const manager = createClipCommandManager({
      channelName: 'generalqwert',
      sendMessage: async () => {},
      getNativeCommandResponse: async () => ''
    });
    const result = await manager.handleMessage({
      channel: '#generalqwert',
      rawMessage: '!setlast https://clips.twitch.tv/SetClip',
      displayName: 'ModOne',
      tags: { username: 'modone', 'user-id': '1' },
      isModOrBroadcaster: true
    });
    assert.strictEqual(result.reason, 'success');
    assert.strictEqual(mockLiveInfoCalls, 0);
  });

  await asyncTest('!setlast rejects a Qwert clip from a non-approved category', async () => {
    mockValidatedClipGameName = 'PokéRogue';
    const manager = createClipCommandManager({
      channelName: 'generalqwert',
      sendMessage: async () => {},
      getNativeCommandResponse: async () => ''
    });
    const result = await manager.handleMessage({
      channel: '#generalqwert',
      rawMessage: '!setlast https://clips.twitch.tv/SetClip',
      displayName: 'ModOne',
      tags: { username: 'modone', 'user-id': '1' },
      isModOrBroadcaster: true
    });
    assert.strictEqual(result.reason, 'error');
    mockValidatedClipGameName = 'Pokémon Emerald';
  });

  await asyncTest('setlast and cliplast share one 60s cooldown across moderators', async () => {
    mockCreateClipCalls = 0;
    const sent = [];
    const manager = createClipCommandManager({
      channelName: 'generalqwert',
      sendMessage: async (_channel, message) => sent.push(message),
      getNativeCommandResponse: async (command, variant, variables = {}) => `${command}:${variant}:${variables.remaining || ''}`
    });

    const first = await manager.handleMessage({
      channel: '#generalqwert',
      rawMessage: '!setlast https://clips.twitch.tv/SetClip',
      displayName: 'ModOne',
      tags: { username: 'modone', 'user-id': '1' },
      isModOrBroadcaster: true
    });
    assert.strictEqual(first.reason, 'success');

    const second = await manager.handleMessage({
      channel: '#generalqwert',
      rawMessage: '!cliplast another ending',
      displayName: 'ModTwo',
      tags: { username: 'modtwo', 'user-id': '2' },
      isModOrBroadcaster: true
    });
    assert.strictEqual(second.reason, 'cooldown');
    assert.strictEqual(mockCreateClipCalls, 0);
    assert.ok(sent.some((message) => message.startsWith('cliplast:cooldown:')));
  });
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
