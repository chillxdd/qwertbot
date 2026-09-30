'use strict';

const delivery = require('../services/reliability/delivery');
const { collection } = require('../services/reliability/store');

function registerReliabilityRoutes(app, options) {
  const {
    requireModSession,
    channelName,
    getRuntime,
    getChatTimerManager,
    getYouTubeTimerManager = () => null,
    getRecapManager,
    getPersistentPinManager,
    getEventSubInbox,
    reconcileRecovery = async () => {}
  } = options;

  const safe = (handler) => (req, res) => Promise.resolve().then(() => handler(req, res)).catch((err) => {
    if (res.headersSent) return;
    res.status(err.persistenceFailure ? 503 : 409).json({ success: false, error: err.message || 'Recovery request failed. Refresh its status.' });
  });
  app.get('/reliability/status', requireModSession, safe(async (req, res) => {
    const runtime = getRuntime();
    const state = runtime.status();
    if (!state.ready) return res.json({ success: true, runtime: state, review: [] });
    await reconcileRecovery();
    const chatTimerManager = getChatTimerManager();
    const recapManager = getRecapManager();
    const persistentPinManager = getPersistentPinManager();
    const timers = [...(await chatTimerManager.listTimers()).map((x) => ({ ...x, platform: 'twitch' })),
      ...((await getYouTubeTimerManager()?.listTimers()) || []).map((x) => ({ ...x, platform: 'youtube' }))];
    const recap = recapManager.getStatus();
    const pin = persistentPinManager.getConfig();
    const pendingKeys = [recap.recoveryDeliveryKey,
      ...timers.filter((item) => item.recoveryRequired).map((item) => item.deliveryKey),
      pin.recoveryRequired ? pin.deliveryKey : ''].filter(Boolean);
    const rows = await collection().find({ namespace: channelName, recoveryClosed: { $ne: true }, $or: [
      { kind: 'event', state: { $in: ['review', 'failed'] } },
      { kind: 'delivery', state: { $in: ['unknown', 'sending'] } },
      { kind: 'delivery', key: { $in: pendingKeys } }
    ] }, { maxTimeMS: 5000 }).sort({ createdAt: -1 }).limit(100).toArray();
    const eventKeys = new Set(rows.filter((row) => row.kind === 'event' && row.deliveryKey).map((row) => row.deliveryKey));
    const review = [];
    for (const row of rows) {
      if (row.kind === 'event') {
        if (row.deliveryKey && delivery.isInFlight(row.deliveryKey)) continue;
        review.push({ target: 'event', id: row.messageId, deliveryKey: row.deliveryKey || '', state: row.state,
          title: `Twitch event: ${row.payload?.type || 'notification'}`, detail: row.lastError || '',
          createdAt: row.createdAt, retryOnly: row.state === 'failed' });
        continue;
      }
      if (delivery.isInFlight(row.key) || eventKeys.has(row.key)) continue;
      // Destination receipts are handled through their parent timer review.
      if (row.deliveryKind === 'youtube-timer-chat' && timers.some((t) => t.recoveryRequired && t.deliveryKey && row.key.startsWith(t.deliveryKey + ':chat:'))) continue;
      const timer = timers.find((item) => item.deliveryKey === row.key);
      const isRecap = recap.recoveryDeliveryKey === row.key;
      const isPin = pin.deliveryKey === row.key && pin.recoveryRequired;
      review.push({ target: isRecap ? 'recap' : timer ? (timer.platform === 'youtube' ? 'youtube-timer' : 'timer') : isPin ? 'pin' : 'delivery',
        id: timer ? timer.id : row.key, deliveryKey: row.key, state: row.state,
        title: isRecap ? 'Hourly recap' : timer ? `${timer.platform === 'youtube' ? 'YouTube' : 'Twitch'} timer: ${timer.name}` : isPin ? 'Rotating pinned banner' : row.deliveryKind,
        detail: timer?.platform === 'youtube' ? `YouTube timer delivery needs review across ${(row.payload?.targetIds || []).length} destination(s). Check the target chats. ${row.lastError || ''}` : row.lastError || 'The platform may have received this action before its acknowledgement was saved.',
        preview: String(row.payload?.message || row.payload?.rendered || row.payload?.content || '').slice(0, 500), createdAt: row.createdAt });
    }
    res.json({ success: true, runtime: state, review });
  }));

  app.post('/reliability/resolve', requireModSession, safe(async (req, res) => {
    const { target, id, outcome, expectedDeliveryKey } = req.body;
    if (typeof expectedDeliveryKey !== 'string' || !expectedDeliveryKey ||
        (['recap', 'pin', 'delivery'].includes(target) && id !== expectedDeliveryKey)) {
      return res.status(409).json({ success: false, error: 'Refresh the recovery panel before reviewing this exact delivery.' });
    }
    if (!['sent', 'not_sent'].includes(outcome) || req.body.confirmed !== true) {
      return res.status(400).json({ success: false, error: 'Confirm whether the message was sent or definitely not sent.' });
    }
    const chatTimerManager = getChatTimerManager();
    const recapManager = getRecapManager();
    const persistentPinManager = getPersistentPinManager();
    const eventSubInbox = getEventSubInbox();
    let result;
    if (target === 'recap') result = await recapManager.resolveDeliveryReview(outcome, expectedDeliveryKey);
    else if (target === 'youtube-timer') result = await getYouTubeTimerManager().resolveReview(id, outcome, expectedDeliveryKey);
    else if (target === 'timer') result = await chatTimerManager.resolveReview(id, outcome, expectedDeliveryKey);
    else if (target === 'pin') result = await persistentPinManager.resolveReview(outcome, expectedDeliveryKey);
    else if (target === 'event') {
      await eventSubInbox.resolveReview(id, outcome, expectedDeliveryKey);
      result = { success: true, message: 'Event receipt resolved. Remaining unfinished actions will resume.' };
    } else if (target === 'delivery') {
      const row = await delivery.get(id);
      if (!row || row.namespace !== channelName) return res.status(404).json({ success: false, error: 'Delivery record not found for this channel.' });
      const saved = await delivery.resolve(id, outcome);
      result = { success: Boolean(saved), message: 'Receipt reviewed. No standalone message was automatically restarted.' };
    } else {
      return res.status(400).json({ success: false, error: 'Invalid recovery target.' });
    }
    if (result?.success === false) return res.status(409).json({ success: false, error: result.message || 'The operation changed; refresh its status.' });
    res.json({ success: true, message: result?.message || 'Delivery reviewed. Refresh the affected control before continuing.', result });
  }));

  app.post('/reliability/dismiss', requireModSession, safe(async (req, res) => {
    const { target, id, expectedDeliveryKey, confirmed } = req.body;
    if (confirmed !== true || typeof id !== 'string' || !id || id.length > 1500 || typeof expectedDeliveryKey !== 'string') {
      return res.status(400).json({ success: false, error: 'Explicit confirmation and an exact recovery item are required.' });
    }
    if (target !== 'event' && (!expectedDeliveryKey || (['recap', 'pin', 'delivery'].includes(target) && id !== expectedDeliveryKey))) {
      return res.status(409).json({ success: false, error: 'This recovery item changed. Refresh before dismissing it.' });
    }
    let result;
    if (target === 'event') result = await getEventSubInbox().dismiss(id, expectedDeliveryKey);
    else if (target === 'recap') result = await getRecapManager().dismissDeliveryReview(expectedDeliveryKey);
    else if (target === 'youtube-timer') result = await getYouTubeTimerManager().dismissReview(id, expectedDeliveryKey);
    else if (target === 'timer') result = await getChatTimerManager().dismissReview(id, expectedDeliveryKey);
    else if (target === 'pin') result = await getPersistentPinManager().dismissReview(expectedDeliveryKey);
    else if (target === 'delivery') {
      const row = await delivery.get(expectedDeliveryKey);
      if (!row || row.namespace !== channelName) return res.status(404).json({ success: false, error: 'Delivery not found for this channel.' });
      const saved = await delivery.dismiss(expectedDeliveryKey);
      result = { success: Boolean(saved), message: 'Delivery dismissed. It was not resent or marked as delivered.' };
    } else return res.status(400).json({ success: false, error: 'Invalid recovery target.' });
    if (result?.success === false) return res.status(409).json({ success: false, error: result.message || 'Recovery item changed. Refresh its status.' });
    return res.json({ success: true, message: result?.message || 'Dismissed without retrying.' });
  }));

  app.post('/reliability/retry-event', requireModSession, safe(async (req, res) => {
    if (req.body.confirmed !== true) return res.status(400).json({ success: false, error: 'Explicit confirmation is required.' });
    await getEventSubInbox().retryFailed(req.body.id);
    res.json({ success: true, message: 'Failed event requeued. Completed action steps will not be repeated.' });
  }));
}

module.exports = { registerReliabilityRoutes };
