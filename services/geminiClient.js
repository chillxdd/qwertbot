const operationContext = require('./reliability/context');
const { fetchWithTimeout } = require('./httpClient');
const { createQueuePolicy } = require('./reliability/queuePolicy');
const chooseQueuedJob = createQueuePolicy();
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const GEMINI_MODEL = String(process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite').trim() || 'gemini-3.5-flash-lite';
const HARD_MAX_REQUESTS_PER_MINUTE = 12;
const REQUEST_RATE_WINDOW_MS = 60 * 1000;
const MIN_SAFE_REQUEST_START_SPACING_MS = Math.ceil(REQUEST_RATE_WINDOW_MS / HARD_MAX_REQUESTS_PER_MINUTE);
const DEFAULT_REQUEST_SPACING_MS = MIN_SAFE_REQUEST_START_SPACING_MS;
const MIN_REQUEST_SPACING_MS = MIN_SAFE_REQUEST_START_SPACING_MS;
const MAX_REQUEST_SPACING_MS = 30000;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_BACKGROUND_RETRIES = 1;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const REQUEST_LEDGER_RETENTION_MS = 10 * 60 * 1000;
const MAX_REQUEST_LEDGER_ENTRIES = 120;

const queues = {
  high: [],
  normal: [],
  low: []
};

let processing = false;
let activeJob = null;
let lastRequestStartedAt = 0;
let requestStartTimes = [];
let globalBackoffUntil = 0;
let requestLedger = [];
let requestLedgerSequence = 0;
let sharedRateGate = null;
function configureSharedRateGate(gate) { sharedRateGate = gate; }

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function getGeminiRequestSpacingMs() {
  return clampNumber(
    process.env.GEMINI_REQUEST_SPACING_MS,
    MIN_REQUEST_SPACING_MS,
    MAX_REQUEST_SPACING_MS,
    DEFAULT_REQUEST_SPACING_MS
  );
}

function pruneRequestStartTimes(now = Date.now()) {
  const cutoff = now - REQUEST_RATE_WINDOW_MS;
  requestStartTimes = requestStartTimes.filter((timestamp) => timestamp > cutoff);
}

function pruneRequestLedger(now = Date.now()) {
  const cutoff = now - REQUEST_LEDGER_RETENTION_MS;
  requestLedger = requestLedger.filter((entry) => entry.startedAt > cutoff).slice(-MAX_REQUEST_LEDGER_ENTRIES);
}

function recordRequestStart(job, startedAt = Date.now()) {
  pruneRequestLedger(startedAt);
  const entry = {
    id: ++requestLedgerSequence,
    startedAt,
    finishedAt: null,
    durationMs: null,
    label: String(job?.options?.label || 'gemini'),
    priority: String(job?.priority || normalizePriority(job?.options?.priority)),
    outcome: 'active',
    status: null
  };
  requestLedger.push(entry);
  if (requestLedger.length > MAX_REQUEST_LEDGER_ENTRIES) requestLedger = requestLedger.slice(-MAX_REQUEST_LEDGER_ENTRIES);
  return entry.id;
}

function recordRequestFinish(id, err = null) {
  const entry = requestLedger.find((item) => item.id === id);
  if (!entry) return;
  entry.finishedAt = Date.now();
  entry.durationMs = Math.max(0, entry.finishedAt - entry.startedAt);
  if (!err) { entry.outcome = 'ok'; entry.status = 200; return; }
  const status = Number(err?.status || 0);
  entry.status = status || null;
  entry.outcome = err?.cancelled ? 'cancelled' : err?.timedOut ? 'timeout' : status ? `http_${status}` : 'error';
}

function getRateLimitReadyAt(now = Date.now()) {
  pruneRequestStartTimes(now);
  const spacingReadyAt = lastRequestStartedAt
    ? lastRequestStartedAt + getGeminiRequestSpacingMs()
    : now;
  const windowReadyAt = requestStartTimes.length >= HARD_MAX_REQUESTS_PER_MINUTE
    ? requestStartTimes[requestStartTimes.length - HARD_MAX_REQUESTS_PER_MINUTE] + REQUEST_RATE_WINDOW_MS
    : now;
  return Math.max(now, spacingReadyAt, windowReadyAt, globalBackoffUntil || 0);
}

function getGeminiClientStatus() {
  const now = Date.now();
  pruneRequestStartTimes(now);
  pruneRequestLedger(now);
  const recentCutoff = now - REQUEST_RATE_WINDOW_MS;
  return {
    model: GEMINI_MODEL,
    requestSpacingMs: getGeminiRequestSpacingMs(),
    hardMaxRequestsPerMinute: HARD_MAX_REQUESTS_PER_MINUTE,
    requestsStartedLastMinute: requestStartTimes.length,
    nextRequestAllowedAt: getRateLimitReadyAt(now),
    globalBackoffUntil: globalBackoffUntil || null,
    queued: queues.high.length + queues.normal.length + queues.low.length,
    queueByPriority: {
      high: queues.high.length,
      normal: queues.normal.length,
      low: queues.low.length
    },
    processing: Boolean(processing),
    activeLabel: activeJob ? String(activeJob?.options?.label || 'gemini') : null,
    activePriority: activeJob ? String(activeJob?.priority || normalizePriority(activeJob?.options?.priority)) : null,
    recentRequests: requestLedger.filter((entry) => entry.startedAt > recentCutoff).map((entry) => ({ ...entry }))
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function normalizePriority(value) {
  if (value === 'high' || value === 'low') return value;
  return 'normal';
}

function buildGeminiRequestBody(prompt, { stream = false, googleSearch = false } = {}) {
  const body = { model: GEMINI_MODEL, input: prompt };
  if (stream) body.stream = true;
  if (googleSearch === true) body.tools = [{ type: 'google_search' }];
  return body;
}

function nextJob() {
  return chooseQueuedJob(queues);
}

function rejectJobsThatCannotStartBy(earliestStartAt) {
  for (const priority of ['high', 'normal', 'low']) {
    const keep = [];
    for (const job of queues[priority]) {
      const deadlineAt = Number(job?.options?.deadlineAt || 0);
      if (deadlineAt > 0 && earliestStartAt >= deadlineAt) {
        const err = new Error('Gemini request could not start before its deadline because the shared request queue is paced or backing off.');
        err.retryable = true;
        err.queueDeadline = true;
        job.reject(err);
      } else {
        keep.push(job);
      }
    }
    queues[priority] = keep;
  }
}

function parseRetryAfterMs(response, data) {
  const header = response?.headers?.get?.('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const timestamp = Date.parse(header);
    if (!Number.isNaN(timestamp)) return Math.max(0, timestamp - Date.now());
  }

  const details = Array.isArray(data?.error?.details) ? data.error.details : [];
  for (const detail of details) {
    const retryDelay = detail?.retryDelay || detail?.retry_delay;
    if (typeof retryDelay === 'string') {
      const match = retryDelay.match(/^([0-9]+(?:\.[0-9]+)?)s$/i);
      if (match) return Math.max(0, Math.round(Number(match[1]) * 1000));
    }
  }
  return 0;
}

function isRetryableGeminiError(err) {
  if (err?.cancelled || err?.retryable === false) return false;
  if (err?.timedOut === true && err?.retryable === false) return false;
  if (err?.retryable === true) return true;
  const status = Number(err?.status || 0);
  if (RETRYABLE_STATUSES.has(status)) return true;
  const message = String(err?.message || '').toLowerCase();
  return /high demand|temporar|rate limit|too many requests|timeout|timed out|service unavailable|network|fetch failed|connection reset|econnreset|eai_again/.test(message);
}

function extractGeminiText(data) {
  let text = '';
  if (Array.isArray(data?.steps)) {
    for (const step of data.steps) {
      if (step?.type !== 'model_output' || !Array.isArray(step.content)) continue;
      for (const item of step.content) {
        if (typeof item?.text === 'string') text += `${item.text} `;
      }
    }
  }
  if (!text && typeof data?.output_text === 'string') text = data.output_text;
  if (!text && typeof data?.outputText === 'string') text = data.outputText;
  if (!text && typeof data?.text === 'string') text = data.text;
  if (!text && Array.isArray(data?.outputs)) {
    for (const output of data.outputs) {
      if (typeof output?.text === 'string') text += `${output.text} `;
    }
  }
  return String(text || '').trim();
}

async function noteTemporaryFailure(err) {
  const status = Number(err?.status || 0);
  if (!isRetryableGeminiError(err)) return;

  let fallbackMs = 0;
  if (status === 429) fallbackMs = 5000;
  else if (status >= 500 || status === 408) fallbackMs = 3000;
  else fallbackMs = 2000;

  const delayMs = Math.max(fallbackMs, Number(err?.retryAfterMs || 0));
  if (delayMs > 0) {
    globalBackoffUntil = Math.max(globalBackoffUntil, Date.now() + delayMs);
    if (sharedRateGate) await sharedRateGate.backoff(delayMs);
  }
}

function buildGeminiHttpError(response, data) {
  const err = new Error(data?.error?.message || data?.message || `Gemini API returned HTTP ${response.status}`);
  err.status = response.status;
  err.retryable = RETRYABLE_STATUSES.has(response.status);
  err.retryAfterMs = parseRetryAfterMs(response, data);
  err.geminiData = data;
  return err;
}

function streamEventFailure(event) {
  const interaction = event?.interaction && typeof event.interaction === 'object' ? event.interaction : null;
  const status = String(interaction?.status || event?.status || '').trim().toLowerCase();
  const eventType = String(event?.event_type || '').trim().toLowerCase();
  const failed = eventType === 'error' || eventType === 'interaction.failed' || ['failed', 'cancelled', 'budget_exceeded'].includes(status);
  if (!failed) return null;
  const message = interaction?.error?.message || event?.error?.message || `Gemini interaction ended with status ${status || eventType || 'failed'}.`;
  const err = new Error(message);
  err.status = Number(interaction?.error?.code || event?.error?.code || 0) || undefined;
  err.retryable = err.status ? RETRYABLE_STATUSES.has(err.status) : false;
  return err;
}

async function performStreamingGeminiRequest(prompt, { timeoutMs, label, retryOnTimeout, cancelSignal = null, googleSearch = false }) {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY environment variable is not set.');

  const controller = new AbortController();
  let externallyCancelled = Boolean(cancelSignal?.aborted);
  const onExternalAbort = () => { externallyCancelled = true; controller.abort(); };
  if (cancelSignal && !cancelSignal.aborted) cancelSignal.addEventListener('abort', onExternalAbort, { once: true });
  if (externallyCancelled) controller.abort();
  const timeoutLimitMs = Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();
  let timeout = null;
  let lastActivityAt = startedAt;
  let timeoutPhase = 'waiting for response';
  const armTimeout = (phase = timeoutPhase) => {
    timeoutPhase = phase;
    lastActivityAt = Date.now();
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => controller.abort(), timeoutLimitMs);
  };
  armTimeout('waiting for response');
  const watchdog = setTimeout(() => { timeoutPhase = 'maximum stream duration (10 minutes)'; controller.abort(); }, 600000);
  let response;
  let reader;

  try {
    response = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Accept': 'text/event-stream',
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(buildGeminiRequestBody(prompt, { stream: true, googleSearch })),
      signal: controller.signal
    });

    if (!response.ok) {
      let data = null;
      try { data = await response.json(); } catch (_) {}
      throw buildGeminiHttpError(response, data);
    }

    // A 200 response only means the SSE connection opened. From here on,
    // timeoutMs is an inactivity timeout, not a hard cap on total generation
    // time. Healthy long recaps may legitimately stream for longer than the
    // timeout as long as Gemini keeps sending data.
    armTimeout('waiting for stream data');

    if (!response.body || typeof response.body.getReader !== 'function') {
      const err = new Error('Gemini streaming response did not include a readable body.');
      err.retryable = true;
      throw err;
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let outputText = '';
    let finalInteraction = null;
    let firstEventAt = 0;
    let completed = false;

    const processBlock = (block) => {
      const dataLines = String(block || '')
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart());
      if (!dataLines.length) return;
      const payload = dataLines.join('\n').trim();
      if (!payload) return;
      if (payload === '[DONE]') { completed = true; return; }

      let event;
      try {
        event = JSON.parse(payload);
      } catch (_) {
        return;
      }

      if (!firstEventAt) {
        firstEventAt = Date.now();
        const openMs = firstEventAt - startedAt;
        if (openMs >= 5000) console.info(`[Gemini] ${label} stream opened in ${(openMs / 1000).toFixed(1)}s.`);
      }

      if (['interaction.completed', 'interaction.complete'].includes(event?.event_type)) completed = true;
      const failure = streamEventFailure(event);
      if (failure) throw failure;

      // The current Interactions streaming schema can place the first text
      // fragment on the model_output step.start event, with later fragments in
      // step.delta events. Capture both so a short response is never mistaken
      // for an empty successful stream.
      if (event?.event_type === 'step.start' && event?.step?.type === 'model_output' && Array.isArray(event.step.content)) {
        for (const item of event.step.content) {
          if (item?.type === 'text' && typeof item.text === 'string') outputText += item.text;
        }
      }
      if (event?.event_type === 'step.delta' && event?.delta?.type === 'text' && typeof event.delta.text === 'string') {
        outputText += event.delta.text;
      }
      if (event?.interaction && typeof event.interaction === 'object') {
        finalInteraction = event.interaction;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armTimeout(firstEventAt ? 'waiting for next stream event' : 'waiting for first stream event');
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 2000000 || outputText.length > 2000000) throw new Error('Gemini stream exceeded the response-size safety limit.');

      while (true) {
        const match = buffer.match(/\r?\n\r?\n/);
        if (!match || match.index === undefined) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        processBlock(block);
      }
      if (completed) break;
    }

    buffer += decoder.decode();
    if (buffer.trim()) processBlock(buffer);
    if (!completed) { const err = new Error('Gemini stream ended before its completion event; partial text was discarded.'); err.retryable = true; throw err; }

    const data = finalInteraction && typeof finalInteraction === 'object'
      ? { ...finalInteraction }
      : {};
    if (outputText && !extractGeminiText(data)) data.output_text = outputText;
    if (!extractGeminiText(data)) {
      const err = new Error('Gemini stream completed without readable text.');
      err.retryable = true;
      throw err;
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= 10000) {
      console.info(`[Gemini] ${label} streamed completion in ${(elapsedMs / 1000).toFixed(1)}s.`);
    }
    return data;
  } catch (err) {
    if (externallyCancelled) {
      const wrapped = new Error('Gemini request cancelled by operator.');
      wrapped.cancelled = true;
      wrapped.retryable = false;
      wrapped.elapsedMs = Date.now() - startedAt;
      console.info(`[Gemini] ${label} cancelled by operator after ${(wrapped.elapsedMs / 1000).toFixed(1)}s.`);
      throw wrapped;
    }
    const timedOut = controller.signal.aborted;
    if (timedOut) {
      const idleMs = Date.now() - lastActivityAt;
      const wrapped = new Error(`Gemini streaming request timed out while ${timeoutPhase}.`);
      wrapped.timedOut = true;
      wrapped.retryable = retryOnTimeout !== false;
      wrapped.elapsedMs = Date.now() - startedAt;
      wrapped.idleMs = idleMs;
      wrapped.timeoutPhase = timeoutPhase;
      console.warn(`[Gemini] ${label} streaming request timed out after ${(idleMs / 1000).toFixed(1)}s of inactivity while ${timeoutPhase} (total ${(wrapped.elapsedMs / 1000).toFixed(1)}s)${retryOnTimeout === false ? '; timeout retries disabled' : ''}.`);
      await noteTemporaryFailure(wrapped);
      throw wrapped;
    }
    await noteTemporaryFailure(err);
    throw err;
  } finally {
    if (timeout) clearTimeout(timeout);
    clearTimeout(watchdog);
    if (reader) { try { await reader.cancel(); } catch (_) {} try { reader.releaseLock(); } catch (_) {} }
    if (cancelSignal) cancelSignal.removeEventListener('abort', onExternalAbort);
  }
}

