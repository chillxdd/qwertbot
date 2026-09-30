export function initReliabilitySection({ $, postJson, isLoggedIn, onResolved }) {
  let loading = false;
  let acting = false;
  const panel = $('reliabilityReviewList');
  const status = $('reliabilityReviewMessage');

  async function resolve(item, outcome) {
    if (acting) return;
    const youtube = item.target === 'youtube-timer' || String(item.title || '').startsWith('youtube-timer');
    const confirmation = youtube ? (outcome === 'sent'
      ? 'CONFIRM YOUTUBE DELIVERY? Check all destination chats first. This completes the timer occurrence without resending it.'
      : 'CONFIRM UNFINISHED YOUTUBE DESTINATIONS WERE NOT DELIVERED? Check every destination first. Confirmed destinations will NOT be resent; only unfinished ones can retry. Incorrect confirmation can duplicate a message.') : outcome === 'sent'
      ? 'CONFIRM ALREADY DELIVERED?\n\nCheck Twitch chat first. This marks the uncertain action as handled and prevents another copy from being sent. A reviewed rotating pinned banner will be skipped for the rest of this stream when its message ID is unavailable.'
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

  async function dismiss(item) {
    if (acting) return;
    let detail = 'The remaining actions will be abandoned, not retried. This does not delete a message already delivered to Twitch, YouTube or Discord, and does not claim it was delivered.';
    if (item.target === 'recap') detail += '\n\nThe old recap snapshot will be skipped; newer chat is retained. Recaps stay paused until Resume.';
    if (['timer', 'youtube-timer'].includes(item.target)) detail += '\n\nOnly this timer occurrence is skipped. The timer itself remains configured.';
    if (item.target === 'pin') detail += '\n\nAutomatic banner posting is skipped for the rest of this stream to prevent duplicate pins.';
    if (!window.confirm(`DISMISS WITHOUT RETRYING?\n\n${detail}`)) return;
    acting = true;
    panel.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    try {
      const result = await postJson('/reliability/dismiss', { target: item.target, id: item.id,
        expectedDeliveryKey: item.deliveryKey || '', confirmed: true });
      status.textContent = result.message || result.error || 'Refresh the recovery queue.';
    } catch (_) { status.textContent = 'The response was lost. Refresh the queue before trying again.'; }
    finally { acting = false; await refresh(); await onResolved(); }
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
      if (!result.review?.length) { panel.textContent = 'No recovery items need review. Dismissed and expired actions will not be retried.'; return; }
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
        const dismissButton = document.createElement('button');
        dismissButton.type = 'button'; dismissButton.className = 'danger';
        dismissButton.textContent = 'Dismiss - do not retry'; dismissButton.onclick = () => dismiss(item);
        actions.append(dismissButton);
        card.append(actions); panel.append(card);
      }
    } catch (err) { status.textContent = `Recovery status could not be refreshed: ${err.message}`; }
    finally { loading = false; }
  }
  $('refreshReliabilityBtn').onclick = () => refresh();
  return { refresh };
}
