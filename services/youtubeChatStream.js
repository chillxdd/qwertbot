'use strict';

const path = require('node:path');
const { createInitialHistoryGate, isFreshMessage } = require('../features/youtube/pure');

const MAX_SEEN_IDS = 4000;
const BACKOFF_MS = [2000, 5000, 10000, 30000];

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
    let pageToken = '';
    let reconnectAttempt = 0;
    let streamGeneration = 0;
    const seenIds = new Set();
    const seenQueue = [];
    let state = 'idle';
    let lastMessageAt = null;
    let lastError = null;
    let historyGate = createInitialHistoryGate();

    function snapshot(extra = {}) {
      return {
        liveChatId: id,
        state,
        broadcasts,
        lastMessageAt,
        lastError,
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

    function scheduleReconnect(reason) {
      if (stopped || reconnectTimer) return;
      state = 'reconnecting';
      lastError = reason ? String(reason?.message || reason) : null;
      emit();
      const delay = BACKOFF_MS[Math.min(reconnectAttempt, BACKOFF_MS.length - 1)];
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect().catch((err) => scheduleReconnect(err));
      }, delay);
    }

    async function connect() {
      if (stopped) return;
      const generation = ++streamGeneration;
      state = reconnectAttempt ? 'reconnecting' : 'connecting';
      lastError = null;
      emit();
      const token = await authManager.getValidAccessToken();
      if (stopped || generation !== streamGeneration) return;
      await quotaManager.reserveMainUnits(1, { streamConnections: 1 });
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
      historyGate = createInitialHistoryGate({ hasContinuation: hadPageTokenAtConnect });
      state = hadPageTokenAtConnect ? 'connected' : 'priming';
      reconnectAttempt = 0;
      emit();

      call.on('data', (response) => {
        if (stopped || generation !== streamGeneration) return;
        if (response?.next_page_token) pageToken = String(response.next_page_token);
        if (response?.offline_at) {
          state = 'ended';
          emit({ offlineAt: response.offline_at });
          stop('chat-ended');
          return;
        }
        const items = Array.isArray(response?.items) ? response.items : [];
        const acceptedItems = historyGate.accept(items);
        if (!acceptedItems.length && items.length && !hadPageTokenAtConnect) {
          // The first StreamList response intentionally contains recent chat
          // history. Mark those IDs seen but never execute commands from them.
          // Only advertise CONNECTED after that history snapshot is discarded.
          for (const item of items) markSeen(item?.id);
          state = 'connected';
          emit();
          return;
        }
        if (state === 'priming' && historyGate.isPrimed()) { state = 'connected'; emit(); }
        for (const item of acceptedItems) {
          const messageId = String(item?.id || '');
          if (!markSeen(messageId)) continue;
          const snippet = item?.snippet || {};
          // On the very first connection, StreamList can include recent chat
          // history. The first response is already discarded above; this
          // timestamp guard also protects us if historical items are ever split
          // across multiple streamed responses. Reconnects with a continuation
          // token intentionally accept missed messages.
          if (!hadPageTokenAtConnect && !isFreshMessage(snippet?.published_at, initialConnectionAtMs, 3000)) continue;
          // Enum value 1 is TEXT_MESSAGE_EVENT in our minimal official proto.
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
      stopped = true;
      state = reason === 'chat-ended' ? 'ended' : 'stopped';
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      ++streamGeneration;
      try { call?.cancel?.(); } catch (_) {}
      call = null;
      emit({ reason });
    }

    return {
      start: () => connect(),
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

module.exports = { createYouTubeChatStreamFactory };