async function performGeminiRequest(prompt, { timeoutMs = DEFAULT_TIMEOUT_MS, label = 'gemini', retryOnTimeout = true, stream = false, cancelSignal = null, googleSearch = false } = {}) {
  operationContext.throwIfCancelled();
  if (stream === true) return performStreamingGeminiRequest(prompt, { timeoutMs, label, retryOnTimeout, cancelSignal, googleSearch });
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY environment variable is not set.');
  const startedAt = Date.now();
  try {
    const response = await fetchWithTimeout(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(buildGeminiRequestBody(prompt, { googleSearch })),
      timeoutMs, signal: cancelSignal
    });
    let data;
    try { data = await response.json(); }
    catch (cause) {
      const err = new Error(`Gemini returned invalid JSON. HTTP ${response.status}`, { cause });
      err.status = response.status;
      err.retryable = response.status >= 500 || response.ok;
      throw err;
    }
    if (!response.ok) throw buildGeminiHttpError(response, data);
    operationContext.throwIfCancelled();
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= 10000) console.info(`[Gemini] ${label} completed in ${(elapsedMs / 1000).toFixed(1)}s.`);
    return data;
  } catch (err) {
    if (cancelSignal?.aborted || err?.cancelled) throw operationContext.cancelledError('Gemini request cancelled.');
    if (err.timedOut) {
      err.retryable = retryOnTimeout !== false;
      console.warn(`[Gemini] ${label} timed out after ${((Date.now() - startedAt) / 1000).toFixed(1)}s including the response body${retryOnTimeout === false ? '; timeout retries disabled' : ''}.`);
    } else if (err.retryable == null || err.deliveryState) err.retryable = true;
    await noteTemporaryFailure(err);
    throw err;
  }
}

