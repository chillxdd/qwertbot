'use strict';

const path = require('node:path');
const { createInitialHistoryGate, isFreshMessage } = require('../features/youtube/pure');

const MAX_SEEN_IDS = 4000;
const BACKOFF_MS = [2000, 5000, 15000, 30000, 60000, 120000, 300000];
const RATE_LIMIT_BACKOFF_MS = [60000, 120000, 300000, 600000, 900000];
const STABLE_CONNECTION_RESET_MS = 5 * 60 * 1000;
const GOOGLE_QUOTA_RETRY_MS = 15 * 60 * 1000;
// Defense-in-depth quota guard: even if a future regression resets normal
// backoff too aggressively, a flapping chat cannot open thousands of
// StreamList RPCs. Eight starts inside ten minutes forces a fifteen-minute
// cooling period before the next reconnect attempt.
const CHURN_WINDOW_MS = 10 * 60 * 1000;
const CHURN_CONNECTION_LIMIT = 8;
const CHURN_COOLDOWN_MS = 15 * 60 * 1000;
// Healthy long-lived streams should be nowhere near this. This hard ceiling is
// deliberately generous but prevents a future transport bug from generating
// thousands of StreamList requests in one Google quota day.
const STREAMLIST_DAILY_SAFETY_CAP = 200;
const TERMINAL_GRPC_CODES = new Set([3, 5, 7, 9]);

function loadGrpcService() {
  let grpc;
  let protoLoader;
  try {
    grpc = require('@grpc/grpc-js');
    protoLoader = require('@grpc/proto-loader');
  } catch (err) {
    throw new Error('YouTube live chat streaming dependencies are missing. Run npm install after deploying the updated package.json.');
  }
  const protoPath = path.join(__dirname, '..', 'proto', 'youtube_stream_list.proto');
  const definition = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: Number,
    defaults: false,
    oneofs: true
  });
  const root = grpc.loadPackageDefinition(definition);
  const Service = root?.youtube?.api?.v3?.V3DataLiveChatMessageService;
  if (!Service) throw new Error('Could not load the YouTube StreamList gRPC service definition.');
  return { grpc, Service };
}

function grpcCode(reason) {
  const value = Number(reason?.code);
  return Number.isFinite(value) ? value : null;
}

function errorText(reason) {
  return String(reason?.details || reason?.message || reason || '');
}

function isGoogleQuotaError(reason) {
  if (String(reason?.code || '') === 'GOOGLE_YOUTUBE_QUOTA_EXHAUSTED') return true;
  // Google's StreamList documentation uses RESOURCE_EXHAUSTED (8) for the
  // per-chat request-rate guard. Do not mistake that generic gRPC wording for
  // the project's daily Data API quota being exhausted.
  if (grpcCode(reason) === 8) return false;
  const text = errorText(reason).toLowerCase();
  return text.includes('quota') && (text.includes('exceed') || text.includes('exhaust'));
}

function terminalStateFor(reason) {
  const code = grpcCode(reason);
  if (!TERMINAL_GRPC_CODES.has(code)) return null;
  // NOT_FOUND / FAILED_PRECONDITION are normally ended/disabled chats. Invalid
  // request and permission errors are surfaced as terminal errors instead of
  // being retried forever and burning quota.
  return code === 5 || code === 9 ? 'ended' : 'error';
}

function deterministicJitter(baseMs, id, attempt) {
  const text = `${id}:${attempt}`;
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = ((hash * 31) + text.charCodeAt(i)) >>> 0;
  const spread = Math.min(5000, Math.max(250, Math.floor(baseMs * 0.15)));
  return hash % (spread + 1);
}

