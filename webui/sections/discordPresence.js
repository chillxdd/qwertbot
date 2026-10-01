export function initDiscordPresenceSection({ $, postJson }) {
  let loaded = false;
  let loadingPromise = null;

  function setMessage(text, bad = false) {
    const el = $('discordPresenceMsg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('bad', Boolean(bad));
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

  function syncActivityState() {
    const none = $('discordPresenceActivityType').value === 'none';
    $('discordPresenceActivityText').disabled = none;
    if (none) $('discordPresenceActivityText').placeholder = 'No activity shown';
    else $('discordPresenceActivityText').placeholder = 'GeneralQwert';
  }

  function render(data = {}) {
    const settings = data.settings || {};
    $('discordPresenceStatus').value = settings.status || 'online';
    $('discordPresenceActivityType').value = settings.activityType || 'watching';
    $('discordPresenceActivityText').value = settings.activityText || '';
    if (data.limits?.maxActivityTextLength) $('discordPresenceActivityText').maxLength = Number(data.limits.maxActivityTextLength);
    renderStatus(data.botStatus || {});
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
        activityType: $('discordPresenceActivityType').value,
        activityText: $('discordPresenceActivityText').value
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

  $('discordPresenceActivityType').onchange = syncActivityState;
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