function enqueueGeminiRequest(prompt, options = {}) {
  operationContext.throwIfCancelled();
  const priority = normalizePriority(options.priority);
  const context = operationContext.current();
  return new Promise((resolve, reject) => {
    if (queues.high.length + queues.normal.length + queues.low.length >= 128) {
      const err = new Error('Gemini queue is full; refusing more work until it drains.');
      err.retryable = false;
      return reject(err);
    }
    const cancelController = new AbortController();
    let deadlineTimer = null;
    const signals = [...new Set([options.cancelSignal, ...operationContext.signals()].filter(Boolean))];
    const cleanup = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      signals.forEach((signal) => signal.removeEventListener('abort', cancel));
    };
    const job = { prompt, options, priority, context, enqueuedAt: Date.now(), cancelController,
      resolve: (value) => { cleanup(); resolve(value); },
      reject: (err) => { cleanup(); reject(err); }
    };
    function remove() {
      const index = queues[priority].indexOf(job);
      if (index >= 0) queues[priority].splice(index, 1);
      return index >= 0;
    }
    function cancel() {
      cancelController.abort();
      if (remove()) job.reject(operationContext.cancelledError('Queued Gemini request cancelled.'));
    }
    if (signals.some((signal) => signal.aborted)) return job.reject(operationContext.cancelledError());
    const deadlineAt = Number(options.deadlineAt || 0);
    if (deadlineAt && deadlineAt <= Date.now()) {
      const err = new Error('Gemini queue-start deadline expired.'); err.queueDeadline = true; err.retryable = false;
      return job.reject(err);
    }
    queues[priority].push(job);
    signals.forEach((signal) => signal.addEventListener('abort', cancel, { once: true }));
    if (deadlineAt) deadlineTimer = setTimeout(() => {
      if (remove()) {
        const err = new Error('Gemini request expired while waiting in the shared queue.');
        err.queueDeadline = true; err.retryable = false; job.reject(err);
      }
    }, Math.max(1, deadlineAt - Date.now()));
    job.onStart = () => { if (deadlineTimer) clearTimeout(deadlineTimer); deadlineTimer = null; };
    processQueue().catch((err) => console.error('[Gemini Queue] Unexpected queue failure:', err?.message || err));
  });
}

