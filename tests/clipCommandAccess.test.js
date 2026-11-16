'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeTwitchUsername,
  normalizeClipLastAllowedUsernames,
  clipLastUsernameAllowed,
  MAX_CLIPLAST_ALLOWED_USERNAMES
} = require('../services/clipCommandAccess');

test('normalizes allowlisted Twitch usernames from WebUI text', () => {
  assert.equal(normalizeTwitchUsername('  @QwertFan_7 '), 'qwertfan_7');
  assert.deepEqual(
    normalizeClipLastAllowedUsernames('@Alice\nBOB, alice; charlie_3'),
    ['alice', 'bob', 'charlie_3']
  );
});

test('allowlist matching is case-insensitive and accepts an optional @ prefix', () => {
  assert.equal(clipLastUsernameAllowed('@ALICE', ['alice', 'bob']), true);
  assert.equal(clipLastUsernameAllowed('outsider', ['alice', 'bob']), false);
});

test('strict WebUI validation rejects malformed usernames', () => {
  assert.throws(
    () => normalizeClipLastAllowedUsernames('valid_user\nnot-valid!', { strict: true }),
    /Invalid Twitch username/
  );
});

test('strict WebUI validation enforces the configured user limit', () => {
  const value = Array.from({ length: MAX_CLIPLAST_ALLOWED_USERNAMES + 1 }, (_, index) => `viewer_${index}`);
  assert.throws(
    () => normalizeClipLastAllowedUsernames(value, { strict: true }),
    new RegExp(`at most ${MAX_CLIPLAST_ALLOWED_USERNAMES}`)
  );
});
