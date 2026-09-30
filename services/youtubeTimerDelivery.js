'use strict';
const delivery = require('./reliability/delivery');
const context = require('./reliability/context');

// Each destination has its own receipt. A retry of a partially delivered timer
// skips confirmed destinations; uncertainty is reviewed, never blindly resent.
async function deliverTimerFanout({ text, deliveryKey, timerDelivery, isTarget, sendNow }) {
  const ids = [...new Set(timerDelivery?.targetIds || [])];
  if (!ids.length) throw Object.assign(new Error('No active YouTube chats for this timer.'), { deliveryState: 'NOT_SENT' });
  let delivered = 0;
  let skipped = 0;
  for (const liveChatId of ids) {
    await context.assertOperation();
    if (!isTarget(liveChatId)) { skipped++; continue; }
    try {
      await delivery.deliver({ key: `${deliveryKey}:chat:${liveChatId}`, kind: 'youtube-timer-chat',
        payload: { rendered: text, streamId: timerDelivery.streamId, channelName: timerDelivery.channelName, liveChatId },
        send: async (saved) => {
          if (!isTarget(saved.liveChatId)) throw Object.assign(new Error('YouTube destination is no longer live.'), { deliveryState: 'NOT_SENT' });
          return sendNow(saved.liveChatId, saved.rendered, { kind: 'timer', confirmedTimer: true });
        }
      });
      delivered++;
    } catch (err) {
      if (err.deliveryState === 'NOT_SENT') {
        err.message = `YouTube timer delivered to ${delivered}/${ids.length} chat(s); retry only unfinished destinations: ${err.message}`;
      }
      throw err;
    }
  }
  if (!delivered) throw Object.assign(new Error('No current YouTube destinations accepted this timer.'), { deliveryState: 'NOT_SENT', timerSelectionBlocked: true });
  return { sentCount: delivered, skippedCount: skipped, queuedCount: 0 };
}
module.exports = { deliverTimerFanout };

// Closing the aggregate occurrence also closes its destination review rows.
// A review preserves confirmed receipts and only resolves uncertain children.
async function reviewTimerDestinations(key, payload, outcome = 'dismiss') {
  for (const id of [...new Set(payload?.targetIds || [])]) {
    const childKey = `${key}:chat:${id}`;
    const row = await delivery.get(childKey);
    if (!row || row.recoveryClosed) continue;
    if (outcome === 'dismiss') await delivery.dismiss(childKey, { reason: 'Parent timer occurrence dismissed; do not resend.' });
    else if (['sending', 'unknown'].includes(row.state)) await delivery.resolve(childKey, outcome);
  }
}
module.exports.reviewTimerDestinations = reviewTimerDestinations;