async function processQueue() {
  if (processing) return;
  processing = true;

  try {
    while (queues.high.length || queues.normal.length || queues.low.length) {
      let readyAt = getRateLimitReadyAt();
      rejectJobsThatCannotStartBy(readyAt);
      if (!queues.high.length && !queues.normal.length && !queues.low.length) break;

      let waitMs = Math.max(0, readyAt - Date.now());
      if (waitMs > 0) { await sleep(Math.min(1000, waitMs)); continue; }

      // Recalculate after waking so timer jitter, backoff changes, and the
      // rolling 60-second window can never produce a burst over 12 RPM.
      readyAt = getRateLimitReadyAt();
      waitMs = Math.max(0, readyAt - Date.now());
      if (waitMs > 0) {
        await sleep(Math.min(1000, waitMs));
        continue;
      }

      // Select only after the pacing wait so a newly-arrived tagged question
      // can jump ahead of background learning that has not started yet.
      const job = nextJob();
      if (!job) continue;

      activeJob = job;
      try {
        job.onStart?.();
        const data = await operationContext.runOperation(async () => {
          operationContext.throwIfCancelled();
          await operationContext.assertOperation();
          if (sharedRateGate) await sharedRateGate.reserve({ spacingMs: getGeminiRequestSpacingMs(),
            deadlineAt: Math.min(...[job.options.deadlineAt, job.options.totalDeadlineAt].filter((v) => v > 0)) || 0,
            signal: job.cancelController.signal });
          if (job.cancelController.signal.aborted) throw operationContext.cancelledError();
          if (job.options.deadlineAt && Date.now() >= job.options.deadlineAt) {
            const err = new Error('Gemini queue-start deadline expired before dispatch.'); err.queueDeadline = true; err.retryable = false; throw err;
          }
          const totalRemaining = job.options.totalDeadlineAt ? job.options.totalDeadlineAt - Date.now() : Infinity;
          if (totalRemaining <= 0) throw operationContext.cancelledError('Gemini total retry deadline expired.');
          const startedAt = Date.now();
          pruneRequestStartTimes(startedAt); lastRequestStartedAt = startedAt; requestStartTimes.push(startedAt);
          const ledgerId = recordRequestStart(job, startedAt);
          try {
            const result = await performGeminiRequest(job.prompt, { ...job.options,
              timeoutMs: Math.min(Number(job.options.timeoutMs) || DEFAULT_TIMEOUT_MS, totalRemaining),
              cancelSignal: job.cancelController.signal });
            recordRequestFinish(ledgerId);
            return result;
          } catch (err) {
            recordRequestFinish(ledgerId, err);
            throw err;
          }
        }, job.context);
        job.resolve(data);
      } catch (err) {
        job.reject(err);
      } finally {
        if (activeJob === job) activeJob = null;
      }
    }
  } finally {
    processing = false;
    if (queues.high.length || queues.normal.length || queues.low.length) {
      processQueue().catch((err) => console.error('[Gemini Queue] Queue restart failure:', err?.message || err));
    }
  }
}


