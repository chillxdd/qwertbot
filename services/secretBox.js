'use strict';

const { createCipheriv, createDecipheriv, createHash, randomBytes } = require('node:crypto');

const VERSION = 'aes-256-gcm-v1';
const IV_BYTES = 12;
const CONTEXT_PREFIX = 'qwertbot:eventsub-discord-webhook:v1:';

function secretCandidates() {
  const candidates = [
    ['CONFIG_ENCRYPTION_KEY', process.env.CONFIG_ENCRYPTION_KEY],
    ['QWERT_OAUTH_LINK_SECRET', process.env.QWERT_OAUTH_LINK_SECRET],
    ['TWITCH_CLIENT_SECRET', process.env.TWITCH_CLIENT_SECRET]
  ];
  const seen = new Set();
  return candidates
    .map(([source, value]) => [source, String(value || '').trim()])
    .filter(([, value]) => value)
    .filter(([, value]) => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function deriveKey(secret) {
  return createHash('sha256')
    .update('qwertbot-config-secret-box\0', 'utf8')
    .update(String(secret), 'utf8')
    .digest();
}

function aadFor(contextId) {
  return Buffer.from(`${CONTEXT_PREFIX}${String(contextId || '').trim()}`, 'utf8');
}

function status() {
  const candidates = secretCandidates();
  return {
    ready: candidates.length > 0,
    preferredSource: candidates[0]?.[0] || null,
    usingFallback: Boolean(candidates.length && candidates[0][0] !== 'CONFIG_ENCRYPTION_KEY')
  };
}

function encrypt(value, contextId) {
  const plaintext = String(value || '');
  const candidates = secretCandidates();
  if (!candidates.length) {
    throw new Error('Discord webhook storage needs CONFIG_ENCRYPTION_KEY (preferred), QWERT_OAUTH_LINK_SECRET, or TWITCH_CLIENT_SECRET to be configured on the server.');
  }
  if (!plaintext) throw new Error('Cannot encrypt an empty secret.');
  const [source, rootSecret] = candidates[0];
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(rootSecret), iv);
  cipher.setAAD(aadFor(contextId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    version: VERSION,
    source,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64')
  };
}

function decrypt(box, contextId) {
  if (!box || String(box.version || '') !== VERSION) throw new Error('Unsupported encrypted webhook format.');
  const iv = Buffer.from(String(box.iv || ''), 'base64');
  const tag = Buffer.from(String(box.tag || ''), 'base64');
  const data = Buffer.from(String(box.data || ''), 'base64');
  if (iv.length !== IV_BYTES || tag.length !== 16 || !data.length) throw new Error('Stored Discord webhook secret is invalid.');
  const candidates = secretCandidates();
  if (!candidates.length) throw new Error('Discord webhook decryption key is not configured on the server.');

  const preferred = String(box.source || '');
  const ordered = [...candidates].sort((a, b) => Number(b[0] === preferred) - Number(a[0] === preferred));
  for (const [, rootSecret] of ordered) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', deriveKey(rootSecret), iv);
      decipher.setAAD(aadFor(contextId));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch (_) {
      // Try the next configured root secret. This permits adding
      // CONFIG_ENCRYPTION_KEY later without invalidating records encrypted
      // with QWERT_OAUTH_LINK_SECRET.
    }
  }
  throw new Error('Could not decrypt the stored Discord webhook. The encryption secret may have changed.');
}

module.exports = { encrypt, decrypt, status, VERSION };
