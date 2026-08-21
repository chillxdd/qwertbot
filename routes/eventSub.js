const { noteEventReceived, verifyEventSubRequest } = require('../services/twitchEventSub');

function formatEventSubForRecap(type, event) {
  const name = event?.user_name || event?.user_login || 'A viewer';

  switch (type) {
    case 'channel.subscribe':
      if (event?.is_gift) return null;
      return `${name} subscribed to Qwert at Tier ${String(event?.tier || '1000').replace('1000', '1').replace('2000', '2').replace('3000', '3')}.`;
    case 'channel.subscription.message': {
      const months = Number(event?.cumulative_months || 0);
      const message = String(event?.message?.text || '').trim();
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
    default:
      return null;
  }
}

function registerEventSubRoutes(app, { getRecapManager, getEventSubReactionManager }) {
  const recentMessageIds = new Map();

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

      if (text && recapManager) {
        recapManager.recordTwitchEvent({ type, text, timestamp: Date.now() });
      }

      if (reactionManager) {
        void reactionManager.handleEvent(type, event).catch((reactionErr) => {
          console.error('[EventSub Reactions] Event handling failed:', reactionErr?.message || reactionErr);
        });
      }

      console.log(`[EventSub] ${type}: ${text || 'event received'}`);
      return res.sendStatus(204);
    } catch (err) {
      console.error('[EventSub] Webhook processing failed:', err.message || err);
      return res.sendStatus(500);
    }
  });
}

module.exports = { registerEventSubRoutes };