function cancelGeminiRequestsByLabelPrefix(prefix) {
  const wanted = String(prefix || '').trim();
  if (!wanted) return { activeCancelled: false, queuedCancelled: 0 };

  let queuedCancelled = 0;
  for (const priority of ['high', 'normal', 'low']) {
    const keep = [];
    for (const job of queues[priority]) {
      const label = String(job?.options?.label || '');
      if (label.startsWith(wanted)) {
        queuedCancelled += 1;
        job.cancelController.abort();
        const err = new Error('Gemini request cancelled by operator before it started.');
        err.cancelled = true;
        err.retryable = false;
        job.reject(err);
      } else {
        keep.push(job);
      }
    }
    queues[priority] = keep;
  }

  let activeCancelled = false;
  if (activeJob && String(activeJob?.options?.label || '').startsWith(wanted)) {
    activeCancelled = true;
    activeJob.cancelController.abort();
  }

  return { activeCancelled, queuedCancelled };
}

function cancelAllGeminiRequests() {
  for (const priority of ['high', 'normal', 'low']) {
    for (const job of queues[priority].splice(0)) {
      job.cancelController.abort(); job.reject(operationContext.cancelledError('Bot is stopping.'));
    }
  }
  activeJob?.cancelController.abort();
}

async function requestGeminiData(prompt, options = {}) {
  return enqueueGeminiRequest(prompt, options);
}

