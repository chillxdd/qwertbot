'use strict';

const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const StreamListProbeAttempt = require('../models/StreamListProbeAttempt');
const { grpcStatusName } = require('./youtubeChatStream');

const VALID_RETRY_MINUTES = Object.freeze([1, 2, 5, 10, 15, 30]);
const DEFAULT_RETRY_MINUTES = 5;
const LAB_DAILY_SAFETY_CAP = 240;
const HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TARGET_RECONCILE_MS = 5000;
const END_STATUS_GRACE_MS = 100;
const TERMINAL_NO_RETRY_CODES = new Set([3, 5, 7, 9]);

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarizeAttempts(attempts = []) {
  const usable = attempts.filter((item) => !item.excludedFromStats && Number.isFinite(Number(item.durationMs)));
  const durations = usable.map((item) => Number(item.durationMs));
  const lastAttempt = usable.length ? usable[0] : null;
  return {
    attempts: usable.length,
    averageDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    medianDurationMs: durations.length ? Math.round(median(durations)) : null,
    longestDurationMs: durations.length ? Math.max(...durations) : null,
    lastAttempt,
    buckets: {
      upTo15s: durations.filter((value) => value <= 15000).length,
      from15To60s: durations.filter((value) => value > 15000 && value <= 60000).length,
      from1To5m: durations.filter((value) => value > 60000 && value <= 300000).length,
      over5m: durations.filter((value) => value > 300000).length
    }
  };
}

function targetLabel(target) {
  const titles = [...new Set((target?.broadcasts || []).map((item) => String(item?.title || '').trim()).filter(Boolean))];
  if (!titles.length) return 'YouTube live chat';
  return titles.length === 1 ? titles[0] : titles.join(' / ');
}

