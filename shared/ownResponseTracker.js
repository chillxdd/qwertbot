'use strict';

function createOwnResponseTracker({ ttlMs = 15000, now = () => Date.now() } = {}) {
  const entries = [];
  const ttl = Math.max(1000, Number(ttlMs) || 15000);

  function cleanup() {
    const cutoff = now() - ttl;
    while (entries.length && entries[0].createdAt < cutoff) entries.shift();
  }

  function note(message) {
    cleanup();
    entries.push({ message: String(message || '').trim(), createdAt: now() });
  }

  function consume(message) {
    cleanup();
    const normalized = String(message || '').trim();
    const index = entries.findIndex((entry) => entry.message === normalized);
    if (index === -1) return false;
    entries.splice(index, 1);
    return true;
  }

  return { note, consume, cleanup };
}

module.exports = { createOwnResponseTracker };
