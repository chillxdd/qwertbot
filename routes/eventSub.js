const { noteEventReceived, verifyEventSubRequest } = require('../services/twitchEventSub');
const { normalizeIdentity, numberOrNull } = require('../services/sourceRecords');

function cleanInline(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}


function identityFromEvent(event = {}, prefix = 'user', role = 'viewer') {
  const key = String(prefix || 'user').replace(/_+$/g, '');
  return normalizeIdentity({
    userId: event?.[`${key}_id`] || '',
    login: event?.[`${key}_login`] || '',
    displayName: event?.[`${key}_name`] || event?.[`${key}_login`] || '',
    role
  });
}

function eventTargetIdentity(type, event = {}) {
  if (type === 'channel.raid') {
    return identityFromEvent(event, 'to_broadcaster_user', 'broadcaster');
  }
  if (event?.broadcaster_user_id || event?.broadcaster_user_login || event?.broadcaster_user_name) {
    return identityFromEvent(event, 'broadcaster_user', 'broadcaster');
  }
  return normalizeIdentity({});
}

function eventActorIdentity(type, event = {}) {
  if (type === 'channel.raid') return identityFromEvent(event, 'from_broadcaster_user', 'broadcaster');
  return identityFromEvent(event, 'user', 'viewer');
}

function buildStructuredRecapEvent(type, event = {}, text = '', options = {}) {
  const anonymous = options.anonymous === true || event?.is_anonymous === true;
  return {
    type: String(options.type || type || 'twitch_event'),
    text: cleanInline(text, 1600),
    actor: anonymous ? normalizeIdentity({}) : (options.actor || eventActorIdentity(type, event)),
    target: options.target || eventTargetIdentity(type, event),
    anonymous,
    amount: numberOrNull(options.amount),
    quantity: numberOrNull(options.quantity),
    rewardId: cleanInline(options.rewardId || event?.reward?.id || '', 160),
    metadata: {
      ...(options.metadata && typeof options.metadata === 'object' ? options.metadata : {})
    }
  };
}

function pollChoices(event = {}, includeVotes = false) {
  const choices = Array.isArray(event.choices) ? event.choices : [];
  return choices.slice(0, 8).map((choice) => {
    const title = cleanInline(choice?.title || 'Choice', 80);
    return includeVotes ? `${title}: ${Number(choice?.votes || 0)} vote(s)` : title;
  }).join('; ');
}

function predictionOutcomes(event = {}, includePoints = false) {
  const outcomes = Array.isArray(event.outcomes) ? event.outcomes : [];
  return outcomes.slice(0, 8).map((outcome) => {
    const title = cleanInline(outcome?.title || 'Outcome', 80);
    return includePoints ? `${title}: ${Number(outcome?.channel_points || 0)} point(s)` : title;
  }).join('; ');
}

function predictionWinner(event = {}) {
  const winningId = String(event?.winning_outcome_id || '');
  const outcomes = Array.isArray(event?.outcomes) ? event.outcomes : [];
  return cleanInline(outcomes.find((item) => String(item?.id || '') === winningId)?.title || '', 80);
}

const REDEMPTION_EVENT_TYPES = new Set([
  'channel.channel_points_custom_reward_redemption.add',
  'channel.channel_points_automatic_reward_redemption.add'
]);
const REDEMPTION_BURST_THRESHOLD = 3;
const REDEMPTION_BURST_WINDOW_MS = 2 * 60 * 1000;
const REDEMPTION_BURST_RESET_GAP_MS = 3 * 60 * 1000;

function redemptionRewardLabel(type, event = {}) {
  if (type === 'channel.channel_points_custom_reward_redemption.add') {
    return cleanInline(event?.reward?.title || 'a custom Channel Points reward', 120);
  }
  return cleanInline(String(event?.reward?.type || 'automatic reward').replace(/_/g, ' '), 120);
}

