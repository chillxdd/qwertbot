export function initMessagingSection({ $, postJson }) {
  $('sendBtn').onclick = async () => {
    const message = $('chatMessage').value.trim();
    if (!message) return;
    const d = await postJson('/send-chat', { message });
    if (d.success) {
      $('chatMsg').textContent = d.fallback ? 'Sent via IRC fallback (no bot badge for this message).' : 'Sent via Twitch Chat API.';
      $('chatMessage').value = '';
    } else {
      $('chatMsg').textContent = d.error || 'Failed to send.';
    }
  };

  $('storedBtn').onclick = async () => {
    $('testResult').textContent = 'Generating...';
    const d = await postJson('/test-summary', { type: 'stored' });
    $('testResult').textContent = d.success
      ? `${d.output}\n\n${d.characterCount}/500 characters`
      : (d.error?.message || d.error || 'Error');
  };
}
