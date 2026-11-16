'use strict';

const { createHash } = require('node:crypto');
const { normalizeEventRecords } = require('./sourceRecords');

const MAX_STORED_PREDICTION_RESULTS = 24;
const MAX_PREDICTION_HISTORY = 512;

function cleanInline(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizePhrase(value) {
  return cleanInline(value, 240)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titlePolarity(title) {
  const text = normalizePhrase(title);
  if (!/\bgyms?\b|\bgym leader\b/.test(text)) return '';

  // Prefer explicit "beat/clear/win the gym" language even when the title also
  // contains a side condition such as "without losing a Pokemon".
  const positiveGymResult = /\b(?:beat|beating|defeat|defeating|clear|clearing|win|winning|take down|make it past|get past|survive)\b(?:\s+\w+){0,6}\s+\b(?:gyms?|gym leader)\b|\b(?:gyms?|gym leader)\b(?:\s+\w+){0,6}\s+\b(?:win|victory|clear|cleared|beaten|defeated)\b/;
  if (positiveGymResult.test(text)) return 'positive';

  // Be conservative with negative wording. "Lose a Pokemon in the gym" is a
  // casualty prediction, not proof that the gym itself was lost.
  const negativeGymResult = /\blose\b\s+(?:to|against)\s+(?:the\s+)?(?:next\s+)?(?:gym|gym leader)\b|\bfail(?:ing)?\b(?:\s+\w+){0,3}\s+(?:at|against|to beat|to clear|to get past|to make it past)\s+(?:the\s+)?(?:next\s+)?(?:gym|gym leader)\b|\b(?:wipe|wiping|get wiped|black out|white out)\b(?:\s+\w+){0,4}\s+(?:at|in|to|against|during)\s+(?:the\s+)?(?:next\s+)?(?:gym|gym leader)\b|\b(?:gym|gym leader)\b(?:\s+\w+){0,5}\s+\b(?:beat|defeat|wipe)\s+us\b/;
  if (negativeGymResult.test(text)) return 'negative';
  return '';
}

function directOutcomeMeaning(outcome) {
  const text = normalizePhrase(outcome);
  if (!text) return '';
  if (/^(?:win|won|victory|success|successful|beat(?: it| them| the gym)?|cleared?|made it|survived?)$/.test(text)) return 'win';
  if (/^(?:lose|lost|loss|failure|failed|fail|wipe|wiped|death|died|defeat|defeated|did not make it|didn't make it)$/.test(text)) return 'loss';
  return '';
}

function yesNoOutcome(outcome) {
  const text = normalizePhrase(outcome);
  if (/^(?:yes|yep|yeah|yea|sure|we do|we will|will|absolutely|of course)$/.test(text)) return 'yes';
  if (/^(?:no|nope|nah|we do not|we don't|we wont|we won't|won't|not happening)$/.test(text)) return 'no';
  return '';
}

function classifyGymPredictionResult(title, outcome) {
  const direct = directOutcomeMeaning(outcome);
  if (direct) return direct;
  const polarity = titlePolarity(title);
  const answer = yesNoOutcome(outcome);
  if (!polarity || !answer) return '';
  if (polarity === 'positive') return answer === 'yes' ? 'win' : 'loss';
  return answer === 'yes' ? 'loss' : 'win';
}

function parsePredictionText(text = '') {
  const value = cleanInline(text, 1600);
  let match = value.match(/Twitch prediction\s+["“]([^"”]+)["”]\s+ended[^.]*\.\s*Winning outcome:\s*([^.;]+)/i);
  if (match) return { title: cleanInline(match[1], 180), outcome: cleanInline(match[2], 100) };
  match = value.match(/Gym prediction\s+["“]([^"”]+)["”]\s+resolved as a gym (?:win|loss)\s*\(winning outcome:\s*([^;)]+)\)/i);
  if (match) return { title: cleanInline(match[1], 180), outcome: cleanInline(match[2], 100) };
  return { title: '', outcome: '' };
}

function extractPredictionResult(value = {}) {
  const event = value && typeof value === 'object' ? value : {};
  if (String(event.type || '') !== 'channel.prediction.end') return null;
  const metadata = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
  const parsed = parsePredictionText(event.text);
  const title = cleanInline(metadata.predictionTitle || metadata.title || parsed.title, 180);
  const outcome = cleanInline(metadata.winningOutcome || metadata.winner || parsed.outcome, 100);
  const status = cleanInline(metadata.status || 'resolved', 40).toLowerCase();
  if (!title || !outcome || /cancel|invalid/.test(status)) return null;
  const predictionId = cleanInline(metadata.predictionId || metadata.id || '', 160);
  const sourceEventId = cleanInline(event.sourceEventId || '', 160);
  const timestamp = Number(event.timestamp || 0) || Date.now();
  const gymResult = classifyGymPredictionResult(title, outcome);
  return {
    predictionId,
    sourceEventId,
    timestamp,
    title,
    outcome,
    status,
    gymResult
  };
}

function predictionResultKey(result = {}) {
  return cleanInline(result.predictionId || result.sourceEventId, 160) ||
    `${Number(result.timestamp || 0)}:${normalizePhrase(result.title)}:${normalizePhrase(result.outcome)}`;
}

function sanitizePredictionResults(values = [], { limit = MAX_STORED_PREDICTION_RESULTS } = {}) {
  const results = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const title = cleanInline(value?.title, 180);
    const outcome = cleanInline(value?.outcome, 100);
    if (!title || !outcome) continue;
    const result = {
      predictionId: cleanInline(value?.predictionId, 160),
      sourceEventId: cleanInline(value?.sourceEventId, 160),
      timestamp: Number(value?.timestamp || 0) || 0,
      title,
      outcome,
      status: cleanInline(value?.status || 'resolved', 40).toLowerCase(),
      gymResult: classifyGymPredictionResult(title, outcome)
    };
    if (/cancel|invalid/.test(result.status)) continue;
    const key = predictionResultKey(result);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(result);
  }
  results.sort((a, b) => a.timestamp - b.timestamp);
  return results.slice(-Math.max(1, Number(limit) || MAX_STORED_PREDICTION_RESULTS));
}

function extractPredictionResults(events = []) {
  const results = normalizeEventRecords(events).map(extractPredictionResult).filter(Boolean);
  return sanitizePredictionResults(results);
}

function storedPredictionHistory(previousRecaps = []) {
  const values = [];
  for (const recap of Array.isArray(previousRecaps) ? previousRecaps : []) {
    values.push(...sanitizePredictionResults(recap?.predictionResults || []));
  }
  return sanitizePredictionResults(values, { limit: MAX_PREDICTION_HISTORY });
}

function consecutiveTail(results = [], endingIndex = results.length - 1) {
  if (endingIndex < 0 || !results[endingIndex]?.gymResult) return { result: '', length: 0 };
  const result = results[endingIndex].gymResult;
  let length = 1;
  for (let index = endingIndex - 1; index >= 0; index -= 1) {
    if (results[index]?.gymResult !== result) break;
    length += 1;
  }
  return { result, length };
}

function numberWord(value) {
  const number = Number(value) || 0;
  const words = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  return words[number] || String(number);
}

function buildPredictionTrendEvent(currentEvents = [], previousRecaps = []) {
  const currentResults = extractPredictionResults(currentEvents).filter((result) => result.gymResult);
  if (!currentResults.length) return null;

  const priorResults = storedPredictionHistory(previousRecaps).filter((result) => result.gymResult);
  const all = sanitizePredictionResults([...priorResults, ...currentResults], { limit: MAX_PREDICTION_HISTORY })
    .filter((result) => result.gymResult);
  if (!all.length) return null;

  const latest = all[all.length - 1];
  const latestStreak = consecutiveTail(all);
  const previousTail = consecutiveTail(all, all.length - latestStreak.length - 1);
  let text = '';
  let transition = '';

  if (latestStreak.length >= 2) {
    if (latestStreak.result === 'win') {
      text = `Verified gym-prediction trend: the latest ${numberWord(latestStreak.length)} gym predictions all resolved as wins. The current result extended the gym win streak to ${latestStreak.length}.`;
    } else {
      text = `Verified gym-prediction trend: the latest ${numberWord(latestStreak.length)} gym predictions all resolved as losses. The current result extended the gym losing streak to ${latestStreak.length}.`;
    }
    transition = 'extended_streak';
  } else if (previousTail.length >= 2 && previousTail.result && previousTail.result !== latest.gymResult) {
    if (latest.gymResult === 'win') {
      text = `Verified gym-prediction trend: the current gym prediction resolved as a win, snapping a ${previousTail.length}-loss streak.`;
    } else {
      text = `Verified gym-prediction trend: the current gym prediction resolved as a loss, ending a ${previousTail.length}-win streak.`;
    }
    transition = 'snapped_streak';
  }

  if (!text) return null;
  const signature = [
    ...currentResults.map(predictionResultKey),
    latest.gymResult,
    latestStreak.length,
    previousTail.result,
    previousTail.length
  ].join('|');
  const hash = createHash('sha256').update(signature).digest('hex').slice(0, 16);
  return {
    id: 0,
    sourceEventId: `derived-gym-prediction-${hash}`,
    timestamp: latest.timestamp || Date.now(),
    type: 'derived.prediction.gym_streak',
    text,
    actor: {},
    target: {},
    anonymous: false,
    amount: null,
    quantity: null,
    rewardId: '',
    metadata: {
      derived: true,
      derivedKind: 'gym_prediction_streak',
      transition,
      gymResult: latest.gymResult,
      streakLength: latestStreak.length,
      priorStreakResult: previousTail.result,
      priorStreakLength: previousTail.length,
      currentPredictionCount: currentResults.length,
      currentSourceEventIds: currentResults.map((result) => result.sourceEventId).filter(Boolean)
    }
  };
}

function withPredictionTrendEvent(currentEvents = [], previousRecaps = []) {
  const events = normalizeEventRecords(currentEvents)
    .filter((event) => event.type !== 'derived.prediction.gym_streak');
  const derived = buildPredictionTrendEvent(events, previousRecaps);
  if (!derived) return events;

  // Once an exact streak interpretation exists, remove the raw gym prediction
  // rows that produced it. This prevents the recap model from choosing a bare
  // "Yes/No" telemetry sentence instead of the more useful verified trend.
  const withoutRawGymResults = events.filter((event) => {
    const result = extractPredictionResult(event);
    return !(result && result.gymResult);
  });
  return [...withoutRawGymResults, derived];
}

function buildPredictionEventMetadata(event = {}) {
  const outcomes = (Array.isArray(event?.outcomes) ? event.outcomes : []).slice(0, 8).map((outcome) => ({
    id: cleanInline(outcome?.id, 160),
    title: cleanInline(outcome?.title, 100),
    channelPoints: Number(outcome?.channel_points || 0) || 0
  }));
  const winningId = cleanInline(event?.winning_outcome_id, 160);
  const winningOutcome = cleanInline(outcomes.find((outcome) => outcome.id === winningId)?.title, 100);
  const predictionTitle = cleanInline(event?.title, 180);
  return {
    predictionId: cleanInline(event?.id, 160),
    predictionTitle,
    winningOutcome,
    outcomes,
    gymResult: classifyGymPredictionResult(predictionTitle, winningOutcome)
  };
}

module.exports = {
  MAX_STORED_PREDICTION_RESULTS,
  MAX_PREDICTION_HISTORY,
  normalizePhrase,
  classifyGymPredictionResult,
  extractPredictionResult,
  extractPredictionResults,
  sanitizePredictionResults,
  storedPredictionHistory,
  buildPredictionTrendEvent,
  withPredictionTrendEvent,
  buildPredictionEventMetadata
};
