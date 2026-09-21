'use strict';

const YouTubeQuotaUsage = require('../models/YouTubeQuotaUsage');
const { YOUTUBE_MAIN_DAILY_LIMIT, YOUTUBE_SEARCH_DAILY_LIMIT } = require('../config/youtube');

function pacificDayKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function createYouTubeQuotaManager({ projectKey = 'youtube' } = {}) {
  let cached = null;

  function normalize(doc, dayKey = pacificDayKey()) {
    return {
      dayKey,
      mainUnits: Number(doc?.mainUnits || 0),
      searchCalls: Number(doc?.searchCalls || 0),
      commandMessages: Number(doc?.commandMessages || 0),
      timerMessages: Number(doc?.timerMessages || 0),
      discoveryCalls: Number(doc?.discoveryCalls || 0),
      streamConnections: Number(doc?.streamConnections || 0),
      authCalls: Number(doc?.authCalls || 0),
      mainLimit: YOUTUBE_MAIN_DAILY_LIMIT,
      searchLimit: YOUTUBE_SEARCH_DAILY_LIMIT
    };
  }

  async function getUsage({ fresh = false } = {}) {
    const dayKey = pacificDayKey();
    if (!fresh && cached?.dayKey === dayKey) return { ...cached };
    const doc = await YouTubeQuotaUsage.findOne({ projectKey, dayKey }).lean();
    cached = normalize(doc, dayKey);
    return { ...cached };
  }

  async function reserveMainUnits(units, counters = {}, options = {}) {
    const amount = Math.max(0, Math.floor(Number(units || 0)));
    if (!amount) return getUsage();
    const dayKey = pacificDayKey();
    const limit = Math.min(YOUTUBE_MAIN_DAILY_LIMIT, Math.max(1, Math.floor(Number(options.limit || YOUTUBE_MAIN_DAILY_LIMIT))));
    const inc = { mainUnits: amount };
    for (const [key, value] of Object.entries(counters || {})) {
      if (['commandMessages', 'timerMessages', 'discoveryCalls', 'streamConnections', 'authCalls'].includes(key)) {
        inc[key] = Math.max(0, Math.floor(Number(value || 0)));
      }
    }
    try {
      const doc = await YouTubeQuotaUsage.findOneAndUpdate(
        { projectKey, dayKey, mainUnits: { $lte: limit - amount } },
        { $setOnInsert: { projectKey, dayKey }, $inc: inc },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();
      if (!doc) throw new Error(`YouTube daily API safety budget would exceed ${limit} units.`);
      cached = normalize(doc, dayKey);
      return { ...cached };
    } catch (err) {
      if (err?.code === 11000) throw new Error(`YouTube daily API safety budget would exceed ${limit} units.`);
      throw err;
    }
  }

  async function reserveSearchCall(counters = {}, options = {}) {
    const dayKey = pacificDayKey();
    const limit = Math.min(YOUTUBE_SEARCH_DAILY_LIMIT, Math.max(1, Math.floor(Number(options.limit || YOUTUBE_SEARCH_DAILY_LIMIT))));
    const inc = { searchCalls: 1 };
    for (const [key, value] of Object.entries(counters || {})) {
      if (['discoveryCalls', 'authCalls'].includes(key)) inc[key] = Math.max(0, Math.floor(Number(value || 0)));
    }
    try {
      const doc = await YouTubeQuotaUsage.findOneAndUpdate(
        { projectKey, dayKey, searchCalls: { $lt: limit } },
        { $setOnInsert: { projectKey, dayKey }, $inc: inc },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();
      if (!doc) throw new Error(`YouTube daily search safety budget would exceed ${limit} calls.`);
      cached = normalize(doc, dayKey);
      return { ...cached };
    } catch (err) {
      if (err?.code === 11000) throw new Error(`YouTube daily search safety budget would exceed ${limit} calls.`);
      throw err;
    }
  }

  async function noteAuthCall() {
    const dayKey = pacificDayKey();
    const doc = await YouTubeQuotaUsage.findOneAndUpdate(
      { projectKey, dayKey },
      { $setOnInsert: { projectKey, dayKey }, $inc: { authCalls: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    cached = normalize(doc, dayKey);
  }

  return { getUsage, reserveMainUnits, reserveSearchCall, noteAuthCall, pacificDayKey };
}

module.exports = { createYouTubeQuotaManager, pacificDayKey };
