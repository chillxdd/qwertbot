'use strict';
const { createLease } = require('./lease');
// OAuth can be completed on the web/standby instance too, so this lock is
// independent of the scheduler's operation context.
async function withDistributedLock(key, fn, { waitMs = 25000, ttlMs = 60000 } = {}) {
  const lease = createLease({ key: `mutex:${key}`, ttlMs });
  const deadline = Date.now() + waitMs;
  while (!await lease.acquire()) {
    if (Date.now() >= deadline) throw new Error(`Another ${key} operation is still running; please try again.`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const interval = setInterval(() => { lease.renew().catch(() => {}); }, Math.floor(ttlMs / 3));
  try { return await fn(lease); }
  finally { clearInterval(interval); await lease.release().catch((err) => console.warn('[Lock] Release failed; lease will expire:', err.message)); }
}
module.exports = { withDistributedLock };
