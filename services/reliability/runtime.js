'use strict';
const { createLease } = require('./lease');
function createRuntime({ key, connect, initialize, activate, maintenance = async () => {},
  quiesce = () => {}, flush = async () => {}, disconnect = async () => {},
  isConnected = () => true, fatal = () => {}, leaseFactory = createLease } = {}) {
  let leader = false, ready = false, initialized = false, stopping = false;
  let polling = false, loop = null, renewal = null, stopPromise = null;
  let lastError = '', lastMaintenance = 0;
  const controller = new AbortController();
  const lease = leaseFactory({ key, ttlMs: 30000, onLost: () => {
    ready = false;
    fatal(new Error('Bot lease was lost. This process must stop before another can take over.'));
  } });
  function isActive() { return leader && !stopping && isConnected() && lease.isHeld(); }
  function status() {
    return { state: stopping ? 'STOPPING' : !isConnected() ? 'DATABASE_OFFLINE' :
      !leader ? 'STANDBY' : !ready ? 'STARTING' : 'ACTIVE',
      ready: ready && isActive(), databaseReady: initialized && isConnected(),
      instanceId: lease.owner, fence: lease.fence, lastError };
  }
  async function assertOwned() {
    if (!isActive()) throw Object.assign(new Error('Bot is in standby or stopping.'), { cancelled: true, retryable: false, deliveryState: 'NOT_SENT' });
    await lease.assertOwned();
  }
  async function tick() {
    if (polling || stopping) return;
    polling = true;
    try {
      if (!isConnected()) {
        if (leader) throw new Error('MongoDB disconnected while this instance owned the bot lease.');
        await connect(); initialized = false;
      }
      if (!initialized) { await initialize(); initialized = true; }
      if (!leader) {
        if (!await lease.acquire()) return;
        leader = true;
        renewal = setInterval(() => {
          lease.renew().catch((err) => fatal(err));
        }, 8000);
        await activate();
        if (!isActive()) throw new Error('Bot lease expired during activation.');
        ready = true; lastError = '';
        console.log(`[Runtime] Active bot instance ${lease.owner}; lease fence ${lease.fence}.`);
      }
      if (ready && Date.now() - lastMaintenance >= 30000) {
        lastMaintenance = Date.now();
        await maintenance();
      }
    } catch (err) {
      lastError = String(err?.message || err);
      console.error('[Runtime]', lastError);
      if (leader) fatal(err);
    } finally { polling = false; }
  }
  function start() {
    if (loop || stopping) return;
    loop = setInterval(() => { void tick(); }, 2000);
    void tick();
  }
  function stop({ persist = true } = {}) {
    if (stopPromise) return stopPromise;
    stopping = true; ready = false;
    if (loop) clearInterval(loop); loop = null;
    try { quiesce(); } catch (err) { console.error('[Runtime] Quiesce failed:', err.message); }
    controller.abort();
    stopPromise = (async () => {
      try { await flush({ persist: persist && leader && lease.isHeld() && isConnected() }); }
      finally {
        if (renewal) clearInterval(renewal); renewal = null;
        // Never delete another owner's lease. A failed release expires naturally.
        if (leader && lease.isHeld()) await lease.release().catch((err) => console.error('[Runtime] Lease release failed:', err.message));
        leader = false;
        await disconnect();
      }
    })();
    return stopPromise;
  }
  return { start, tick, stop, status, isActive, assertOwned, canServeControls: () => ready && isActive(),
    getFence: () => lease.fence, getSignal: () => controller.signal };
}
module.exports = { createRuntime };
