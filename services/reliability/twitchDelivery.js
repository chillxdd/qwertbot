'use strict';
// A rejected API request is different from a missing API response. Never turn
// an uncertain POST into an automatic second send through another transport.
function deliveryError(message, { status = null, state = 'NOT_SENT', fallback = false, cause } = {}) {
  const err = new Error(message, cause ? { cause } : undefined);
  err.status = status;
  err.deliveryState = state;
  err.safeIrcFallback = fallback && state === 'NOT_SENT';
  err.retryable = state === 'NOT_SENT' && (status === 429 || status == null);
  return err;
}
function httpDeliveryError(label, response, detail = '') {
  const status = Number(response.status);
  // A server-side failure could occur after Twitch performed the operation.
  return deliveryError(`${label} failed with HTTP ${status}${detail ? `: ${detail}` : ''}`, {
    status, state: status >= 500 || status === 408 || status < 400 ? 'UNKNOWN' : 'NOT_SENT',
    fallback: status === 401
  });
}
function canFallbackToIrc(err) {
  return err?.deliveryState === 'NOT_SENT' && err?.safeIrcFallback === true && !err?.cancelled;
}
module.exports = { deliveryError, httpDeliveryError, canFallbackToIrc };
