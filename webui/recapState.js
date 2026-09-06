// Pure presentation rules; covered by the reliability tests as well as the UI.
export function deriveRecapPresentation(data = {}, now = Date.now()) {
  const bot = data.bot || {};
  const live = data.qwert?.live === true;
  const known = data.qwert?.statusKnown === true;
  const runtime = data.runtime || { ready: data.database?.connected !== false, state: 'ACTIVE' };
  const ready = runtime.ready === true;
  const paused = bot.recapPaused === true;
  const stopped = bot.recapSystemStopped === true;
  const count = Number(bot.messagesInWindow || 0) + Number(bot.twitchEventsInWindow || 0);
  const seconds = (ms) => Math.max(0, Math.ceil(Number(ms || 0) / 1000));
  const remaining = seconds(Number(bot.nextRecapAt || 0) - now);
  let state = !known ? 'CHECKING' : !live ? 'OFFLINE' : bot.recoveryRequired ? 'REVIEW NEEDED' :
    stopped ? 'STOPPED' : bot.recapInProgress ? 'GENERATING' : paused ? 'PAUSED' : 'RUNNING';
  let collection = !live ? 'IDLE' : bot.collectionPaused ? 'PAUSED' : 'ACTIVE';
  let next = !live ? '\u2014' : paused ? 'PAUSED' : bot.recapInProgress ? '\u2014' : bot.nextRecapAt
    ? `${Math.floor(remaining / 60)}min ${remaining % 60}s` : '\u2014';
  let notice = bot.recoveryReason || '';
  if (!ready) {
    state = runtime.state || 'UNAVAILABLE';
    collection = 'PAUSED';
    next = 'PAUSED';
    notice = runtime.state === 'STANDBY'
      ? 'This deployment is waiting for the active bot to hand over. No automated work or control changes will run here yet.'
      : runtime.state === 'DATABASE_OFFLINE'
        ? 'MongoDB is unavailable. Automated work and control changes are blocked until safe recovery.'
        : 'The bot is starting or stopping. Controls become available when this deployment safely owns the bot.';
  } else if (live && !paused && !bot.recapInProgress && Number(bot.startupGraceUntil) > now) {
    next = `STARTUP GRACE: ${seconds(Number(bot.startupGraceUntil) - now)}s`;
    notice ||= 'Recovered recap window. Pause or Stop is available before automatic generation resumes.';
  }
  if (bot.lastPersistenceError) notice = `${notice ? notice + ' ' : ''}A state save failed: ${bot.lastPersistenceError}. A durable success has not been confirmed.`;
  return { state, collection, next, notice, ready,
    good: ready && live && !paused && !bot.recoveryRequired,
    disabled: {
      pause: !ready || !live || (paused && !bot.collectionPaused && !bot.recapInProgress && !bot.lastPersistenceError),
      resume: !ready || !live || Boolean(bot.recoveryDeliveryKey || bot.capacityReached) || (!paused && !bot.collectionPaused),
      stop: !ready || !live || (stopped && !bot.learningInProgress && !bot.previewInProgress && !bot.lastPersistenceError),
      clear: !ready || !live || (!count && !bot.recapInProgress && !bot.recoveryRequired),
      preview: !ready || !live || stopped || bot.previewInProgress || !count
    }
  };
}
