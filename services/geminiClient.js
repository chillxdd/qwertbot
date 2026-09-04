const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const GEMINI_MODEL = String(process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite').trim() || 'gemini-3.5-flash-lite';
const HARD_MAX_REQUESTS_PER_MINUTE = 15;
const REQUEST_RATE_WINDOW_MS = 60 * 1000;
const MIN_SAFE_REQUEST_START_SPACING_MS = Math.ceil(REQUEST_RATE_WINDOW_MS / HARD_MAX_REQUESTS_PER_MINUTE);
const DEFAULT_REQUEST_SPACING_MS = MIN_SAFE_REQUEST_START_SPACING_MS;
const MIN_REQUEST_SPACING_MS = MIN_SAFE_REQUEST_START_SPACING_MS;
const MAX_REQUEST_SPACING_MS = 30000;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_BACKGROUND_RETRIES = 1;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

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
    processing: Boolean(processing)
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function normalizePriority(value) {
  if (value === 'high' || value === 'low') return value;
  return 'normal';
}

function nextJob() {
  return queues.high.shift() || queues.normal.shift() || queues.low.shift() || null;
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

function noteTemporaryFailure(err) {
  const status = Number(err?.status || 0);
  if (!isRetryableGeminiError(err)) return;

  let fallbackMs = 0;
  if (status === 429) fallbackMs = 5000;
  else if (status >= 500 || status === 408) fallbackMs = 3000;
  else fallbackMs = 2000;

  const delayMs = Math.max(fallbackMs, Number(err?.retryAfterMs || 0));
  if (delayMs > 0) globalBackoffUntil = Math.max(globalBackoffUntil, Date.now() + delayMs);
}

function buildGeminiHttpError(response, data) {
  const err = new Error(data?.error?.message || data?.message || `Gemini API returned HTTP ${response.status}`);
  err.status = response.status;
  err.retryable = RETRYABLE_STATUSES.has(response.status);
  err.retryAfterMs = parseRetryAfterMs(response, data);
  err.geminiData = data;
  noteTemporaryFailure(err);
  return err;
}

function streamEventFailure(event) {
  const interaction = event?.interaction && typeof event.interaction === 'object' ? event.interaction : null;
  const status = String(interaction?.status || event?.status || '').trim().toLowerCase();
  const eventType = String(event?.event_type || '').trim().toLowerCase();
  const failed = eventType === 'interaction.failed' || ['failed', 'cancelled', 'budget_exceeded'].includes(status);
  if (!failed) return null;
  const message = interaction?.error?.message || event?.error?.message || `Gemini interaction ended with status ${status || eventType || 'failed'}.`;
  const err = new Error(message);
  err.status = Number(interaction?.error?.code || event?.error?.code || 0) || undefined;
  err.retryable = err.status ? RETRYABLE_STATUSES.has(err.status) : false;
  return err;
}

async function performStreamingGeminiRequest(prompt, { timeoutMs, label, retryOnTimeout, cancelSignal = null }) {
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
  let response;

  try {
    response = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Accept': 'text/event-stream',
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({ model: GEMINI_MODEL, input: prompt, stream: true }),
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

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let outputText = '';
    let finalInteraction = null;
    let firstEventAt = 0;

    const processBlock = (block) => {
      const dataLines = String(block || '')
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart());
      if (!dataLines.length) return;
      const payload = dataLines.join('\n').trim();
      if (!payload || payload === '[DONE]') return;

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

      while (true) {
        const match = buffer.match(/\r?\n\r?\n/);
        if (!match || match.index === undefined) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        processBlock(block);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) processBlock(buffer);

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
      noteTemporaryFailure(wrapped);
      throw wrapped;
    }
    noteTemporaryFailure(err);
    throw err;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (cancelSignal) cancelSignal.removeEventListener('abort', onExternalAbort);
  }
}

async function performGeminiRequest(prompt, { timeoutMs = DEFAULT_TIMEOUT_MS, label = 'gemini', retryOnTimeout = true, stream = false, cancelSignal = null } = {}) {
  if (stream === true) {
    return performStreamingGeminiRequest(prompt, { timeoutMs, label, retryOnTimeout, cancelSignal });
  }

  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY environment variable is not set.');

  const controller = new AbortController();
  let externallyCancelled = Boolean(cancelSignal?.aborted);
  const onExternalAbort = () => { externallyCancelled = true; controller.abort(); };
  if (cancelSignal && !cancelSignal.aborted) cancelSignal.addEventListener('abort', onExternalAbort, { once: true });
  if (externallyCancelled) controller.abort();
  const timeoutLimitMs = Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), timeoutLimitMs);
  let response;
  try {
    response = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({ model: GEMINI_MODEL, input: prompt }),
      signal: controller.signal
    });
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
    const wrapped = new Error(timedOut ? 'Gemini request timed out.' : (err?.message || 'Gemini request failed.'));
    wrapped.timedOut = timedOut;
    wrapped.retryable = timedOut ? retryOnTimeout !== false : true;
    wrapped.elapsedMs = Date.now() - startedAt;
    if (timedOut) {
      console.warn(`[Gemini] ${label} timed out after ${(wrapped.elapsedMs / 1000).toFixed(1)}s${retryOnTimeout === false ? '; timeout retries disabled' : ''}.`);
    }
    noteTemporaryFailure(wrapped);
    throw wrapped;
  } finally {
    clearTimeout(timeout);
    if (cancelSignal) cancelSignal.removeEventListener('abort', onExternalAbort);
  }

  let data;
  try {
    data = await response.json();
  } catch (_) {
    const err = new Error(`Gemini returned invalid JSON. HTTP ${response.status}`);
    err.status = response.status;
    err.retryable = response.status >= 500;
    err.retryAfterMs = parseRetryAfterMs(response, null);
    noteTemporaryFailure(err);
    throw err;
  }

  if (!response.ok) throw buildGeminiHttpError(response, data);

  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs >= 10000) {
    console.info(`[Gemini] ${label} completed in ${(elapsedMs / 1000).toFixed(1)}s.`);
  }
  return data;
}

