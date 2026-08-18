export function initMessagingSection({ $, postJson, getPassword }) {
  $('sendBtn').onclick = async () => {
    const message = $('chatMessage').value.trim();
    if (!message) return;
    const d = await postJson('/send-chat', { password: getPassword(), message });
    if (d.success) {
      $('chatMsg').textContent = d.fallback ? 'Sent via IRC fallback (no bot badge for this message).' : 'Sent via Twitch Chat API.';
      $('chatMessage').value = '';
    } else {
      $('chatMsg').textContent = d.error || 'Failed to send.';
    }
  };

  $('storedBtn').onclick = async () => {
    $('testResult').textContent = 'Generating...';
    const d = await postJson('/test-summary', { password: getPassword(), type: 'stored' });
    $('testResult').textContent = d.success
      ? `${d.output}\n\n${d.characterCount}/500 characters`
      : (d.error?.message || d.error || 'Error');
  };
}
