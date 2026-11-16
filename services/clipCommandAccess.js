'use strict';

const MAX_CLIPLAST_ALLOWED_USERNAMES = 100;
const TWITCH_USERNAME_RE = /^[a-z0-9_]{1,25}$/;

function normalizeTwitchUsername(value) {
  return String(value || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase();
}

function tokenizeAllowedUsernames(value) {
  if (Array.isArray(value)) return value.flatMap((item) => tokenizeAllowedUsernames(item));
  return String(value || '')
    .split(/[\s,;]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeClipLastAllowedUsernames(value, { strict = false } = {}) {
  const output = [];
  const seen = new Set();
  const invalid = [];

  for (const raw of tokenizeAllowedUsernames(value)) {
    const username = normalizeTwitchUsername(raw);
    if (!TWITCH_USERNAME_RE.test(username)) {
      if (strict) invalid.push(String(raw || '').trim());
      continue;
    }
    if (seen.has(username)) continue;
    seen.add(username);
    output.push(username);
  }

  if (invalid.length) {
    throw new Error(`Invalid Twitch username${invalid.length === 1 ? '' : 's'}: ${invalid.slice(0, 5).join(', ')}. Use letters, numbers, and underscores only.`);
  }
  if (output.length > MAX_CLIPLAST_ALLOWED_USERNAMES) {
    throw new Error(`You can allow at most ${MAX_CLIPLAST_ALLOWED_USERNAMES} usernames to use !cliplast.`);
  }

  return output;
}

function clipLastUsernameAllowed(username, allowedUsernames = []) {
  const normalized = normalizeTwitchUsername(username);
  if (!normalized) return false;
  return normalizeClipLastAllowedUsernames(allowedUsernames).includes(normalized);
}

module.exports = {
  MAX_CLIPLAST_ALLOWED_USERNAMES,
  TWITCH_USERNAME_RE,
  normalizeTwitchUsername,
  normalizeClipLastAllowedUsernames,
  clipLastUsernameAllowed
};