function createRedemptionRecapFilter({
  threshold = REDEMPTION_BURST_THRESHOLD,
  windowMs = REDEMPTION_BURST_WINDOW_MS,
  resetGapMs = REDEMPTION_BURST_RESET_GAP_MS
} = {}) {
  const bursts = new Map();

  function reset() {
    bursts.clear();
  }

  function note(type, event = {}, timestamp = Date.now()) {
    if (!REDEMPTION_EVENT_TYPES.has(type)) return null;

    const now = Number(timestamp || Date.now()) || Date.now();
    const reward = redemptionRewardLabel(type, event);
    const key = `${type}:${reward.toLowerCase()}`;
    let state = bursts.get(key);

    if (!state || now - state.lastAt > resetGapMs) {
      state = { entries: [], lastAt: now, announced: false };
    }

    state.lastAt = now;
    const userKey = String(event?.user_id || event?.user_login || event?.user_name || '').trim().toLowerCase();
    state.entries = state.entries.filter((entry) => now - entry.at <= windowMs);
    state.entries.push({ at: now, userKey });
    bursts.set(key, state);

    // Routine one-off redemptions are intentionally excluded from recap context.
    // A burst is promoted once, then remains quiet until the reward has been idle
    // long enough to count as a new burst.
    if (state.announced || state.entries.length < threshold) return null;

    state.announced = true;
    const count = state.entries.length;
    const distinctUsers = new Set(state.entries.map((entry) => entry.userKey).filter(Boolean)).size;
    const viewerText = distinctUsers > 1 ? ` by ${distinctUsers} viewers` : '';
    return buildStructuredRecapEvent(type, event,
      `Noteworthy Channel Points burst: "${reward}" was redeemed ${count} times${viewerText} within about ${Math.max(1, Math.round(windowMs / 60000))} minutes.`,
      {
        quantity: count,
        rewardId: event?.reward?.id || '',
        // This is an aggregate burst, not an attribution to the final redeemer.
        actor: normalizeIdentity({}),
        metadata: { noteworthyBurst: true, distinctUsers, reward }
      }
    );
  }

  return { note, reset };
}

const SUBSCRIPTION_EVENT_TYPES = new Set([
  'channel.subscribe',
  'channel.subscription.message',
  'channel.subscription.gift'
]);
const SUBSCRIPTION_WAVE_THRESHOLD = 5;
const SUBSCRIPTION_WAVE_WINDOW_MS = 5 * 60 * 1000;
const SUBSCRIPTION_WAVE_RESET_GAP_MS = 5 * 60 * 1000;
const LARGE_GIFT_SUB_THRESHOLD = 10;
const SIGNIFICANT_CHEER_BITS = 1000;

function subscriptionUnitCount(type, event = {}) {
  if (type === 'channel.subscribe') return event?.is_gift ? 0 : 1;
  if (type === 'channel.subscription.message') return 1;
  if (type === 'channel.subscription.gift') {
    const total = Math.floor(Number(event?.total || 0));
    return Math.max(1, Number.isFinite(total) ? total : 0);
  }
  return 0;
}

function formatLargeGiftForRecap(event = {}) {
  const total = Math.max(0, Math.floor(Number(event?.total || 0)) || 0);
  const name = cleanInline(event?.user_name || event?.user_login || 'A viewer', 80);
  const actor = event?.is_anonymous ? 'An anonymous viewer' : name;
  return `${actor} gifted ${total} subscriptions to Qwert's channel.`;
}

function createSubscriptionRecapFilter({
  waveThreshold = SUBSCRIPTION_WAVE_THRESHOLD,
  windowMs = SUBSCRIPTION_WAVE_WINDOW_MS,
  resetGapMs = SUBSCRIPTION_WAVE_RESET_GAP_MS,
  largeGiftThreshold = LARGE_GIFT_SUB_THRESHOLD
} = {}) {
  let entries = [];
  let lastAt = 0;
  let announced = false;

  function reset() {
    entries = [];
    lastAt = 0;
    announced = false;
  }

  function note(type, event = {}, timestamp = Date.now()) {
    if (!SUBSCRIPTION_EVENT_TYPES.has(type)) return null;

    const now = Number(timestamp || Date.now()) || Date.now();
    if (lastAt && now - lastAt > resetGapMs) reset();
    lastAt = now;

    const giftTotal = type === 'channel.subscription.gift'
      ? Math.max(0, Math.floor(Number(event?.total || 0)) || 0)
      : 0;

    // A genuinely large gift is useful on its own. It also owns this support
    // cluster, so the same gift cannot immediately create a duplicate generic
    // subscription-wave recap event.
    if (giftTotal >= largeGiftThreshold) {
      entries = [];
      announced = true;
      return buildStructuredRecapEvent('channel.subscription.gift', event, formatLargeGiftForRecap(event), {
        type: 'channel.subscription.gift',
        actor: event?.is_anonymous ? normalizeIdentity({}) : eventActorIdentity('channel.subscription.gift', event),
        anonymous: event?.is_anonymous === true,
        quantity: giftTotal,
        metadata: { largeGift: true }
      });
    }

    const units = subscriptionUnitCount(type, event);
    if (units <= 0) return null;

    entries = entries.filter((entry) => now - entry.at <= windowMs);
    entries.push({ at: now, units });

    const totalUnits = entries.reduce((sum, entry) => sum + entry.units, 0);
    if (announced || totalUnits < waveThreshold) return null;

    announced = true;
    return buildStructuredRecapEvent('channel.subscription.wave', {},
      `A noteworthy subscription wave reached at least ${waveThreshold} subscriptions or resubscriptions within about ${Math.max(1, Math.round(windowMs / 60000))} minutes.`,
      {
        type: 'channel.subscription.wave',
        quantity: totalUnits,
        metadata: { aggregate: true, windowMs, threshold: waveThreshold }
      }
    );
  }

  return { note, reset };
}

