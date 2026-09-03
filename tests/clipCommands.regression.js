const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request.endsWith('/models/ClipCommandConfig') || request === '../models/ClipCommandConfig') {
    return {};
  }
  if (request === './twitchClips' || request.endsWith('/services/twitchClips')) {
    return {
      createClip: async () => ({}),
      getLiveStreamInfo: async () => ({}),
      validateClipForChannel: async () => ({})
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  parseClipArguments,
  isOfficialPokemonCategory,
  normalizeClipSettings,
  LAST_COMMAND_COOLDOWN_MS,
  CLIP_COMMAND_COOLDOWN_MS
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

const defaults = { defaultTitle: 'Default Title', defaultDuration: 45 };

test('plain command uses configured title and duration', () => {
  assert.deepStrictEqual(parseClipArguments('!clip', '!clip', defaults), {
    title: 'Default Title', duration: 45, usedDefaults: true
  });
});

test('title-only input preserves a leading number as part of title', () => {
  const result = parseClipArguments('!clip 30 seconds to mars lmao', '!clip', defaults);
  assert.strictEqual(result.title, '30 seconds to mars lmao');
  assert.strictEqual(result.duration, 45);
});

test('numeric duration with pipe is explicit', () => {
  const result = parseClipArguments('!clip 60 | big ending', '!clip', defaults);
  assert.strictEqual(result.title, 'big ending');
  assert.strictEqual(result.duration, 60);
});

test('numeric duration with s and pipe is explicit', () => {
  const result = parseClipArguments('!clip 60s | big ending', '!clip', defaults);
  assert.strictEqual(result.title, 'big ending');
  assert.strictEqual(result.duration, 60);
});

test('cliplast uses the same duration parser', () => {
  const result = parseClipArguments('!cliplast 25s | gym one disaster', '!cliplast', defaults);
  assert.strictEqual(result.title, 'gym one disaster');
  assert.strictEqual(result.duration, 25);
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
    clip: { defaultTitle: 'A', defaultDuration: 90 },
    cliplast: { defaultTitle: 'B', defaultDuration: 2 }
  });
  assert.strictEqual(normalized.clip.defaultDuration, 60);
  assert.strictEqual(normalized.cliplast.defaultDuration, 5);
});

test('cooldowns are 30s for last and 60s for clip', () => {
  assert.strictEqual(LAST_COMMAND_COOLDOWN_MS, 30000);
  assert.strictEqual(CLIP_COMMAND_COOLDOWN_MS, 60000);
});
