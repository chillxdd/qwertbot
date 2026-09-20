'use strict';

const MAX_ALIAS_LOOKUP_KEYS = 512;

function normalizeAliasRawKey(value) {
  return String(value || '')
    .replace(/^@+/, '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .slice(0, 160);
}

function normalizeAliasCanonicalKey(value) {
  return normalizeAliasRawKey(value)
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildProfileAliasKeys({ username = '', displayName = '', aliases = [] } = {}) {
  const keys = new Set();
  for (const value of [username, displayName, ...(Array.isArray(aliases) ? aliases : [])]) {
    const raw = normalizeAliasRawKey(value);
    const canonical = normalizeAliasCanonicalKey(value);
    if (raw) keys.add(raw);
    if (canonical) {
      keys.add(canonical);
      for (const token of canonical.split(' ')) {
        if (token) keys.add(token);
      }
    }
  }
  return [...keys].slice(0, 96);
}

function questionAliasKeys(question = '') {
  const text = String(question || '').normalize('NFKC').toLocaleLowerCase('en-US');
  const keys = new Set();
  const add = (value) => {
    if (keys.size >= MAX_ALIAS_LOOKUP_KEYS) return;
    const raw = normalizeAliasRawKey(value);
    if (raw) keys.add(raw);
  };

  // Any ordinary alias match necessarily contains at least one of its normalized
  // word tokens. Indexing/querying those anchors avoids generating every possible
  // multi-word phrase from the question while still retrieving the exact profile
  // for the existing boundary-aware matcher to confirm in Node.
  for (const match of text.matchAll(/[\p{L}\p{N}_]+/gu)) {
    add(match[0]);
    if (keys.size >= MAX_ALIAS_LOOKUP_KEYS) break;
  }

  // Preserve candidates for punctuation/symbol-heavy aliases as well. The final
  // profileMatchesQuestion() check remains authoritative, so these can only add
  // harmless false-positive candidates, never change a final match by themselves.
  if (keys.size < MAX_ALIAS_LOOKUP_KEYS) {
    for (const match of text.matchAll(/[^\p{L}\p{N}_\s]+/gu)) {
      const raw = String(match[0] || '');
      add(raw);
      add(raw.replace(/^[.,!?;:'"()\[\]{}<>]+|[.,!?;:'"()\[\]{}<>]+$/g, ''));
      for (const symbol of raw) {
        add(symbol);
        if (keys.size >= MAX_ALIAS_LOOKUP_KEYS) break;
      }
      if (keys.size >= MAX_ALIAS_LOOKUP_KEYS) break;
    }
  }

  return [...keys];
}

module.exports = {
  MAX_ALIAS_LOOKUP_KEYS,
  buildProfileAliasKeys,
  normalizeAliasRawKey,
  normalizeAliasCanonicalKey,
  questionAliasKeys
};
