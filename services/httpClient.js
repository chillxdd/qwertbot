'use strict';
const context = require('./reliability/context');
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

// Buffer small REST responses while the abort timer is STILL armed. Callers can
// keep using response.json()/text(); a 200 header is not considered completion.
async function fetchWithTimeout(url, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = MAX_RESPONSE_BYTES,
    skipOperationGuard = false, ...fetchOptions } = options;
  const method = String(fetchOptions.method || 'GET').toUpperCase();
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const isTwitchSideEffect = mutating && String(url).startsWith('https://api.twitch.tv/');
  if (isTwitchSideEffect && !skipOperationGuard) await context.assertOperation();
  const controller = new AbortController();
  const parents = [...new Set([fetchOptions.signal, ...context.signals()].filter(Boolean))];
  let timedOut = false;
  const abort = () => controller.abort();
  parents.forEach((signal) => { if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); });
  const startedAt = Date.now();
  const limit = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, limit);
  let dispatched = false;
  let reader;
  try {
    if (controller.signal.aborted) throw context.cancelledError();
    dispatched = true;
    const response = await fetch(url, { ...fetchOptions, signal: controller.signal });
    const chunks = [];
    let bytes = 0;
    if (response.body) {
      reader = response.body.getReader();
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maxResponseBytes) {
          controller.abort();
          throw new Error(`HTTP response exceeded ${maxResponseBytes} bytes.`);
        }
        chunks.push(part.value);
      }
    }
    if (controller.signal.aborted) throw new Error('HTTP operation was aborted.');
    const body = bytes ? Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes) : null;
    return new Response([101, 204, 205, 304].includes(response.status) ? null : body, {
      status: response.status, statusText: response.statusText, headers: response.headers
    });
  } catch (cause) {
    const err = new Error(timedOut ? `HTTP ${method} timed out after ${limit}ms (including response body).` : (cause?.message || 'HTTP request failed.'), { cause });
    err.timedOut = timedOut;
    err.cancelled = !timedOut && parents.some((signal) => signal.aborted);
    err.elapsedMs = Date.now() - startedAt;
    // Once a POST was dispatched, losing its response cannot prove non-delivery.
    err.deliveryState = mutating && dispatched ? 'UNKNOWN' : 'NOT_SENT';
    err.retryable = !err.cancelled && !mutating;
    throw err;
  } finally {
    clearTimeout(timer);
    parents.forEach((signal) => signal.removeEventListener('abort', abort));
    if (reader) { try { reader.releaseLock(); } catch (_) {} }
  }
}
module.exports = { fetchWithTimeout, DEFAULT_TIMEOUT_MS };
