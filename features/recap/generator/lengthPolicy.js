'use strict';

const { normalizeChatRecords, normalizeEventRecords } = require('../../../services/sourceRecords');

const RECAP_EXPANSION_THRESHOLD = 380;
const RECAP_EXPANSION_MIN_MESSAGES = 20;
const LIGHT_CHAT_MESSAGE_THRESHOLD = 10;
const LIGHT_CHAT_EXPANSION_THRESHOLD = 300;
const LIGHT_CHAT_TARGET_MIN = 330;
const LIGHT_CHAT_ACCEPTABLE_MIN = 300;
const ACTIVE_CHAT_MESSAGE_THRESHOLD = 100;
const BUSY_CHAT_MESSAGE_THRESHOLD = 300;
const HEAVY_CHAT_MESSAGE_THRESHOLD = 600;

const ACTIVE_CHAT_EXPANSION_THRESHOLD = 410;
const ACTIVE_CHAT_TARGET_MIN = 430;
const ACTIVE_CHAT_ACCEPTABLE_MIN = 400;
const ACTIVE_CHAT_MIN_WORDS = 50;
const ACTIVE_CHAT_EDITOR_MIN_RETENTION = 0.70;

const BUSY_CHAT_EXPANSION_THRESHOLD = 430;
const BUSY_CHAT_TARGET_MIN = 450;
const BUSY_CHAT_ACCEPTABLE_MIN = 420;
const BUSY_CHAT_MIN_WORDS = 60;
const BUSY_CHAT_EDITOR_MIN_RETENTION = 0.78;

const HEAVY_CHAT_EXPANSION_THRESHOLD = 445;
const HEAVY_CHAT_TARGET_MIN = 460;
const HEAVY_CHAT_ACCEPTABLE_MIN = 435;
const HEAVY_CHAT_MIN_WORDS = 68;
const HEAVY_CHAT_EDITOR_MIN_RETENTION = 0.82;

const NORMAL_CHAT_TARGET_MIN = 400;
const NORMAL_CHAT_ACCEPTABLE_MIN = 360;
const NORMAL_CHAT_MIN_WORDS = 42;
const MAX_EXPANSION_ATTEMPTS = 2;
const MAX_FINAL_RECOVERY_ATTEMPTS = 2;

function normalizeViewerName(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

function recapSourceIdentityKey(record = {}) {
  const author = record.author || {};
  if (author.userId) return `uid:${author.userId}`;
  if (author.login) return `login:${String(author.login).toLowerCase()}`;
  const displayName = normalizeViewerName(author.displayName);
  return displayName ? `name:${displayName}` : '';
}

function getRecapSourceStats(chatRecords = [], twitchEvents = []) {
  const viewerRecords = normalizeChatRecords(chatRecords)
    .filter((record) => record.kind !== 'bot_context' && String(record.text || '').trim());
  const uniqueViewers = new Set(
    viewerRecords.map((record) => recapSourceIdentityKey(record)).filter(Boolean)
  );

  return {
    viewerMessageCount: viewerRecords.length,
    uniqueViewerCount: uniqueViewers.size,
    noteworthyEventCount: normalizeEventRecords(twitchEvents).length
  };
}

function countRecapWords(text = '') {
  const words = String(text || '').trim().match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu);
  return words ? words.length : 0;
}

