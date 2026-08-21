let activeSequences = 0;
let holdUntil = 0;

function beginEventReaction() {
  activeSequences += 1;
}

function endEventReaction(holdSeconds = 0) {
  activeSequences = Math.max(0, activeSequences - 1);
  const seconds = Math.max(0, Number(holdSeconds) || 0);
  holdUntil = Math.max(holdUntil, Date.now() + seconds * 1000);
}

function getEventReactionHoldStatus() {
  const now = Date.now();
  const active = activeSequences > 0 || holdUntil > now;
  return {
    active,
    activeSequences,
    holdUntil: holdUntil > now ? holdUntil : 0,
    remainingMs: activeSequences > 0 ? null : Math.max(0, holdUntil - now)
  };
}

module.exports = { beginEventReaction, endEventReaction, getEventReactionHoldStatus };
