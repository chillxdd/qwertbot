'use strict';

const YouTubeQuotaUsage = require('../models/YouTubeQuotaUsage');
const { YOUTUBE_DEFAULT_MAIN_DAILY_LIMIT, YOUTUBE_SEARCH_DAILY_LIMIT } = require('../config/youtube');

function pacificDayKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function createYouTubeQuotaManager({ projectKey = 'youtube' } = {}) {
  let cached = null;
  let mainDailyLimitUnits = YOUTUBE_DEFAULT_MAIN_DAILY_LIMIT;

  function normalizePositiveInteger(value, fallback) {
    const parsed = Math.floor(Number(value));
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  function setLimits({ mainLimit } = {}) {
    mainDailyLimitUnits = normalizePositiveInteger(mainLimit, mainDailyLimitUnits);
    if (cached) cached = { ...cached, mainLimit: mainDailyLimitUnits };
    return { mainLimit: mainDailyLimitUnits, searchLimit: YOUTUBE_SEARCH_DAILY_LIMIT };
  }

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
      viewerCountCalls: Number(doc?.viewerCountCalls || 0),
      googleQuotaExhaustedAt: doc?.googleQuotaExhaustedAt ? new Date(doc.googleQuotaExhaustedAt).toISOString() : null,
      googleQuotaError: String(doc?.googleQuotaError || ''),
      mainLimit: mainDailyLimitUnits,
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
    const current = await getUsage();
    if (current.googleQuotaExhaustedAt) {
      const err = new Error(`Google reports the YouTube API quota exhausted for ${current.dayKey} (Pacific Time).`);
      err.code = 'GOOGLE_YOUTUBE_QUOTA_EXHAUSTED';
      throw err;
    }
    const amount = Math.max(0, Math.floor(Number(units || 0)));
    if (!amount) return getUsage();
    const dayKey = pacificDayKey();
    const limit = normalizePositiveInteger(options.limit, mainDailyLimitUnits);
    const inc = { mainUnits: amount };
    for (const [key, value] of Object.entries(counters || {})) {
      if (['commandMessages', 'timerMessages', 'discoveryCalls', 'streamConnections', 'authCalls', 'viewerCountCalls'].includes(key)) {
        inc[key] = Math.max(0, Math.floor(Number(value || 0)));
      }
    }
    const query = { projectKey, dayKey, mainUnits: { $lte: limit - amount } };
    const update = { $setOnInsert: { projectKey, dayKey }, $inc: inc };
    try {
      let doc;
      try {
        doc = await YouTubeQuotaUsage.findOneAndUpdate(
          query, update, { upsert: true, new: true, setDefaultsOnInsert: true }
        ).lean();
      } catch (err) {
        if (err?.code !== 11000) throw err;
        // Another request created today's row at the same instant. Retry
        // against the now-existing row instead of treating that benign race as
        // quota exhaustion.
        doc = await YouTubeQuotaUsage.findOneAndUpdate(
          query, { $inc: inc }, { upsert: false, new: true }
        ).lean();
      }
      if (!doc) throw new Error(`YouTube daily API safety budget would exceed ${limit} units.`);
      cached = normalize(doc, dayKey);
      return { ...cached };
    } catch (err) {
      throw err;
    }
  }


  async function reserveStreamConnection({ dailySafetyCap = 200, estimatedMainUnits = 1 } = {}) {
    const current = await getUsage();
    if (current.googleQuotaExhaustedAt) {
      const err = new Error(`Google reports the YouTube API quota exhausted for ${current.dayKey} (Pacific Time).`);
      err.code = 'GOOGLE_YOUTUBE_QUOTA_EXHAUSTED';
      throw err;
    }
    const cap = normalizePositiveInteger(dailySafetyCap, 200);
    const amount = normalizePositiveInteger(estimatedMainUnits, 1);
    const dayKey = pacificDayKey();
    const limit = mainDailyLimitUnits;
    const query = {
      projectKey,
      dayKey,
      mainUnits: { $lte: limit - amount },
      streamConnections: { $lt: cap }
    };
    const update = {
      $setOnInsert: { projectKey, dayKey },
      $inc: { mainUnits: amount, streamConnections: 1 }
    };
    try {
      let doc;
      try {
        doc = await YouTubeQuotaUsage.findOneAndUpdate(
          query, update, { upsert: true, new: true, setDefaultsOnInsert: true }
        ).lean();
      } catch (err) {
        if (err?.code !== 11000) throw err;
        doc = await YouTubeQuotaUsage.findOneAndUpdate(
          query, { $inc: { mainUnits: amount, streamConnections: 1 } }, { upsert: false, new: true }
        ).lean();
      }
      if (!doc) {
        const fresh = await getUsage({ fresh: true });
        if (Number(fresh.streamConnections || 0) >= cap) {
          const capErr = new Error(`YouTube StreamList daily safety cap (${cap}) reached. Waiting for the next Pacific quota day.`);
          capErr.code = 'YOUTUBE_STREAMLIST_DAILY_SAFETY_CAP';
          throw capErr;
        }
        throw new Error(`YouTube daily API safety budget would exceed ${limit} units.`);
      }
      cached = normalize(doc, dayKey);
      return { ...cached };
    } catch (err) {
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
    const query = { projectKey, dayKey, searchCalls: { $lt: limit } };
    const update = { $setOnInsert: { projectKey, dayKey }, $inc: inc };
    let doc;
    try {
      doc = await YouTubeQuotaUsage.findOneAndUpdate(
        query, update, { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();
    } catch (err) {
      if (err?.code !== 11000) throw err;
      doc = await YouTubeQuotaUsage.findOneAndUpdate(
        query, { $inc: inc }, { upsert: false, new: true }
      ).lean();
    }
    if (!doc) throw new Error(`YouTube daily search safety budget would exceed ${limit} calls.`);
    cached = normalize(doc, dayKey);
    return { ...cached };
  }


  async function markGoogleQuotaExceeded(error) {
    const dayKey = pacificDayKey();
    const message = String(error?.message || error || 'Google reported YouTube API quota exhausted.').replace(/<[^>]+>/g, '').slice(0, 1000);
    const doc = await YouTubeQuotaUsage.findOneAndUpdate(
      { projectKey, dayKey },
      {
        $setOnInsert: { projectKey, dayKey },
        $set: { googleQuotaExhaustedAt: new Date(), googleQuotaError: message }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    cached = normalize(doc, dayKey);
    return { ...cached };
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

  return { getUsage, reserveMainUnits, reserveStreamConnection, reserveSearchCall, noteAuthCall, markGoogleQuotaExceeded, setLimits, pacificDayKey };
}

module.exports = { createYouTubeQuotaManager, pacificDayKey };
