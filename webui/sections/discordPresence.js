export function initDiscordPresenceSection({ $, postJson }) {
  let loaded = false;
  let loadingPromise = null;

  function setMessage(text, bad = false) {
    const el = $('discordPresenceMsg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('bad', Boolean(bad));
  }

  function activityLabel(type, text) {
    const value = String(text || '').trim();
    const labels = { playing: 'Playing', watching: 'Watching', listening: 'Listening to', competing: 'Competing in' };
    if (type === 'none') return 'No activity';
    if (type === 'custom') return value || 'Custom status';
    return `${labels[type] || type} ${value || ''}`.trim();
  }

  function renderStatus(botStatus = {}) {
    const el = $('discordPresenceConnectionStatus');
    if (!el) return;
    const username = botStatus?.botUser?.username ? ` as ${botStatus.botUser.username}` : '';
    const gateway = String(botStatus.gatewayState || (botStatus.tokenConfigured ? 'OFFLINE' : 'DISABLED'));
    const token = botStatus.tokenConfigured ? 'Bot token configured' : 'Bot token not configured';
    const error = botStatus.lastError ? ` · ${botStatus.lastError}` : '';
    el.textContent = `${token} · Gateway ${gateway}${username}${error}`;
    el.classList.toggle('bad', !botStatus.tokenConfigured || ['ERROR', 'UNAVAILABLE', 'DISABLED'].includes(gateway));
    el.classList.toggle('good', botStatus.tokenConfigured && gateway === 'ONLINE');
  }

  function renderResolved(resolved = {}) {
    const el = $('discordPresenceResolvedPreview');
    if (!el) return;
    const twitchState = resolved.twitchState === 'live' ? 'LIVE' : resolved.twitchState === 'offline' ? 'OFFLINE' : 'UNKNOWN';
    el.textContent = `Current resolved presence: Twitch ${twitchState} · ${activityLabel(resolved.activityType, resolved.activityText)}`;
  }

  function syncActivityState() {
    for (const prefix of ['Live', 'Offline']) {
      const type = $(`discordPresence${prefix}ActivityType`).value;
      const input = $(`discordPresence${prefix}ActivityText`);
      const none = type === 'none';
      input.disabled = none;
      if (none) input.placeholder = 'No activity shown';
      else if (type === 'custom') input.placeholder = 'Text-only custom status';
      else input.placeholder = prefix === 'Live' ? '{category}' : 'GeneralQwert is offline';
    }
  }

  function render(data = {}) {
    const settings = data.settings || {};
    $('discordPresenceStatus').value = settings.status || 'online';
    $('discordPresenceLiveActivityType').value = settings.liveActivityType || 'watching';
    $('discordPresenceLiveActivityText').value = settings.liveActivityText || '';
    $('discordPresenceOfflineActivityType').value = settings.offlineActivityType || 'custom';
    $('discordPresenceOfflineActivityText').value = settings.offlineActivityText || '';
    const max = Number(data.limits?.maxActivityTextLength || 128);
    $('discordPresenceLiveActivityText').maxLength = max;
    $('discordPresenceOfflineActivityText').maxLength = max;
    renderStatus(data.botStatus || {});
    renderResolved(data.resolvedPresence || {});
    syncActivityState();
  }

  async function load({ quiet = false, force = true } = {}) {
    if (loadingPromise) return loadingPromise;
    if (!force && loaded) return;
    if (!quiet) setMessage('Loading Discord presence...');
    loadingPromise = (async () => {
      try {
        const data = await postJson('/discord/presence/settings', {});
        if (!data.success) throw new Error(data.error || 'Could not load Discord presence settings.');
        render(data);
        loaded = true;
        if (!quiet) setMessage('');
      } catch (err) {
        setMessage(err.message || 'Could not load Discord presence settings.', true);
      } finally {
        loadingPromise = null;
      }
    })();
    return loadingPromise;
  }

  async function save() {
    const button = $('saveDiscordPresenceBtn');
    button.disabled = true;
    setMessage('Saving Discord presence...');
    try {
      const data = await postJson('/discord/presence/settings/save', {
        status: $('discordPresenceStatus').value,
        liveActivityType: $('discordPresenceLiveActivityType').value,
        liveActivityText: $('discordPresenceLiveActivityText').value,
        offlineActivityType: $('discordPresenceOfflineActivityType').value,
        offlineActivityText: $('discordPresenceOfflineActivityText').value
      });
      if (!data.success) throw new Error(data.error || 'Could not save Discord presence settings.');
      render(data);
      loaded = true;
      setMessage('Discord presence saved and applied.');
    } catch (err) {
      setMessage(err.message || 'Could not save Discord presence settings.', true);
    } finally {
      button.disabled = false;
    }
  }

  $('discordPresenceLiveActivityType').onchange = syncActivityState;
  $('discordPresenceOfflineActivityType').onchange = syncActivityState;
  $('saveDiscordPresenceBtn').onclick = save;
  $('refreshDiscordPresenceBtn').onclick = () => void load({ force: true });
  syncActivityState();

  return {
    load,
    onVisibilityChange(visible) {
      if (visible) void load({ force: true });
    }
  };
}