function goalRecapDecision(type, event = {}) {
  if (type === 'channel.goal.begin' || type === 'channel.goal.progress') return false;
  if (type === 'channel.goal.end') return event?.is_achieved === true;
  return null;
}

function shouldRecordStandaloneRecapEvent(type, event = {}) {
  const goalDecision = goalRecapDecision(type, event);
  if (goalDecision !== null) return goalDecision;

  // Subscriptions and Channel Points have their own aggregation filters. Raw
  // events must never bypass those filters and enter recap context individually.
  if (SUBSCRIPTION_EVENT_TYPES.has(type) || REDEMPTION_EVENT_TYPES.has(type)) return false;

  switch (type) {
    case 'channel.cheer':
      return Number(event?.bits || 0) >= SIGNIFICANT_CHEER_BITS;
    case 'channel.raid':
      return true;
    case 'channel.follow':
    case 'stream.online':
    case 'stream.offline':
    case 'channel.poll.begin':
    case 'channel.poll.progress':
    case 'channel.prediction.begin':
    case 'channel.prediction.progress':
    case 'channel.prediction.lock':
    case 'channel.ad_break.begin':
    case 'channel.hype_train.begin':
      return false;
    default:
      return true;
  }
}

function formatEventSubForRecap(type, event) {
  const name = event?.user_name || event?.user_login || 'A viewer';

  switch (type) {
    case 'channel.subscribe':
      if (event?.is_gift) return null;
      return `${name} subscribed to Qwert at Tier ${String(event?.tier || '1000').replace('1000', '1').replace('2000', '2').replace('3000', '3')}.`;
    case 'channel.subscription.message': {
      const months = Number(event?.cumulative_months || 0);
      const message = cleanInline(event?.message?.text || '', 300);
      return `${name} resubscribed${months ? ` for ${months} cumulative month(s)` : ''}${message ? ` and wrote: ${message}` : ''}.`;
    }
    case 'channel.subscription.gift': {
      const total = Number(event?.total || 0);
      if (event?.is_anonymous) return `An anonymous viewer gifted ${total || 'multiple'} subscription(s) to Qwert's channel.`;
      return `${name} gifted ${total || 'multiple'} subscription(s) to Qwert's channel.`;
    }
    case 'channel.cheer': {
      const bits = Number(event?.bits || 0);
      if (event?.is_anonymous) return `An anonymous viewer cheered ${bits} Bits.`;
      return `${name} cheered ${bits} Bits.`;
    }
    case 'channel.follow':
      return `${name} followed Qwert.`;
    case 'channel.raid':
      return `${event?.from_broadcaster_user_name || event?.from_broadcaster_user_login || 'A streamer'} raided Qwert with ${Number(event?.viewers || 0)} viewer(s).`;
    case 'channel.hype_train.begin':
      return `A Hype Train began at level ${event?.level ?? 1}.`;
    case 'channel.hype_train.end':
      return `The Hype Train ended at level ${event?.level ?? 'unknown'}.`;
    case 'stream.online':
      return 'Qwert went live.';
    case 'stream.offline':
      return 'Qwert went offline.';

    case 'channel.poll.begin': {
      const title = cleanInline(event?.title || 'Untitled poll', 160);
      const choices = pollChoices(event, false);
      return `A Twitch poll began: "${title}"${choices ? ` Choices: ${choices}.` : '.'}`;
    }
    case 'channel.poll.progress': {
      const title = cleanInline(event?.title || 'Untitled poll', 160);
      const choices = pollChoices(event, true);
      return `Twitch poll progress for "${title}"${choices ? `: ${choices}.` : '.'}`;
    }
    case 'channel.poll.end': {
      const title = cleanInline(event?.title || 'Untitled poll', 160);
      const choices = pollChoices(event, true);
      const status = cleanInline(event?.status || 'completed', 40);
      return `Twitch poll "${title}" ended (${status})${choices ? `. Final results: ${choices}.` : '.'}`;
    }

    case 'channel.prediction.begin': {
      const title = cleanInline(event?.title || 'Untitled prediction', 160);
      const outcomes = predictionOutcomes(event, false);
      return `A Twitch prediction began: "${title}"${outcomes ? ` Outcomes: ${outcomes}.` : '.'}`;
    }
    case 'channel.prediction.progress': {
      const title = cleanInline(event?.title || 'Untitled prediction', 160);
      const outcomes = predictionOutcomes(event, true);
      return `Twitch prediction progress for "${title}"${outcomes ? `: ${outcomes}.` : '.'}`;
    }
    case 'channel.prediction.lock': {
      const title = cleanInline(event?.title || 'Untitled prediction', 160);
      const outcomes = predictionOutcomes(event, true);
      return `Twitch prediction "${title}" was locked${outcomes ? `. Points at lock: ${outcomes}.` : '.'}`;
    }
    case 'channel.prediction.end': {
      const title = cleanInline(event?.title || 'Untitled prediction', 160);
      const status = cleanInline(event?.status || 'resolved', 40);
      const winner = predictionWinner(event);
      const outcomes = predictionOutcomes(event, true);
      return `Twitch prediction "${title}" ended (${status})${winner ? `. Winning outcome: ${winner}.` : ''}${outcomes ? ` Final points: ${outcomes}.` : ''}`;
    }

    case 'channel.channel_points_custom_reward_redemption.add': {
      const reward = cleanInline(event?.reward?.title || 'a custom Channel Points reward', 120);
      const input = cleanInline(event?.user_input || '', 260);
      const cost = Number(event?.reward?.cost || 0);
      return `${name} redeemed "${reward}"${cost ? ` for ${cost} Channel Points` : ''}${input ? ` and entered: ${input}` : ''}.`;
    }
    case 'channel.channel_points_automatic_reward_redemption.add': {
      const rewardType = cleanInline(String(event?.reward?.type || 'automatic reward').replace(/_/g, ' '), 120);
      const points = Number(event?.reward?.channel_points || event?.reward?.cost || 0);
      const message = cleanInline(event?.message?.text || event?.user_input || '', 260);
      return `${name} redeemed the automatic Channel Points reward "${rewardType}"${points ? ` for ${points} Channel Points` : ''}${message ? ` with: ${message}` : ''}.`;
    }

    case 'channel.goal.begin': {
      const description = cleanInline(event?.description || `${event?.type || 'channel'} goal`, 180);
      return `A Twitch goal began: "${description}" (${Number(event?.current_amount || 0)}/${Number(event?.target_amount || 0)}).`;
    }
    case 'channel.goal.progress': {
      const description = cleanInline(event?.description || `${event?.type || 'channel'} goal`, 180);
      return `Twitch goal progress for "${description}": ${Number(event?.current_amount || 0)}/${Number(event?.target_amount || 0)}.`;
    }
    case 'channel.goal.end': {
      const description = cleanInline(event?.description || `${event?.type || 'channel'} goal`, 180);
      return `Twitch goal "${description}" ended at ${Number(event?.current_amount || 0)}/${Number(event?.target_amount || 0)}${event?.is_achieved ? ' and was achieved.' : '.'}`;
    }

    case 'channel.ad_break.begin': {
      const duration = Number(event?.duration_seconds || 0);
      const source = event?.is_automatic ? 'automatic' : 'manual';
      return `A ${source} Twitch ad break began${duration ? ` for ${duration} second(s)` : ''}.`;
    }
    default:
      return null;
  }
}

