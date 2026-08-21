const crypto = require('crypto');

function timingSafeStringEqual(providedValue, expectedValue) {
  if (typeof providedValue !== 'string' || !expectedValue) return false;
  const provided = Buffer.from(providedValue);
  const expected = Buffer.from(expectedValue);
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

function createModSessionManager({
  password,
  cookieName = 'sqwert_mod_session',
  lifetimeMs = 12 * 60 * 60 * 1000,
  secureCookie = false
}) {
  const sessions = new Map();

  function parseCookies(req) {
    const header = String(req.headers.cookie || '');
    const cookies = {};
    for (const part of header.split(';')) {
      const index = part.indexOf('=');
      if (index <= 0) continue;
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (!key) continue;
      try { cookies[key] = decodeURIComponent(value); } catch (_) { cookies[key] = value; }
    }
    return cookies;
  }

  function cleanup() {
    const now = Date.now();
    for (const [token, session] of sessions.entries()) {
      if (!session || session.expiresAt <= now) sessions.delete(token);
    }
  }

  function isValidPassword(value) {
    return timingSafeStringEqual(value, password);
  }

  function createSession(res) {
    cleanup();
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + lifetimeMs;
    sessions.set(token, { expiresAt });

    const cookieParts = [
      `${cookieName}=${encodeURIComponent(token)}`,
      'HttpOnly',
      'SameSite=Strict',
      'Path=/',
      `Max-Age=${Math.floor(lifetimeMs / 1000)}`
    ];
    if (secureCookie) cookieParts.push('Secure');
    res.setHeader('Set-Cookie', cookieParts.join('; '));
    return token;
  }

  function hasValidSession(req) {
    cleanup();
    const token = parseCookies(req)[cookieName];
    if (!token) return false;
    const session = sessions.get(token);
    return Boolean(session && session.expiresAt > Date.now());
  }

  function clearSession(req, res) {
    const token = parseCookies(req)[cookieName];
    if (token) sessions.delete(token);
    const cookieParts = [
      `${cookieName}=`,
      'HttpOnly',
      'SameSite=Strict',
      'Path=/',
      'Max-Age=0'
    ];
    if (secureCookie) cookieParts.push('Secure');
    res.setHeader('Set-Cookie', cookieParts.join('; '));
  }

  function requireSession(req, res, next) {
    if (!hasValidSession(req)) {
      return res.status(401).json({ success: false, error: 'MOD session expired. Please log in again.' });
    }
    return next();
  }

  return {
    isValidPassword,
    createSession,
    clearSession,
    hasValidSession,
    requireSession
  };
}

module.exports = { createModSessionManager, timingSafeStringEqual };
