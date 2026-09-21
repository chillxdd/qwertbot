'use strict';

const {
  YOUTUBE_BROADCASTER_CHANNEL_ID,
  YOUTUBE_BROADCASTER_HANDLE,
  YOUTUBE_LIST_COST
} = require('../config/youtube');
const { dedupeBroadcastChats } = require('../features/youtube/pure');

function createYouTubeDiscovery({ authManager, quotaManager }) {
  let resolvedChannelId = YOUTUBE_BROADCASTER_CHANNEL_ID || '';

  async function fetchJson(url, accessToken) {
    const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || `YouTube API request failed (${response.status}).`);
    return data;
  }

  async function getBroadcasterChannelId() {
    if (resolvedChannelId) return resolvedChannelId;
    if (!YOUTUBE_BROADCASTER_HANDLE) throw new Error('Set YOUTUBE_BROADCASTER_CHANNEL_ID or YOUTUBE_BROADCASTER_HANDLE.');
    const token = await authManager.getValidAccessToken();
    await quotaManager.reserveMainUnits(YOUTUBE_LIST_COST, { discoveryCalls: 1 });
    const params = new URLSearchParams({ part: 'id,snippet', forHandle: YOUTUBE_BROADCASTER_HANDLE, maxResults: '1' });
    const data = await fetchJson(`https://www.googleapis.com/youtube/v3/channels?${params.toString()}`, token);
    const id = String(data.items?.[0]?.id || '');
    if (!id) throw new Error(`Could not resolve YouTube broadcaster @${YOUTUBE_BROADCASTER_HANDLE}.`);
    resolvedChannelId = id;
    return id;
  }

  async function verifyBroadcaster() {
    const channelId = await getBroadcasterChannelId();
    const token = await authManager.getValidAccessToken();
    await quotaManager.reserveMainUnits(YOUTUBE_LIST_COST, { discoveryCalls: 1 });
    const params = new URLSearchParams({ part: 'id,snippet', id: channelId, maxResults: '1' });
    const data = await fetchJson(`https://www.googleapis.com/youtube/v3/channels?${params.toString()}`, token);
    const channel = Array.isArray(data.items) ? data.items.find((item) => String(item?.id || '') === channelId) : null;
    if (!channel) throw new Error(`Could not verify the configured YouTube broadcaster channel (${channelId}).`);
    return {
      channelId,
      displayName: String(channel?.snippet?.title || ''),
      customUrl: String(channel?.snippet?.customUrl || '') || null
    };
  }

  async function discoverActiveBroadcasts({ searchSafetyStopCalls = 90 } = {}) {
    const channelId = await getBroadcasterChannelId();
    const current = await quotaManager.getUsage();
    if (current.searchCalls >= Math.min(100, Math.max(1, Number(searchSafetyStopCalls || 90)))) {
      throw new Error(`YouTube search safety limit reached (${current.searchCalls} calls today).`);
    }
    const token = await authManager.getValidAccessToken();
    await quotaManager.reserveSearchCall({ discoveryCalls: 1 }, { limit: Math.min(100, Math.max(1, Number(searchSafetyStopCalls || 90))) });
    const searchParams = new URLSearchParams({
      part: 'snippet', channelId, eventType: 'live', type: 'video', maxResults: '10'
    });
    const searchData = await fetchJson(`https://www.googleapis.com/youtube/v3/search?${searchParams.toString()}`, token);
    const ids = [...new Set((searchData.items || []).map((item) => String(item?.id?.videoId || '')).filter(Boolean))];
    if (!ids.length) return { channelId, broadcasts: [], chats: [] };

    await quotaManager.reserveMainUnits(YOUTUBE_LIST_COST, { discoveryCalls: 1 });
    const videoParams = new URLSearchParams({ part: 'snippet,liveStreamingDetails', id: ids.join(',') });
    const videoData = await fetchJson(`https://www.googleapis.com/youtube/v3/videos?${videoParams.toString()}`, token);
    const broadcasts = (videoData.items || []).map((item) => ({
      videoId: String(item?.id || ''),
      title: String(item?.snippet?.title || ''),
      liveChatId: String(item?.liveStreamingDetails?.activeLiveChatId || ''),
      actualStartTime: item?.liveStreamingDetails?.actualStartTime || null
    })).filter((item) => item.videoId && item.liveChatId);
    return { channelId, broadcasts, chats: dedupeBroadcastChats(broadcasts) };
  }

  function getConfiguredBroadcaster() {
    return { channelId: resolvedChannelId || null, handle: YOUTUBE_BROADCASTER_HANDLE || null };
  }

  return { discoverActiveBroadcasts, verifyBroadcaster, getBroadcasterChannelId, getConfiguredBroadcaster };
}

module.exports = { createYouTubeDiscovery };