function getRecapLengthPlan(chatRecords = [], twitchEvents = []) {
  const stats = getRecapSourceStats(chatRecords, twitchEvents);
  const base = {
    ...stats,
    eligible: false,
    activityLabel: 'quiet chat window',
    expansionThreshold: 0,
    targetMin: 0,
    acceptableMin: 0,
    minWords: 0,
    minDistinctMoments: 0,
    editorMinRetentionRatio: 0,
    initialAttempts: 0,
    finalRecoveryAttempts: 0
  };

  if (stats.viewerMessageCount >= HEAVY_CHAT_MESSAGE_THRESHOLD) {
    return {
      ...base,
      eligible: true,
      activityLabel: 'very high-volume chat window',
      expansionThreshold: HEAVY_CHAT_EXPANSION_THRESHOLD,
      targetMin: HEAVY_CHAT_TARGET_MIN,
      acceptableMin: HEAVY_CHAT_ACCEPTABLE_MIN,
      minWords: HEAVY_CHAT_MIN_WORDS,
      minDistinctMoments: 4,
      editorMinRetentionRatio: HEAVY_CHAT_EDITOR_MIN_RETENTION,
      initialAttempts: MAX_EXPANSION_ATTEMPTS,
      finalRecoveryAttempts: MAX_FINAL_RECOVERY_ATTEMPTS
    };
  }

  if (stats.viewerMessageCount >= BUSY_CHAT_MESSAGE_THRESHOLD) {
    return {
      ...base,
      eligible: true,
      activityLabel: 'high-volume chat window',
      expansionThreshold: BUSY_CHAT_EXPANSION_THRESHOLD,
      targetMin: BUSY_CHAT_TARGET_MIN,
      acceptableMin: BUSY_CHAT_ACCEPTABLE_MIN,
      minWords: BUSY_CHAT_MIN_WORDS,
      minDistinctMoments: 3,
      editorMinRetentionRatio: BUSY_CHAT_EDITOR_MIN_RETENTION,
      initialAttempts: MAX_EXPANSION_ATTEMPTS,
      finalRecoveryAttempts: MAX_FINAL_RECOVERY_ATTEMPTS
    };
  }

  if (stats.viewerMessageCount >= ACTIVE_CHAT_MESSAGE_THRESHOLD) {
    return {
      ...base,
      eligible: true,
      activityLabel: 'active chat window',
      expansionThreshold: ACTIVE_CHAT_EXPANSION_THRESHOLD,
      targetMin: ACTIVE_CHAT_TARGET_MIN,
      acceptableMin: ACTIVE_CHAT_ACCEPTABLE_MIN,
      minWords: ACTIVE_CHAT_MIN_WORDS,
      minDistinctMoments: 2,
      editorMinRetentionRatio: ACTIVE_CHAT_EDITOR_MIN_RETENTION,
      initialAttempts: MAX_EXPANSION_ATTEMPTS,
      finalRecoveryAttempts: MAX_FINAL_RECOVERY_ATTEMPTS
    };
  }

  if (stats.viewerMessageCount >= RECAP_EXPANSION_MIN_MESSAGES) {
    return {
      ...base,
      eligible: true,
      activityLabel: 'normal chat window',
      expansionThreshold: RECAP_EXPANSION_THRESHOLD,
      targetMin: NORMAL_CHAT_TARGET_MIN,
      acceptableMin: NORMAL_CHAT_ACCEPTABLE_MIN,
      minWords: NORMAL_CHAT_MIN_WORDS,
      minDistinctMoments: 2,
      editorMinRetentionRatio: 0,
      initialAttempts: MAX_EXPANSION_ATTEMPTS,
      finalRecoveryAttempts: MAX_FINAL_RECOVERY_ATTEMPTS
    };
  }

  if (stats.viewerMessageCount >= LIGHT_CHAT_MESSAGE_THRESHOLD) {
    return {
      ...base,
      eligible: true,
      activityLabel: 'light but usable chat window',
      expansionThreshold: LIGHT_CHAT_EXPANSION_THRESHOLD,
      targetMin: LIGHT_CHAT_TARGET_MIN,
      acceptableMin: LIGHT_CHAT_ACCEPTABLE_MIN,
      minWords: 0,
      minDistinctMoments: 1,
      editorMinRetentionRatio: 0,
      initialAttempts: 1,
      finalRecoveryAttempts: 1
    };
  }

  return base;
}

function isRecapCoverageSufficient(summary = '', lengthPlan = {}) {
  if (!lengthPlan?.eligible) return true;
  const text = String(summary || '').trim();
  if (!text) return false;
  const words = countRecapWords(text);
  return text.length >= Number(lengthPlan.acceptableMin || 0) &&
    words >= Number(lengthPlan.minWords || 0);
}

function shouldExpandRecap(summary = '', lengthPlan = {}) {
  if (!lengthPlan?.eligible) return false;
  const text = String(summary || '').trim();
  const words = countRecapWords(text);
  return text.length < Number(lengthPlan.expansionThreshold || 0) ||
    words < Number(lengthPlan.minWords || 0);
}

function formatRecapVolumeGuidance(chatRecords = [], twitchEvents = []) {
  const plan = getRecapLengthPlan(chatRecords, twitchEvents);
  const count = plan.viewerMessageCount;
  if (!plan.eligible) {
    return `SOURCE VOLUME / COVERAGE CONTEXT:\n- This window contains ${count} viewer/mod source message(s).\n- The window is quiet enough that no special coverage minimum is required. Select only genuinely worthwhile material.`;
  }

  const momentRule = plan.minDistinctMoments > 0
    ? `- When the source genuinely supports it, actively look for about ${plan.minDistinctMoments} distinct worthwhile moments/themes before deciding the recap is complete.`
    : '';

  return `SOURCE VOLUME / COVERAGE CONTEXT:\n- This window contains ${count} viewer/mod source messages from ${plan.uniqueViewerCount} distinct viewer identities.\n- Treat this as a ${plan.activityLabel}.\n${momentRule}\n- This is a coverage goal, not a quota. If most messages are filler, repetition, or one genuinely dominant topic, do not invent variety.\n- A recap under roughly ${plan.acceptableMin} characters or ${plan.minWords || 0} words is suspiciously thin for this volume and should be expanded when additional worthwhile supported material exists.`;
}

module.exports = {
  ACTIVE_CHAT_MESSAGE_THRESHOLD,
  BUSY_CHAT_MESSAGE_THRESHOLD,
  NORMAL_CHAT_TARGET_MIN,
  getRecapSourceStats,
  countRecapWords,
  getRecapLengthPlan,
  isRecapCoverageSufficient,
  shouldExpandRecap,
  formatRecapVolumeGuidance
};
