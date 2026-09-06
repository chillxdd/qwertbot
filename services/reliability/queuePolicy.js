'use strict';
// Three express jobs then an older regular job; any low-priority job waiting
// 60s also gets a turn. This prevents indefinite starvation, not preemption.
function createQueuePolicy({ now = Date.now, ageMs = 60000, highBurst = 3 } = {}) {
  let highStreak = 0;
  let nonLowStreak = 0;
  return function choose(queues) {
    const time = now();
    if (queues.low.length && ((time - queues.low[0].enqueuedAt >= ageMs && nonLowStreak >= 1) || nonLowStreak >= 8)) {
      highStreak = 0; nonLowStreak = 0; return queues.low.shift();
    }
    if (queues.normal.length && (highStreak >= highBurst || time - queues.normal[0].enqueuedAt >= ageMs)) {
      highStreak = 0; nonLowStreak++; return queues.normal.shift();
    }
    if (queues.high.length) { highStreak++; nonLowStreak++; return queues.high.shift(); }
    if (queues.normal.length) { highStreak = 0; nonLowStreak++; return queues.normal.shift(); }
    highStreak = 0; nonLowStreak = 0; return queues.low.shift() || null;
  };
}
module.exports = { createQueuePolicy };