function safeDetail(value, limit = 500) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, limit);
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function createStreamListLab({ authManager, quotaManager, getTargets = () => [], getProductionStates = () => [] } = {}) {
  let enabled = false;
  let runId = null;
  let lastRunId = null;
  let retryMinutes = DEFAULT_RETRY_MINUTES;
  let nodeProbeEnabled = true;
  let pythonProbeEnabled = true;
  let monitorTimer = null;
  let reconcilePromise = null;
  let environment = null;
  let lastError = null;
  let reservationTail = Promise.resolve();

  const current = new Map();
  const retries = new Map();
  const continuations = new Map();

  let nodeGrpcBundle = null;

  function key(clientKey, liveChatId) { return `${clientKey}:${liveChatId}`; }
  function pythonVendorDir() { return path.join(__dirname, '..', 'diagnostics', 'python_vendor'); }
  function pythonProbePath() { return path.join(__dirname, '..', 'diagnostics', 'streamlist_python_probe.py'); }
  function pythonEnv(extra = {}) {
    return {
      ...process.env,
      PYTHONPATH: [pythonVendorDir(), process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter),
      ...extra
    };
  }

  function getTargetMap() {
    return new Map((Array.isArray(getTargets()) ? getTargets() : [])
      .map((target) => [String(target?.liveChatId || ''), target])
      .filter(([id]) => Boolean(id)));
  }

  function loadNodeGrpc() {
    if (nodeGrpcBundle) return nodeGrpcBundle;
    const grpc = require('@grpc/grpc-js');
    const protoLoader = require('@grpc/proto-loader');
    const protoPath = path.join(__dirname, '..', 'proto', 'youtube_stream_list.proto');
    const definition = protoLoader.loadSync(protoPath, {
      keepCase: true, longs: String, enums: Number, defaults: false, oneofs: true
    });
    const root = grpc.loadPackageDefinition(definition);
    const Service = root?.youtube?.api?.v3?.V3DataLiveChatMessageService;
    if (!Service) throw new Error('YouTube StreamList gRPC service definition could not be loaded.');
    nodeGrpcBundle = { grpc, Service };
    return nodeGrpcBundle;
  }

  function checkEnvironment({ force = false } = {}) {
    if (environment && !force) return environment;
    const checkedAt = new Date().toISOString();
    let node;
    try {
      const bundle = loadNodeGrpc();
      const version = (() => { try { return require('@grpc/grpc-js/package.json').version; } catch (_) { return null; } })();
      node = { available: Boolean(bundle?.grpc && bundle?.Service), detail: 'Minimal Node probe can load grpc-js and the StreamList proto.', version };
    } catch (err) {
      node = { available: false, detail: safeDetail(err?.message || err) };
    }

    let python;
    try {
      const probe = spawnSync('python3', ['-c', 'import json,sys,grpc,google.protobuf,runpy; ns=runpy.run_path(sys.argv[1]); ns["build_messages"](); print(json.dumps({"python":sys.version.split()[0],"grpc":grpc.__version__,"protobuf":google.protobuf.__version__}))', pythonProbePath()], {
        env: pythonEnv(), encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe']
      });
      if (probe.error || probe.status !== 0) {
        python = { available: false, detail: safeDetail(probe.stderr || probe.error?.message || 'python3/grpcio check failed') };
      } else {
        const parsed = JSON.parse(String(probe.stdout || '').trim());
        python = {
          available: true,
          detail: 'python3, grpcio, protobuf, and the bundled diagnostic probe are available.',
          version: parsed.python || null,
          grpcVersion: parsed.grpc || null,
          protobufVersion: parsed.protobuf || null
        };
      }
    } catch (err) {
      python = { available: false, detail: safeDetail(err?.message || err) };
    }
    environment = { checkedAt, node, python };
    return environment;
  }

  async function reserveProbeAttempt(clientKey, liveChatId, label) {
    const previous = reservationTail;
    let release;
    reservationTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const dayKey = quotaManager.pacificDayKey();
      const starts = await StreamListProbeAttempt.countDocuments({
        dayKey,
        clientKey: { $in: ['minimal-node', 'python-grpcio'] }
      });
      if (starts >= LAB_DAILY_SAFETY_CAP) {
        const err = new Error(`StreamList Lab daily safety cap (${LAB_DAILY_SAFETY_CAP}) reached for ${dayKey}.`);
        err.code = 'STREAMLIST_LAB_DAILY_CAP';
        throw err;
      }
      await quotaManager.reserveMainUnits(1);
      const startedAt = new Date();
      const doc = await StreamListProbeAttempt.create({
        runId,
        dayKey,
        clientKey,
        liveChatId,
        targetLabel: label,
        startedAt,
        expireAt: new Date(startedAt.getTime() + HISTORY_RETENTION_MS)
      });
      return doc;
    } finally {
      release();
    }
  }

  async function finishAttempt(active, details = {}) {
    if (!active || active.finished) return;
    active.finished = true;
    const endedAt = new Date();
    const durationMs = Math.max(0, endedAt.getTime() - new Date(active.startedAt).getTime());
    const update = {
      endedAt,
      durationMs,
      responseCount: Number(active.responseCount || 0),
      messageCount: Number(active.messageCount || 0),
      pageTokenCount: Number(active.pageTokenCount || 0),
      firstResponseAt: active.firstResponseAt || null,
      lastResponseAt: active.lastResponseAt || null,
      terminalEvent: safeDetail(details.terminalEvent || active.terminalEvent || 'unknown', 80),
      grpcStatusCode: finiteNumberOrNull(details.grpcStatusCode),
      grpcStatusName: safeDetail(details.grpcStatusName || '', 80),
      grpcStatusDetails: safeDetail(details.grpcStatusDetails || '', 500),
      grpcMetadataKeys: Array.isArray(details.grpcMetadataKeys) ? details.grpcMetadataKeys.map((x) => safeDetail(x, 120)).filter(Boolean).slice(0, 30) : [],
      terminationReason: safeDetail(details.terminationReason || '', 500),
      excludedFromStats: Boolean(details.excludedFromStats)
    };
    try { await StreamListProbeAttempt.updateOne({ _id: active.docId }, { $set: update }); }
    catch (err) { console.warn(`[StreamList Lab] Could not persist ${active.clientKey} attempt: ${err?.message || err}`); }

    current.delete(key(active.clientKey, active.liveChatId));
    console.log(`[StreamList Lab][${active.clientKey}] ${update.terminalEvent} after ${(durationMs / 1000).toFixed(2)}s; responses=${update.responseCount} messages=${update.messageCount}${update.grpcStatusCode !== null ? ` grpc=${update.grpcStatusCode} ${update.grpcStatusName}` : ''}.`);

    if (!enabled || details.excludedFromStats || details.noRetry) return;
    const targetMap = getTargetMap();
    if (!targetMap.has(active.liveChatId)) return;
    if (active.clientKey === 'minimal-node' && !nodeProbeEnabled) return;
    if (active.clientKey === 'python-grpcio' && !pythonProbeEnabled) return;
    const code = update.grpcStatusCode;
    if (TERMINAL_NO_RETRY_CODES.has(code) || update.terminalEvent === 'offline_at') return;
    scheduleRetry(active.clientKey, active.liveChatId, code === 8 ? 15 * 60 * 1000 : 0);
  }

  function scheduleRetry(clientKey, liveChatId, minimumDelayMs = 0) {
    const k = key(clientKey, liveChatId);
    if (retries.has(k) || current.has(k) || !enabled) return;
    const delayMs = Math.max(Math.max(1, Number(retryMinutes || DEFAULT_RETRY_MINUTES)) * 60 * 1000, Math.max(0, Number(minimumDelayMs || 0)));
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    const timer = setTimeout(() => {
      retries.delete(k);
      void reconcileTargets().catch((err) => { lastError = safeDetail(err?.message || err); });
    }, delayMs);
    timer.unref?.();
    retries.set(k, { clientKey, liveChatId, nextRetryAt, timer });
  }

  function clearRetry(clientKey, liveChatId) {
    const k = key(clientKey, liveChatId);
    const record = retries.get(k);
    if (record?.timer) clearTimeout(record.timer);
    retries.delete(k);
  }

  async function startNodeProbe(target) {
    const clientKey = 'minimal-node';
    const liveChatId = String(target.liveChatId || '');
    const k = key(clientKey, liveChatId);
    if (!enabled || !nodeProbeEnabled || current.has(k) || retries.has(k)) return;
    const env = checkEnvironment();
    if (!env.node.available) return;

    const label = targetLabel(target);
    let doc;
    try { doc = await reserveProbeAttempt(clientKey, liveChatId, label); }
    catch (err) { lastError = safeDetail(err?.message || err); return; }
    if (!enabled || !getTargetMap().has(liveChatId)) {
      await StreamListProbeAttempt.updateOne({ _id: doc._id }, { $set: { endedAt: new Date(), durationMs: 0, terminalEvent: 'target-gone-before-connect', excludedFromStats: true } }).catch(() => {});
      return;
    }

    const active = {
      clientKey, liveChatId, docId: doc._id, startedAt: doc.startedAt,
      state: 'connecting', responseCount: 0, messageCount: 0, pageTokenCount: 0,
      firstResponseAt: null, lastResponseAt: null, finished: false, manualReason: null,
      client: null, call: null, endTimer: null, lastStatus: null
    };
    current.set(k, active);
    try {
      const token = await authManager.getValidAccessToken();
      if (!enabled || active.finished) return;
      const { grpc, Service } = loadNodeGrpc();
      const client = new Service('dns:///youtube.googleapis.com:443', grpc.credentials.createSsl());
      active.client = client;
      const metadata = new grpc.Metadata();
      metadata.set('authorization', `Bearer ${token}`);
      const request = {
        live_chat_id: liveChatId,
        part: ['snippet', 'authorDetails'],
        profile_image_size: 16,
        max_results: 200
      };
      const continuation = continuations.get(k);
      if (continuation) request.page_token = continuation;
      const method = typeof client.StreamList === 'function' ? client.StreamList : client.streamList;
      if (typeof method !== 'function') throw new Error('StreamList gRPC method unavailable.');
      const callStartedAt = new Date();
      const call = method.call(client, request, metadata);
      active.call = call;
      active.startedAt = callStartedAt;
      active.state = 'connected';
      void StreamListProbeAttempt.updateOne({ _id: active.docId }, { $set: { startedAt: callStartedAt } }).catch(() => {});
      console.log(`[StreamList Lab][minimal-node] Connected ${liveChatId.slice(-8)}.`);
      call.on('data', (response) => {
        if (active.finished) return;
        active.responseCount += 1;
        active.messageCount += Array.isArray(response?.items) ? response.items.length : 0;
        active.lastResponseAt = new Date();
        if (!active.firstResponseAt) active.firstResponseAt = active.lastResponseAt;
        if (response?.next_page_token) {
          continuations.set(k, String(response.next_page_token));
          active.pageTokenCount += 1;
        }
        if (response?.offline_at) {
          active.terminalEvent = 'offline_at';
          void finalizeNode({ terminalEvent: 'offline_at', terminationReason: `offline_at=${response.offline_at}`, noRetry: true });
        }
      });
      call.on('status', (status) => {
        active.lastStatus = {
          code: Number.isFinite(Number(status?.code)) ? Number(status.code) : null,
          name: Number.isFinite(Number(status?.code)) ? grpcStatusName(Number(status.code)) : '',
          details: String(status?.details || ''),
          metadataKeys: (() => { try { return Object.keys(status?.metadata?.getMap?.() || {}).sort(); } catch (_) { return []; } })()
        };
      });
      call.on('error', (err) => {
        if (active.finished) return;
        if (active.endTimer) clearTimeout(active.endTimer);
        const code = finiteNumberOrNull(err?.code) ?? active.lastStatus?.code ?? null;
        void finalizeNode({
          terminalEvent: active.manualReason ? 'manual-stop' : 'error',
          grpcStatusCode: code,
          grpcStatusName: code !== null ? grpcStatusName(code) : active.lastStatus?.name,
          grpcStatusDetails: err?.details || err?.message || active.lastStatus?.details,
          grpcMetadataKeys: active.lastStatus?.metadataKeys || [],
          terminationReason: active.manualReason || err?.message || String(err),
          excludedFromStats: Boolean(active.manualReason),
          noRetry: Boolean(active.manualReason)
        });
      });
      call.on('end', () => {
        if (active.finished || active.endTimer) return;
        active.endTimer = setTimeout(() => {
          active.endTimer = null;
          const status = active.lastStatus || {};
          void finalizeNode({
            terminalEvent: active.manualReason ? 'manual-stop' : 'end',
            grpcStatusCode: status.code,
            grpcStatusName: status.name,
            grpcStatusDetails: status.details,
            grpcMetadataKeys: status.metadataKeys || [],
            terminationReason: active.manualReason || 'server stream ended',
            excludedFromStats: Boolean(active.manualReason),
            noRetry: Boolean(active.manualReason)
          });
        }, END_STATUS_GRACE_MS);
      });

      async function finalizeNode(details) {
        if (active.finished) return;
        try { active.call?.cancel?.(); } catch (_) {}
        try { active.client?.close?.(); } catch (_) {}
        await finishAttempt(active, details);
      }
      active.finalize = finalizeNode;
    } catch (err) {
      try { active.client?.close?.(); } catch (_) {}
      await finishAttempt(active, {
        terminalEvent: active.manualReason ? 'manual-stop' : 'connect-error',
        grpcStatusCode: finiteNumberOrNull(err?.code),
        grpcStatusName: finiteNumberOrNull(err?.code) !== null ? grpcStatusName(finiteNumberOrNull(err?.code)) : '',
        grpcStatusDetails: err?.details || err?.message || String(err),
        terminationReason: active.manualReason || err?.message || String(err),
        excludedFromStats: Boolean(active.manualReason),
        noRetry: Boolean(active.manualReason)
      });
    }
  }

  async function startPythonProbe(target) {
    const clientKey = 'python-grpcio';
    const liveChatId = String(target.liveChatId || '');
    const k = key(clientKey, liveChatId);
    if (!enabled || !pythonProbeEnabled || current.has(k) || retries.has(k)) return;
    const envStatus = checkEnvironment();
    if (!envStatus.python.available) return;

    const label = targetLabel(target);
    let doc;
    try { doc = await reserveProbeAttempt(clientKey, liveChatId, label); }
    catch (err) { lastError = safeDetail(err?.message || err); return; }
    const token = await authManager.getValidAccessToken().catch(async (err) => {
      await StreamListProbeAttempt.updateOne({ _id: doc._id }, { $set: { endedAt: new Date(), durationMs: 0, terminalEvent: 'auth-error', terminationReason: safeDetail(err?.message || err), excludedFromStats: true } }).catch(() => {});
      throw err;
    }).catch((err) => { lastError = safeDetail(err?.message || err); return null; });
    if (!token) return;
    if (!enabled || !getTargetMap().has(liveChatId)) {
      await StreamListProbeAttempt.updateOne({ _id: doc._id }, { $set: { endedAt: new Date(), durationMs: 0, terminalEvent: 'target-gone-before-connect', excludedFromStats: true } }).catch(() => {});
      return;
    }

    const active = {
      clientKey, liveChatId, docId: doc._id, startedAt: doc.startedAt,
      state: 'connecting', responseCount: 0, messageCount: 0, pageTokenCount: 0,
      firstResponseAt: null, lastResponseAt: null, finished: false, manualReason: null,
      child: null, stdoutBuffer: '', stderrBuffer: '', lastTerminal: null
    };
    current.set(k, active);

    const child = spawn('python3', [pythonProbePath()], {
      env: pythonEnv({
        YOUTUBE_LIVE_CHAT_ID: liveChatId,
        YOUTUBE_ACCESS_TOKEN: token,
        YOUTUBE_PAGE_TOKEN: continuations.get(k) || ''
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    active.child = child;
    console.log(`[StreamList Lab][python-grpcio] Starting ${liveChatId.slice(-8)}.`);

    const processLine = (line) => {
      const clean = String(line || '').trim();
      if (!clean) return;
      let event;
      try { event = JSON.parse(clean); } catch (_) { active.stderrBuffer = safeDetail(`${active.stderrBuffer} ${clean}`, 500); return; }
      if (event.event === 'started') {
        active.state = 'connected';
        const actualStartedAt = new Date(event.at || Date.now());
        if (!Number.isNaN(actualStartedAt.getTime())) {
          active.startedAt = actualStartedAt;
          void StreamListProbeAttempt.updateOne({ _id: active.docId }, { $set: { startedAt: actualStartedAt } }).catch(() => {});
        }
      }
      if (event.event === 'data') {
        active.state = 'connected';
        active.responseCount = Number(event.responseCount || active.responseCount || 0);
        active.messageCount = Number(event.messageCount || active.messageCount || 0);
        active.pageTokenCount = Number(event.pageTokenCount || active.pageTokenCount || 0);
        active.lastResponseAt = new Date(event.at || Date.now());
        if (!active.firstResponseAt) active.firstResponseAt = active.lastResponseAt;
        if (event.nextPageToken) continuations.set(k, String(event.nextPageToken));
        if (event.offlineAt) active.lastTerminal = { terminalEvent: 'offline_at', terminationReason: `offline_at=${event.offlineAt}`, noRetry: true };
      }
      if (event.event === 'end' || event.event === 'error' || event.event === 'fatal') {
        const code = finiteNumberOrNull(event.code);
        active.lastTerminal = {
          terminalEvent: active.manualReason ? 'manual-stop' : event.event,
          grpcStatusCode: code,
          grpcStatusName: event.codeName || (code !== null ? grpcStatusName(code) : ''),
          grpcStatusDetails: event.details || event.error || '',
          grpcMetadataKeys: Array.isArray(event.trailerKeys) ? event.trailerKeys : [],
          terminationReason: active.manualReason || event.details || event.error || event.event,
          excludedFromStats: Boolean(active.manualReason),
          noRetry: Boolean(active.manualReason) || event.stopped === true || event.event === 'fatal'
        };
      }
    };

    child.stdout.on('data', (chunk) => {
      active.stdoutBuffer += String(chunk || '');
      let idx;
      while ((idx = active.stdoutBuffer.indexOf('\n')) >= 0) {
        const line = active.stdoutBuffer.slice(0, idx);
        active.stdoutBuffer = active.stdoutBuffer.slice(idx + 1);
        processLine(line);
      }
    });
    child.stderr.on('data', (chunk) => { active.stderrBuffer = safeDetail(`${active.stderrBuffer} ${String(chunk || '')}`, 500); });
    child.on('error', (err) => {
      active.lastTerminal = { terminalEvent: 'spawn-error', terminationReason: err?.message || String(err), excludedFromStats: true, noRetry: true };
    });
    child.on('exit', (code, signal) => {
      if (active.stdoutBuffer.trim()) processLine(active.stdoutBuffer);
      const terminal = active.lastTerminal || {
        terminalEvent: active.manualReason ? 'manual-stop' : 'process-exit',
        terminationReason: active.manualReason || `python exited code=${code ?? 'null'} signal=${signal || 'none'}${active.stderrBuffer ? `: ${active.stderrBuffer}` : ''}`,
        excludedFromStats: Boolean(active.manualReason),
        noRetry: Boolean(active.manualReason)
      };
      void finishAttempt(active, terminal);
    });
  }

  async function stopActive(active, reason = 'manual-stop') {
    if (!active || active.finished) return;
    active.manualReason = reason;
    if (active.clientKey === 'minimal-node') {
      if (active.finalize) return active.finalize({ terminalEvent: reason, terminationReason: reason, excludedFromStats: true, noRetry: true });
      try { active.call?.cancel?.(); active.client?.close?.(); } catch (_) {}
      return finishAttempt(active, { terminalEvent: reason, terminationReason: reason, excludedFromStats: true, noRetry: true });
    }
    if (active.clientKey === 'python-grpcio') {
      return new Promise((resolve) => {
        let settled = false;
        let fallback = null;
        const settle = () => {
          if (settled) return;
          settled = true;
          if (fallback) clearTimeout(fallback);
          setTimeout(resolve, 0);
        };
        active.child?.once?.('exit', settle);
        try { active.child?.kill?.('SIGTERM'); } catch (_) {}
        fallback = setTimeout(() => {
          if (active.finished) return settle();
          try { active.child?.kill?.('SIGKILL'); } catch (_) {}
          void finishAttempt(active, { terminalEvent: reason, terminationReason: reason, excludedFromStats: true, noRetry: true }).finally(settle);
        }, 2000);
        fallback.unref?.();
      });
    }
  }

  async function reconcileTargets() {
    if (!enabled) return;
    if (reconcilePromise) return reconcilePromise;
    reconcilePromise = (async () => {
      const targets = getTargetMap();
      for (const active of [...current.values()]) {
        if (!targets.has(active.liveChatId)) await stopActive(active, 'target-removed');
      }
      for (const retry of [...retries.values()]) {
        if (!targets.has(retry.liveChatId)) clearRetry(retry.clientKey, retry.liveChatId);
      }
      const env = checkEnvironment();
      const starts = [];
      for (const target of targets.values()) {
        if (nodeProbeEnabled && env.node.available && !current.has(key('minimal-node', target.liveChatId)) && !retries.has(key('minimal-node', target.liveChatId))) starts.push(startNodeProbe(target));
        if (pythonProbeEnabled && env.python.available && !current.has(key('python-grpcio', target.liveChatId)) && !retries.has(key('python-grpcio', target.liveChatId))) starts.push(startPythonProbe(target));
      }
      if (starts.length) await Promise.allSettled(starts);
    })().finally(() => { reconcilePromise = null; });
    return reconcilePromise;
  }

  function startMonitor() {
    if (monitorTimer) return;
    monitorTimer = setInterval(() => void reconcileTargets().catch((err) => { lastError = safeDetail(err?.message || err); }), TARGET_RECONCILE_MS);
    monitorTimer.unref?.();
  }

  function stopMonitor() {
    if (monitorTimer) clearInterval(monitorTimer);
    monitorTimer = null;
  }

  async function start(options = {}) {
    if (enabled) return getState();
    const requestedRetry = Number(options.retryMinutes || DEFAULT_RETRY_MINUTES);
    retryMinutes = VALID_RETRY_MINUTES.includes(requestedRetry) ? requestedRetry : DEFAULT_RETRY_MINUTES;
    nodeProbeEnabled = options.nodeProbeEnabled !== false;
    pythonProbeEnabled = options.pythonProbeEnabled !== false;
    if (!nodeProbeEnabled && !pythonProbeEnabled) throw new Error('Enable at least one diagnostic probe.');
    checkEnvironment({ force: true });
    enabled = true;
    runId = randomUUID();
    lastRunId = runId;
    lastError = null;
    startMonitor();
    console.log(`[StreamList Lab] Started run ${runId.slice(0, 8)}; retry=${retryMinutes}m node=${nodeProbeEnabled} python=${pythonProbeEnabled}.`);
    await reconcileTargets();
    return getState();
  }

  async function stop(reason = 'manual-stop') {
    if (!enabled && !runId) return getState();
    enabled = false;
    stopMonitor();
    for (const retry of [...retries.values()]) clearRetry(retry.clientKey, retry.liveChatId);
    await Promise.allSettled([...current.values()].map((active) => stopActive(active, reason)));
    if (runId) lastRunId = runId;
    runId = null;
    console.log('[StreamList Lab] Stopped.');
    return getState();
  }

  async function recordProductionAttempt(attempt = {}) {
    if (!enabled || !runId) return;
    const liveChatId = String(attempt.liveChatId || '');
    const target = getTargetMap().get(liveChatId);
    if (!liveChatId || !target) return;
    const startedAt = attempt.startedAt ? new Date(attempt.startedAt) : new Date(Date.now() - Math.max(0, Number(attempt.durationMs || 0)));
    const endedAt = attempt.endedAt ? new Date(attempt.endedAt) : new Date();
    try {
      await StreamListProbeAttempt.create({
        runId,
        dayKey: quotaManager.pacificDayKey(startedAt),
        clientKey: 'qwertbot-node',
        liveChatId,
        targetLabel: targetLabel(target),
        startedAt,
        endedAt,
        durationMs: Math.max(0, Number(attempt.durationMs || endedAt.getTime() - startedAt.getTime())),
        responseCount: Math.max(0, Number(attempt.responseCount || 0)),
        messageCount: Math.max(0, Number(attempt.messageCount || 0)),
        pageTokenCount: Math.max(0, Number(attempt.pageTokenCount || 0)),
        firstResponseAt: attempt.firstResponseAt || null,
        lastResponseAt: attempt.lastResponseAt || null,
        terminalEvent: safeDetail(attempt.terminalEvent || 'unknown', 80),
        grpcStatusCode: finiteNumberOrNull(attempt.grpcStatusCode),
        grpcStatusName: safeDetail(attempt.grpcStatusName || '', 80),
        grpcStatusDetails: safeDetail(attempt.grpcStatusDetails || '', 500),
        grpcMetadataKeys: Array.isArray(attempt.grpcMetadataKeys) ? attempt.grpcMetadataKeys.slice(0, 30) : [],
        terminationReason: safeDetail(attempt.terminationReason || '', 500),
        excludedFromStats: Boolean(attempt.excludedFromStats),
        expireAt: new Date(endedAt.getTime() + HISTORY_RETENTION_MS)
      });
    } catch (err) {
      console.warn(`[StreamList Lab] Could not persist production worker attempt: ${err?.message || err}`);
    }
  }

  function productionCurrentRows() {
    if (!enabled) return [];
    return (Array.isArray(getProductionStates()) ? getProductionStates() : []).map((state) => ({
      clientKey: 'qwertbot-node',
      liveChatId: String(state?.liveChatId || ''),
      state: String(state?.state || 'unknown'),
      startedAt: state?.currentConnectionStartedAt || null,
      currentDurationMs: Number(state?.currentConnectionAgeMs || 0),
      responseCount: Number(state?.currentResponseCount || 0),
      messageCount: Number(state?.currentMessageCount || 0),
      lastResponseAt: state?.lastDataAt || null,
      nextRetryAt: state?.nextReconnectAt || null
    })).filter((row) => row.liveChatId);
  }

  function probeCurrentRows() {
    return [...current.values()].map((active) => ({
      clientKey: active.clientKey,
      liveChatId: active.liveChatId,
      state: active.state || 'connected',
      startedAt: active.startedAt,
      currentDurationMs: Math.max(0, Date.now() - new Date(active.startedAt).getTime()),
      responseCount: Number(active.responseCount || 0),
      messageCount: Number(active.messageCount || 0),
      lastResponseAt: active.lastResponseAt || null,
      nextRetryAt: null
    }));
  }

  async function getState() {
    let selectedRunId = runId || lastRunId;
    const targets = [...getTargetMap().values()].map((target) => ({ liveChatId: target.liveChatId, label: targetLabel(target), broadcasts: target.broadcasts || [] }));
    let attempts = [];
    let labStarts = 0;
    try {
      if (!selectedRunId) {
        const latest = await StreamListProbeAttempt.find({}).sort({ startedAt: -1 }).limit(1).lean();
        selectedRunId = latest?.[0]?.runId || null;
        if (selectedRunId) lastRunId = selectedRunId;
      }
      if (selectedRunId) attempts = await StreamListProbeAttempt.find({ runId: selectedRunId }).sort({ endedAt: -1, startedAt: -1 }).limit(200).lean();
      labStarts = await StreamListProbeAttempt.countDocuments({
        dayKey: quotaManager.pacificDayKey(),
        clientKey: { $in: ['minimal-node', 'python-grpcio'] }
      });
    } catch (err) {
      lastError = safeDetail(err?.message || err);
    }
    const normalized = attempts.map((item) => ({
      id: String(item._id), runId: item.runId, clientKey: item.clientKey, liveChatId: item.liveChatId,
      targetLabel: item.targetLabel || '', startedAt: item.startedAt, endedAt: item.endedAt,
      durationMs: item.durationMs, responseCount: item.responseCount, messageCount: item.messageCount,
      pageTokenCount: item.pageTokenCount, firstResponseAt: item.firstResponseAt, lastResponseAt: item.lastResponseAt,
      terminalEvent: item.terminalEvent, grpcStatusCode: item.grpcStatusCode, grpcStatusName: item.grpcStatusName,
      grpcStatusDetails: item.grpcStatusDetails, grpcMetadataKeys: item.grpcMetadataKeys,
      terminationReason: item.terminationReason, excludedFromStats: Boolean(item.excludedFromStats)
    }));
    const grouped = { 'qwertbot-node': [], 'minimal-node': [], 'python-grpcio': [] };
    for (const item of normalized) if (grouped[item.clientKey]) grouped[item.clientKey].push(item);
    return {
      enabled,
      runId,
      lastRunId,
      historyRunId: selectedRunId || null,
      retryMinutes,
      validRetryMinutes: [...VALID_RETRY_MINUTES],
      probes: { nodeProbeEnabled, pythonProbeEnabled },
      environment: checkEnvironment(),
      targets,
      current: [...productionCurrentRows(), ...probeCurrentRows()],
      retries: [...retries.values()].map(({ clientKey, liveChatId, nextRetryAt }) => ({ clientKey, liveChatId, nextRetryAt })),
      stats: Object.fromEntries(Object.entries(grouped).map(([clientKey, rows]) => [clientKey, summarizeAttempts(rows)])),
      recentAttempts: normalized.filter((item) => item.endedAt).slice(0, 100),
      quota: { labStreamConnections: labStarts },
      labDailySafetyCap: LAB_DAILY_SAFETY_CAP,
      lastError
    };
  }

  async function recheckEnvironment() {
    checkEnvironment({ force: true });
    if (enabled) await reconcileTargets();
    return getState();
  }

  async function clearHistory() {
    if (enabled) throw new Error('Stop the StreamList Lab before clearing its history.');
    await StreamListProbeAttempt.deleteMany({});
    lastRunId = null;
    return getState();
  }

  async function shutdown() { await stop('process-shutdown'); }

  return {
    start,
    stop,
    shutdown,
    getState,
    recheckEnvironment,
    clearHistory,
    reconcileTargets,
    recordProductionAttempt,
    checkEnvironment,
    constants: { VALID_RETRY_MINUTES, DEFAULT_RETRY_MINUTES, LAB_DAILY_SAFETY_CAP }
  };
}

module.exports = {
  createStreamListLab,
  summarizeAttempts,
  VALID_RETRY_MINUTES,
  DEFAULT_RETRY_MINUTES,
  LAB_DAILY_SAFETY_CAP
};