function createYouTubeChatStreamFactory({ authManager, quotaManager, onMessage, onWorkerState, grpcLoader = loadGrpcService }) {
  let grpcBundle = null;
  let sharedClient = null;

  function getClient() {
    if (!grpcBundle) grpcBundle = grpcLoader();
    if (!sharedClient) sharedClient = new grpcBundle.Service('dns:///youtube.googleapis.com:443', grpcBundle.grpc.credentials.createSsl());
    return sharedClient;
  }

  function createWorker({ liveChatId, broadcasts = [] }) {
    const id = String(liveChatId || '');
    if (!id) throw new Error('liveChatId is required.');
    let stopped = false;
    let call = null;
    let reconnectTimer = null;
    let stableConnectionTimer = null;
    let pageToken = '';
    let reconnectAttempt = 0;
    let reconnectCount = 0;
    let connectionCount = 0;
    let lastConnectedAt = null;
    let lastDataAt = null;
    let nextReconnectAt = null;
    let callStartedAtMs = 0;
    let lastConnectionDurationMs = 0;
    let longestConnectionDurationMs = 0;
    let streamGeneration = 0;
    const recentConnectionStarts = [];
    const seenIds = new Set();
    const seenQueue = [];
    let state = 'idle';
    let lastMessageAt = null;
    let lastError = null;
    let historyGate = createInitialHistoryGate();

    function currentConnectionAgeMs() {
      return callStartedAtMs ? Math.max(0, Date.now() - callStartedAtMs) : 0;
    }

    function snapshot(extra = {}) {
      return {
        liveChatId: id,
        state,
        broadcasts,
        lastMessageAt,
        lastError,
        reconnectAttempt,
        reconnectCount,
        connectionCount,
        lastConnectedAt,
        lastDataAt,
        nextReconnectAt,
        currentConnectionAgeMs: currentConnectionAgeMs(),
        lastConnectionDurationMs,
        longestConnectionDurationMs,
        ...extra
      };
    }

    function emit(extra) { try { onWorkerState?.(snapshot(extra)); } catch (_) {} }

    function markSeen(messageId) {
      const key = String(messageId || '');
      if (!key || seenIds.has(key)) return false;
      seenIds.add(key);
      seenQueue.push(key);
      if (seenQueue.length > MAX_SEEN_IDS) seenIds.delete(seenQueue.shift());
      return true;
    }

    function recordConnectionDuration() {
      if (!callStartedAtMs) return;
      lastConnectionDurationMs = Math.max(0, Date.now() - callStartedAtMs);
      longestConnectionDurationMs = Math.max(longestConnectionDurationMs, lastConnectionDurationMs);
      callStartedAtMs = 0;
    }

    function clearStableResetTimer() {
      if (stableConnectionTimer) clearTimeout(stableConnectionTimer);
      stableConnectionTimer = null;
    }

    function armStableResetTimer(generation) {
      clearStableResetTimer();
      stableConnectionTimer = setTimeout(() => {
        stableConnectionTimer = null;
        if (stopped || generation !== streamGeneration || !call || state !== 'connected') return;
        reconnectAttempt = 0;
        emit({ stableForMs: STABLE_CONNECTION_RESET_MS });
      }, STABLE_CONNECTION_RESET_MS);
    }

    function markConnected(generation) {
      if (stopped || generation !== streamGeneration) return;
      if (state !== 'connected') {
        state = 'connected';
        lastConnectedAt = new Date().toISOString();
        nextReconnectAt = null;
        emit();
        // Do not forgive a flapping stream merely because the HTTP/2 call was
        // created. It must receive data and remain connected for five minutes.
        armStableResetTimer(generation);
      }
    }

    function terminate(reason, terminalState = 'error') {
      if (stopped) return;
      stopped = true;
      clearStableResetTimer();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      nextReconnectAt = null;
      lastError = reason ? errorText(reason) : null;
      recordConnectionDuration();
      state = terminalState;
      ++streamGeneration;
      try { call?.cancel?.(); } catch (_) {}
      call = null;
      emit({ terminal: true });
    }

    function pruneConnectionStarts(now = Date.now()) {
      while (recentConnectionStarts.length && recentConnectionStarts[0] < now - CHURN_WINDOW_MS) recentConnectionStarts.shift();
    }

    function noteConnectionStart(now = Date.now()) {
      pruneConnectionStarts(now);
      recentConnectionStarts.push(now);
    }

    function churnProtectionDelay(now = Date.now()) {
      pruneConnectionStarts(now);
      if (recentConnectionStarts.length < CHURN_CONNECTION_LIMIT) return 0;
      const windowClearsAt = recentConnectionStarts[0] + CHURN_WINDOW_MS;
      return Math.max(CHURN_COOLDOWN_MS, windowClearsAt - now);
    }

    function reconnectDelay(reason) {
      const code = grpcCode(reason);
      const churnDelay = churnProtectionDelay();
      if (String(reason?.code || '') === 'YOUTUBE_STREAMLIST_DAILY_SAFETY_CAP') return Math.max(GOOGLE_QUOTA_RETRY_MS, churnDelay);
      if (isGoogleQuotaError(reason)) return Math.max(GOOGLE_QUOTA_RETRY_MS, churnDelay);
      const schedule = code === 8 ? RATE_LIMIT_BACKOFF_MS : BACKOFF_MS;
      const base = schedule[Math.min(reconnectAttempt, schedule.length - 1)];
      return Math.max(base + deterministicJitter(base, id, reconnectAttempt), churnDelay);
    }

    function scheduleReconnect(reason) {
      if (stopped || reconnectTimer) return;
      const terminalState = terminalStateFor(reason);
      if (terminalState) {
        terminate(reason, terminalState);
        return;
      }

      clearStableResetTimer();
      recordConnectionDuration();
      state = 'reconnecting';
      reconnectCount += 1;
      lastError = reason ? errorText(reason) : null;
      const delay = reconnectDelay(reason);
      reconnectAttempt += 1;
      nextReconnectAt = new Date(Date.now() + delay).toISOString();
      emit({ reconnectDelayMs: delay });

      if (isGoogleQuotaError(reason)) {
        void quotaManager.markGoogleQuotaExceeded(reason).catch(() => {});
      }

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        nextReconnectAt = null;
        void connect().catch((err) => scheduleReconnect(err));
      }, delay);
    }

    async function connect() {
      if (stopped) return;
      const generation = ++streamGeneration;
      state = reconnectAttempt ? 'reconnecting' : 'connecting';
      lastError = null;
      nextReconnectAt = null;
      emit();

      const usage = await quotaManager.getUsage();
      if (Number(usage?.streamConnections || 0) >= STREAMLIST_DAILY_SAFETY_CAP) {
        const err = new Error(`YouTube StreamList daily safety cap (${STREAMLIST_DAILY_SAFETY_CAP}) reached. Waiting for the next Pacific quota day.`);
        err.code = 'YOUTUBE_STREAMLIST_DAILY_SAFETY_CAP';
        throw err;
      }
      const token = await authManager.getValidAccessToken();
      if (stopped || generation !== streamGeneration) return;
      await quotaManager.reserveMainUnits(1, { streamConnections: 1 });
      if (stopped || generation !== streamGeneration) return;

      const client = getClient();
      const metadata = new grpcBundle.grpc.Metadata();
      metadata.set('authorization', `Bearer ${token}`);
      const hadPageTokenAtConnect = Boolean(pageToken);
      const initialConnectionAtMs = Date.now();
      const request = {
        live_chat_id: id,
        part: ['snippet', 'authorDetails'],
        profile_image_size: 16,
        max_results: 200
      };
      if (pageToken) request.page_token = pageToken;
      const streamMethod = typeof client.StreamList === 'function' ? client.StreamList : client.streamList;
      if (typeof streamMethod !== 'function') throw new Error('YouTube StreamList gRPC method is unavailable.');

      call = streamMethod.call(client, request, metadata);
      callStartedAtMs = Date.now();
      noteConnectionStart(callStartedAtMs);
      connectionCount += 1;
      historyGate = createInitialHistoryGate({ hasContinuation: hadPageTokenAtConnect });
      state = hadPageTokenAtConnect ? 'reconnecting' : 'priming';
      emit();

      call.on('data', (response) => {
        if (stopped || generation !== streamGeneration) return;
        lastDataAt = new Date().toISOString();
        if (response?.next_page_token) pageToken = String(response.next_page_token);
        if (response?.offline_at) {
          lastError = `YouTube live chat ended at ${response.offline_at}.`;
          terminate(lastError, 'ended');
          return;
        }

        const items = Array.isArray(response?.items) ? response.items : [];
        const acceptedItems = historyGate.accept(items);

        if (!hadPageTokenAtConnect) {
          // The first StreamList response intentionally contains recent chat
          // history. Mark those IDs seen but never execute commands from them.
          if (!acceptedItems.length && items.length) {
            for (const item of items) markSeen(item?.id);
          }
          if (historyGate.isPrimed()) markConnected(generation);
          if (!acceptedItems.length && items.length) return;
        } else {
          // A reconnect is only considered CONNECTED after YouTube has actually
          // delivered the first response on the resumed stream.
          markConnected(generation);
        }

        for (const item of acceptedItems) {
          const messageId = String(item?.id || '');
          if (!markSeen(messageId)) continue;
          const snippet = item?.snippet || {};
          if (!hadPageTokenAtConnect && !isFreshMessage(snippet?.published_at, initialConnectionAtMs, 3000)) continue;
          if (Number(snippet?.type) !== 1) continue;
          const text = String(snippet?.text_message_details?.message_text || snippet?.display_message || '').trim();
          if (!text) continue;
          const authorDetails = item?.author_details || {};
          lastMessageAt = new Date().toISOString();
          emit();
          void Promise.resolve(onMessage?.({
            liveChatId: id,
            messageId,
            message: text,
            publishedAt: snippet?.published_at || null,
            author: {
              channelId: String(authorDetails?.channel_id || snippet?.author_channel_id || ''),
              displayName: String(authorDetails?.display_name || ''),
              isChatOwner: Boolean(authorDetails?.is_chat_owner),
              isChatSponsor: Boolean(authorDetails?.is_chat_sponsor),
              isChatModerator: Boolean(authorDetails?.is_chat_moderator)
            }
          })).catch((err) => console.warn(`[YouTube Chat] Message handler failed for ${id}: ${err?.message || err}`));
        }
      });

      call.on('error', (err) => {
        if (stopped || generation !== streamGeneration) return;
        call = null;
        scheduleReconnect(err);
      });
      call.on('end', () => {
        if (stopped || generation !== streamGeneration) return;
        call = null;
        scheduleReconnect('YouTube live chat stream ended unexpectedly.');
      });
    }

    function updateBroadcasts(next) {
      broadcasts = Array.isArray(next) ? next : [];
      emit();
    }

    function stop(reason = 'stopped') {
      if (stopped) return;
      const finalState = reason === 'chat-ended' ? 'ended' : 'stopped';
      terminate(reason, finalState);
    }

    async function start() {
      try {
        await connect();
      } catch (err) {
        // Initial connection failures need the same bounded retry behavior as
        // later stream drops. Keeping the worker alive matters especially when
        // startup discovery has already found both broadcasts and cancels its
        // later checkpoints.
        scheduleReconnect(err);
      }
    }

    return {
      start,
      stop,
      updateBroadcasts,
      getStatus: () => snapshot()
    };
  }

  function preflight() {
    const bundle = grpcLoader();
    if (!bundle?.grpc || typeof bundle?.Service !== 'function') {
      throw new Error('YouTube StreamList gRPC client could not be loaded.');
    }
    return { ok: true, transport: 'grpc', endpoint: 'dns:///youtube.googleapis.com:443' };
  }

  function shutdown() {
    try { sharedClient?.close?.(); } catch (_) {}
    sharedClient = null;
  }

  return { createWorker, preflight, shutdown };
}

module.exports = {
  createYouTubeChatStreamFactory,
  terminalStateFor,
  isGoogleQuotaError,
  BACKOFF_MS,
  RATE_LIMIT_BACKOFF_MS,
  STABLE_CONNECTION_RESET_MS,
  CHURN_WINDOW_MS,
  CHURN_CONNECTION_LIMIT,
  CHURN_COOLDOWN_MS,
  STREAMLIST_DAILY_SAFETY_CAP
};