async function requestGeminiText(prompt, options = {}) {
  const data = await requestGeminiData(prompt, options);
  const text = extractGeminiText(data);
  if (!text) {
    const err = new Error('Gemini returned no readable text.');
    err.retryable = true;
    throw err;
  }
  return text;
}

async function requestGeminiDataWithRetry(prompt, options = {}) {
  const maxRetries = clampNumber(options.maxRetries, 0, 3, DEFAULT_BACKGROUND_RETRIES);
  const retryDelaysMs = Array.isArray(options.retryDelaysMs) && options.retryDelaysMs.length
    ? options.retryDelaysMs.map((value) => Math.max(0, Number(value) || 0))
    : [4000, 8000, 12000];
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    operationContext.throwIfCancelled();
    if (attempt > 0) {
      const configuredDelay = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] || 0;
      const delayMs = Math.max(configuredDelay, Number(lastError?.retryAfterMs || 0));
      if (typeof options.onRetry === 'function') {
        options.onRetry({ attempt, maxRetries, delayMs, error: lastError });
      }
      if (delayMs > 0) await operationContext.sleep(delayMs);
    }

    try {
      return await requestGeminiData(prompt, options);
    } catch (err) {
      lastError = err;
      if ((err?.timedOut && options.retryOnTimeout === false) || !isRetryableGeminiError(err) || attempt >= maxRetries) break;
    }
  }

  throw lastError || new Error('Gemini request failed.');
}

async function requestGeminiTextWithRetry(prompt, options = {}) {
  const data = await requestGeminiDataWithRetry(prompt, options);
  const text = extractGeminiText(data);
  if (!text) {
    const err = new Error('Gemini returned no readable text.');
    err.retryable = true;
    throw err;
  }
  return text;
}

module.exports = {
  configureSharedRateGate,
  GEMINI_MODEL,
  HARD_MAX_REQUESTS_PER_MINUTE,
  REQUEST_RATE_WINDOW_MS,
  DEFAULT_REQUEST_SPACING_MS,
  getGeminiRequestSpacingMs,
  getGeminiClientStatus,
  cancelGeminiRequestsByLabelPrefix,
  cancelAllGeminiRequests,
  extractGeminiText,
  isRetryableGeminiError,
  requestGeminiData,
  requestGeminiText,
  requestGeminiDataWithRetry,
  requestGeminiTextWithRetry
};
