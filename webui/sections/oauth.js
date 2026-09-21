export function initOauthSection({ $, postJson }) {
  $('oauthBtn').onclick = async () => {
    const d = await postJson('/auth/twitch/start', {});
    if (!d.success) {
      $('oauthMsg').textContent = d.error;
      return;
    }
    location.href = d.authorizationUrl;
  };

  function openSecretModal() {
    $('qwertSecretInput').value = '';
    $('qwertSecretModal').classList.add('open');
    setTimeout(() => $('qwertSecretInput').focus(), 0);
  }

  function closeSecretModal() {
    $('qwertSecretModal').classList.remove('open');
    $('qwertSecretInput').value = '';
  }

  async function copyQwertOauthUrl() {
    const secret = $('qwertSecretInput').value.trim();
    if (!secret) return;
    const url = `${location.origin}/authorize-qwert?key=${encodeURIComponent(secret)}`;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
      } else {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      closeSecretModal();
      $('broadcasterOauthMsg').textContent = 'Broadcaster OAuth URL copied to clipboard.';
    } catch (_) {
      $('broadcasterOauthMsg').textContent = 'Could not copy the OAuth URL. Check browser clipboard permissions.';
    }
  }

  $('broadcasterOauthBtn').onclick = openSecretModal;
  $('qwertSecretCancel').onclick = closeSecretModal;
  $('qwertSecretOk').onclick = copyQwertOauthUrl;
  $('qwertSecretInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); copyQwertOauthUrl(); }
    else if (e.key === 'Escape') closeSecretModal();
  });
  $('qwertSecretModal').addEventListener('click', (e) => {
    if (e.target === $('qwertSecretModal')) closeSecretModal();
  });

  function updateStatus(d) {
    const botMissing = d.oauth.botMissingScopes || [];
    const broadcaster = d.oauth.broadcaster || {};
    const broadcasterMissing = broadcaster.missingScopes || [];
    const botReady = Boolean(d.oauth.stored && botMissing.length === 0);
    const broadcasterReady = Boolean(broadcaster.stored && broadcasterMissing.length === 0);

    $('oauthStatusBox').textContent = botReady ? 'READY' : d.oauth.stored ? 'REAUTHORIZE' : 'NOT AUTHORIZED';
    $('oauthStatusBox').className = `value ${botReady ? 'good' : 'warn'}`;
    $('oauthDetail').textContent = d.oauth.stored
      ? `Account: ${d.oauth.username || 'unknown'}${botMissing.length ? ` | Missing: ${botMissing.join(', ')}` : ' | Modern bot grant ready'}`
      : 'Authorize the bot below.';

    $('broadcasterStatusBox').textContent = broadcasterReady ? 'READY' : broadcaster.stored ? 'REAUTHORIZE' : 'NOT AUTHORIZED';
    $('broadcasterStatusBox').className = `value ${broadcasterReady ? 'good' : 'warn'}`;
    $('broadcasterDetail').textContent = broadcaster.stored
      ? `Account: ${broadcaster.username || 'unknown'}${broadcasterMissing.length ? ` | Missing: ${broadcasterMissing.join(', ')}` : ' | Bot badge + EventSub scopes granted'}`
      : 'Private Qwert authorization link required';

    const chatApiReady = Boolean(d.oauth.chatApiReady);
    const chatStatus = $('oauthChatApiStatusBox');
    const chatDetail = $('oauthChatApiDetail');
    if (chatStatus && chatDetail) {
      chatStatus.textContent = chatApiReady ? 'READY' : (!botReady || !broadcasterReady ? 'WAITING FOR OAUTH' : 'NOT READY');
      chatStatus.className = `value ${chatApiReady ? 'good' : 'warn'}`;
      chatDetail.textContent = chatApiReady
        ? 'Outgoing bot messages use Twitch Send Chat Message API + App Access Token.'
        : (!botReady || !broadcasterReady
          ? 'Complete both Twitch OAuth grants above.'
          : 'OAuth grants are ready, but the Twitch Chat API readiness check is not passing. See Diagnostics.');
    }

    $('oauthBtn').disabled = !d.oauth.configured || !d.database.connected;
    return { botReady, broadcasterReady };
  }

  return { updateStatus };
}
