const assert = require('assert');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === './twitchAuth' || request.endsWith('/services/twitchAuth')) {
    return { getValidAccessToken: async () => 'token', refreshStoredToken: async () => ({ accessToken: 'token2' }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { parseTwitchClipUrl, getGameById, REQUIRED_CLIPS_SCOPE } = require('../services/twitchClips');
Module._load = originalLoad;

assert.strictEqual(REQUIRED_CLIPS_SCOPE, 'clips:edit');
assert.deepStrictEqual(parseTwitchClipUrl('https://clips.twitch.tv/FancySlug-123'), {
  clipId: 'FancySlug-123', url: 'https://clips.twitch.tv/FancySlug-123'
});
assert.deepStrictEqual(parseTwitchClipUrl('https://www.twitch.tv/generalqwert/clip/FancySlug-123?filter=clips'), {
  clipId: 'FancySlug-123', url: 'https://clips.twitch.tv/FancySlug-123'
});
assert.strictEqual(parseTwitchClipUrl('https://youtube.com/watch?v=abc'), null);
assert.strictEqual(parseTwitchClipUrl('FancySlug-123'), null);
assert.strictEqual(parseTwitchClipUrl('http://clips.twitch.tv/FancySlug-123'), null);
assert.strictEqual(parseTwitchClipUrl('https://clips.twitch.tv/FancySlug extra'), null);
console.log('PASS twitch clip URL validation');

(async () => {
  const originalFetch = global.fetch;
  const originalClientId = process.env.TWITCH_CLIENT_ID;
  process.env.TWITCH_CLIENT_ID = 'test-client';
  global.fetch = async (url) => {
    assert.ok(String(url).includes('/games?id=123'));
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: '123', name: 'Pokémon Emerald' }] })
    };
  };
  try {
    const game = await getGameById('123');
    assert.deepStrictEqual(game, { id: '123', name: 'Pokémon Emerald' });
    console.log('PASS Twitch game lookup for clip category validation');
  } finally {
    global.fetch = originalFetch;
    if (originalClientId == null) delete process.env.TWITCH_CLIENT_ID; else process.env.TWITCH_CLIENT_ID = originalClientId;
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
