'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const storage = new AsyncLocalStorage();
let runtime = { isActive: () => true, assertOwned: async () => {}, getFence: () => 0, getSignal: () => null };

function cancelledError(message = 'Operation cancelled or superseded.') {
  const err = new Error(message);
  err.cancelled = true;
  err.retryable = false;
  err.deliveryState = 'NOT_SENT';
  return err;
}
function configureRuntime(value) { runtime = { ...runtime, ...value }; }
function current() { return storage.getStore() || {}; }
function isActive() { return runtime.isActive(); }
function throwIfCancelled(context = current()) {
  if (!runtime.isActive() || runtime.getSignal()?.aborted || context.signal?.aborted ||
      (context.fence != null && context.fence !== runtime.getFence()) ||
      (context.isCurrent && !context.isCurrent())) throw cancelledError();
}
async function assertOperation() {
  throwIfCancelled();
  await runtime.assertOwned();
  throwIfCancelled();
}
function runOperation(fn, options = {}) {
  const parent = current();
  const context = { ...parent, fence: parent.fence ?? runtime.getFence(), ...options };
  return storage.run(context, fn);
}
function detached(fn) {
  return storage.run({ fence: runtime.getFence() }, fn);
}
function withoutDeliveryScope(fn) { return runOperation(fn, { deliveryScope: null }); }
function withDeliveryScope(key, fn) { return runOperation(fn, { deliveryScope: { key, next: 0 } }); }
function nextDeliveryKey(suffix = 'message') {
  const scope = current().deliveryScope;
  return scope ? `${scope.key}:${suffix}:${scope.next++}` : null;
}
function signals() { return [current().signal, runtime.getSignal()].filter(Boolean); }
function fence() { return current().fence ?? runtime.getFence(); }
function sleep(ms, signal = current().signal) {
  throwIfCancelled();
  const parents = [...new Set([signal, ...signals()].filter(Boolean))];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, Math.max(0, Number(ms) || 0));
    function cleanup() { parents.forEach((parent) => parent.removeEventListener('abort', abort)); }
    function done() { cleanup(); resolve(); }
    function abort() { clearTimeout(timer); cleanup(); reject(cancelledError()); }
    parents.forEach((parent) => parent.addEventListener('abort', abort, { once: true }));
    if (parents.some((parent) => parent.aborted)) abort();
  }).then(() => { throwIfCancelled(); });
}

module.exports = { configureRuntime, current, isActive, assertOperation, throwIfCancelled, runOperation,
  detached, withoutDeliveryScope, withDeliveryScope, nextDeliveryKey, signals, fence, sleep, cancelledError };
