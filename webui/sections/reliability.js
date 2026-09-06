export function initReliabilitySection({ $, postJson, isLoggedIn, onResolved }) {
  let loading = false;
  let acting = false;
  const panel = $('reliabilityReviewList');
  const status = $('reliabilityReviewMessage');

  async function resolve(item, outcome) {
    if (acting) return;
    const confirmation = outcome === 'sent'
      ? 'CONFIRM ALREADY DELIVERED?\n\nCheck Twitch chat first. This marks the uncertain action as handled and prevents another copy from being sent. A reviewed persistent pin will be skipped for the rest of this stream when its message ID is unavailable.'
      : 'CONFIRM DEFINITELY NOT DELIVERED?\n\nOnly proceed after checking Twitch chat. This permits the unfinished action to be retried and could create a duplicate if Twitch actually received the first attempt.';
    if (!window.confirm(confirmation)) return;
    acting = true;
    panel.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    try {
      const result = await postJson('/reliability/resolve', { target: item.target, id: item.id, expectedDeliveryKey: item.deliveryKey, outcome, confirmed: true });
      status.textContent = result.message || result.error || (result.success ? 'Delivery reviewed.' : 'Review was not saved.');
    } catch (_) { status.textContent = 'The response was lost. Refresh the review queue before retrying; do not assume the change failed.'; }
    finally { acting = false; await refresh(); await onResolved(); }
  }

  async function retryEvent(item) {
    if (acting || !window.confirm('RETRY FAILED EVENT?\n\nThe bot will retry unfinished actions. Completed action steps will remain completed.')) return;
    acting = true;
    try {
      const result = await postJson('/reliability/retry-event', { id: item.id, confirmed: true });
      status.textContent = result.message || result.error;
    } catch (_) { status.textContent = 'The response was lost. Refresh the queue before retrying.'; }
    finally { acting = false; await refresh(); }
  }

  async function refresh() {
    if (loading || acting || !isLoggedIn()) return;
    loading = true;
    try {
      const response = await fetch('/reliability/status', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000) });
      const result = await response.json();
      if (!isLoggedIn()) return;
      if (!response.ok || !result.success) throw new Error(result.error || 'Recovery status unavailable.');
      panel.replaceChildren();
      if (!result.runtime?.ready) {
        panel.textContent = 'Recovery controls are available after the active deployment has handed over.';
        return;
      }
      if (!result.review?.length) { panel.textContent = 'No uncertain deliveries or failed Twitch events need review.'; return; }
      for (const item of result.review) {
        const card = document.createElement('div'); card.className = 'reliability-review-item';
        const heading = document.createElement('strong'); heading.textContent = item.title || 'Action needs review'; card.append(heading);
        const detail = document.createElement('p'); detail.textContent = item.detail || 'Delivery outcome is uncertain.'; card.append(detail);
        if (item.preview) { const quote = document.createElement('p'); quote.className = 'detail'; quote.textContent = item.preview; card.append(quote); }
        const when = document.createElement('div'); when.className = 'detail'; when.textContent = item.createdAt ? new Date(item.createdAt).toLocaleString() : ''; card.append(when);
        const actions = document.createElement('div'); actions.className = 'recap-control-actions';
        for (const [label, action] of (item.retryOnly
          ? [['Retry unfinished actions', () => retryEvent(item)]]
          : [['Already delivered - do not resend', () => resolve(item, 'sent')], ['Definitely not delivered - allow retry', () => resolve(item, 'not_sent')]])) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = label; button.onclick = action; actions.append(button);
        }
        card.append(actions); panel.append(card);
      }
    } catch (err) { status.textContent = `Recovery status could not be refreshed: ${err.message}`; }
    finally { loading = false; }
  }
  $('refreshReliabilityBtn').onclick = () => refresh();
  return { refresh };
}