function registerEventSubRoutes(app, { getRecapManager, getEventSubReactionManager, getPersistentPinManager }) {
  const recentMessageIds = new Map();
  const redemptionRecapFilter = createRedemptionRecapFilter();
  const subscriptionRecapFilter = createSubscriptionRecapFilter();

  function cleanupRecentIds() {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, seenAt] of recentMessageIds.entries()) {
      if (seenAt < cutoff) recentMessageIds.delete(id);
    }
  }

  app.post('/eventsub/twitch', (req, res) => {
    try {
      if (!verifyEventSubRequest(req)) {
        return res.status(403).send('Invalid EventSub signature.');
      }

      const messageType = req.get('Twitch-Eventsub-Message-Type') || '';
      const messageId = req.get('Twitch-Eventsub-Message-Id') || '';

      if (messageType === 'webhook_callback_verification') {
        return res.status(200).type('text/plain').send(String(req.body?.challenge || ''));
      }

      if (messageType === 'revocation') {
        console.warn('[EventSub] Subscription revoked:', req.body?.subscription?.type, req.body?.subscription?.status);
        return res.sendStatus(204);
      }

      if (messageType !== 'notification') return res.sendStatus(204);

      cleanupRecentIds();
      if (messageId && recentMessageIds.has(messageId)) return res.sendStatus(204);
      if (messageId) recentMessageIds.set(messageId, Date.now());

      noteEventReceived();
      const type = req.body?.subscription?.type || '';
      const event = req.body?.event || {};
      const text = formatEventSubForRecap(type, event);
      const recapManager = getRecapManager();
      const reactionManager = getEventSubReactionManager?.();
      const messageTimestamp = Date.parse(req.get('Twitch-Eventsub-Message-Timestamp') || '');
      const lifecycleTimestamp = Number.isNaN(messageTimestamp) ? Date.now() : messageTimestamp;

      if (type === 'stream.online' || type === 'stream.offline') {
        redemptionRecapFilter.reset();
        subscriptionRecapFilter.reset();
      }

      if ((type === 'stream.online' || type === 'stream.offline') && recapManager?.noteStreamLifecycleEvent) {
        void recapManager.noteStreamLifecycleEvent({ type, event, timestamp: lifecycleTimestamp }).catch((lifecycleErr) => {
          console.error('[Stream Lifecycle] EventSub lifecycle handling failed:', lifecycleErr?.message || lifecycleErr);
        });
      }

      let recapEvent = null;
      if (REDEMPTION_EVENT_TYPES.has(type)) {
        recapEvent = redemptionRecapFilter.note(type, event, lifecycleTimestamp);
      } else if (SUBSCRIPTION_EVENT_TYPES.has(type)) {
        recapEvent = subscriptionRecapFilter.note(type, event, lifecycleTimestamp);
      } else if (text && shouldRecordStandaloneRecapEvent(type, event)) {
        recapEvent = buildStructuredRecapEvent(type, event, text, {
          amount: type === 'channel.cheer' ? Number(event?.bits || 0) : null,
          quantity: type === 'channel.raid' ? Number(event?.viewers || 0) : null,
          anonymous: event?.is_anonymous === true,
          metadata: {
            isAchieved: type === 'channel.goal.end' ? event?.is_achieved === true : undefined,
            title: cleanInline(event?.title || event?.description || '', 180),
            status: cleanInline(event?.status || '', 40)
          }
        });
      }

      if (recapEvent?.text && recapManager) {
        recapManager.recordTwitchEvent({
          ...recapEvent,
          sourceEventId: messageId,
          timestamp: lifecycleTimestamp
        });
      }

      const pinManager = getPersistentPinManager?.();
      const runStreamAutomations = async () => {
        if (type === 'stream.online' && pinManager?.handleStreamOnline) {
          // Persistent Stream Pin is the highest-priority stream-start automation.
          // It intentionally ignores global Automation Spacing and does not resolve
          // until its own configured post-pin hold clears, so stream.online reactions
          // always come after the configured pinned message.
          await pinManager.handleStreamOnline({ event, timestamp: lifecycleTimestamp });
        } else if (type === 'stream.offline' && pinManager?.handleStreamOffline) {
          await pinManager.handleStreamOffline({ event, timestamp: lifecycleTimestamp });
        }

        if (reactionManager) {
          await reactionManager.handleEvent(type, event);
        }
      };

      void runStreamAutomations().catch((automationErr) => {
        console.error('[EventSub Automations] Event handling failed:', automationErr?.message || automationErr);
      });

      console.log(`[EventSub] ${type}: ${text || 'event received'}`);
      return res.sendStatus(204);
    } catch (err) {
      console.error('[EventSub] Webhook processing failed:', err.message || err);
      return res.sendStatus(500);
    }
  });
}

module.exports = {
  registerEventSubRoutes,
  formatEventSubForRecap,
  createRedemptionRecapFilter,
  createSubscriptionRecapFilter,
  goalRecapDecision,
  shouldRecordStandaloneRecapEvent,
  identityFromEvent,
  eventActorIdentity,
  eventTargetIdentity,
  buildStructuredRecapEvent,
  // Exported for lightweight regression tests.
  SUBSCRIPTION_WAVE_THRESHOLD,
  LARGE_GIFT_SUB_THRESHOLD,
  SIGNIFICANT_CHEER_BITS
};