function enqueueGeminiRequest(prompt, options = {}) {
  const priority = normalizePriority(options.priority);
  return new Promise((resolve, reject) => {
    queues[priority].push({ prompt, options, resolve, reject, cancelController: new AbortController() });
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
      if (waitMs > 0) await sleep(waitMs);

      // Recalculate after waking so timer jitter, backoff changes, and the
      // rolling 60-second window can never produce a burst over 15 RPM.
      readyAt = getRateLimitReadyAt();
      waitMs = Math.max(0, readyAt - Date.now());
      if (waitMs > 0) {
        await sleep(waitMs);
        continue;
      }

      // Select only after the pacing wait so a newly-arrived tagged question
      // can jump ahead of background learning that has not started yet.
      const job = nextJob();
      if (!job) continue;

      const startedAt = Date.now();
      pruneRequestStartTimes(startedAt);
      lastRequestStartedAt = startedAt;
      requestStartTimes.push(startedAt);

      activeJob = job;
      try {
        const data = await performGeminiRequest(job.prompt, { ...job.options, cancelSignal: job.cancelController.signal });
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
    if (attempt > 0) {
      const configuredDelay = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] || 0;
      const delayMs = Math.max(configuredDelay, Number(lastError?.retryAfterMs || 0));
      if (typeof options.onRetry === 'function') {
        options.onRetry({ attempt, maxRetries, delayMs, error: lastError });
      }
      if (delayMs > 0) await sleep(delayMs);
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
  GEMINI_MODEL,
  HARD_MAX_REQUESTS_PER_MINUTE,
  REQUEST_RATE_WINDOW_MS,
  DEFAULT_REQUEST_SPACING_MS,
  getGeminiRequestSpacingMs,
  getGeminiClientStatus,
  cancelGeminiRequestsByLabelPrefix,
  extractGeminiText,
  isRetryableGeminiError,
  requestGeminiData,
  requestGeminiText,
  requestGeminiDataWithRetry,
  requestGeminiTextWithRetry
};
