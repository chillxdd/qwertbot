import { $, esc, postJson } from './shared.js';
import { initMessagingSection } from './sections/messaging.js';
import { initLoreSection } from './sections/lore.js';
import { initViewerProfilesSection } from './sections/viewerProfiles.js';
import { initCustomCommandsSection } from './sections/customCommands.js';
import { initTimersSection } from './sections/timers.js';
import { initEventSubReactionsSection } from './sections/eventSubReactions.js';
import { initAutomationSection } from './sections/automation.js';
import { initOauthSection } from './sections/oauth.js';
import { initRenderLogsSection } from './sections/renderLogs.js';

let loggedIn = false;
let config = { channelName: 'generalqwert', maxStreamLoreLength: 12000 };
const countdown = (ms) => { const s=Math.max(0,Math.ceil(ms/1000)); return `${Math.floor(s/60)}min ${s%60}s`; };
const uptime = (ms) => { const s=Math.max(0,Math.floor((Number(ms)||0)/1000)); const h=Math.floor(s/3600); const m=Math.floor((s%3600)/60); const sec=s%60; return `${h}h ${m}m ${sec}s`; };

function setChatOpen(open) {
  $('chatSidebar').classList.toggle('open', open);
  document.body.classList.toggle('chat-open', open);
  $('chatToggleIcon').textContent = open ? '›' : '‹';
  $('chatToggle').setAttribute('aria-label', open ? 'Hide Chat' : 'Show Chat');
  $('chatToggle').setAttribute('title', open ? 'Hide Chat' : 'Show Chat');
  $('chatToggle').setAttribute('aria-expanded', open ? 'true' : 'false');
}

async function loadConfig() {
  try {
    const response = await fetch('/webui-config', { cache: 'no-store' });
    const d = await response.json();
    if (d.success) config = { ...config, ...d };
  } catch (_) {}

}

let twitchChatLoaded = false;
function ensureTwitchChatLoaded() {
  if (twitchChatLoaded) return;
  const channel = String(config.channelName || 'generalqwert').replace(/[^a-zA-Z0-9_]/g, '') || 'generalqwert';
  $('twitchChatFrame').title = `${channel} Twitch chat`;
  $('twitchChatFrame').src = `https://www.twitch.tv/embed/${channel}/chat?darkpopout=1&parent=${encodeURIComponent(location.hostname)}`;
  twitchChatLoaded = true;
}

await loadConfig();
const messaging = initMessagingSection({ $, postJson });
const viewerProfiles = initViewerProfilesSection({ $, esc, postJson });
const lore = initLoreSection({ $, postJson, maxLoreLength: config.maxStreamLoreLength, maxBotPersonalityNameLength: config.maxBotPersonalityNameLength, maxBotPersonalityLength: config.maxBotPersonalityLength, maxBotPersonalityCooldownSeconds: config.maxBotPersonalityCooldownSeconds, botUsername: config.botUsername, viewerProfiles });
const customCommands = initCustomCommandsSection({ $, esc, postJson, config: config.customCommands || {} });
const timers = initTimersSection({ $, esc, postJson, config: config.timers || {} });
const eventSubReactions = initEventSubReactionsSection({ $, esc, postJson });
const automation = initAutomationSection({ $, postJson });
const oauth = initOauthSection({ $, postJson });
const renderLogs = initRenderLogsSection({ $, postJson });
void messaging;

async function status() {
  try {
    const d = await (await fetch('/status', { cache: 'no-store' })).json();
    $('qStatus').textContent = d.qwert.statusKnown ? (d.qwert.live ? 'LIVE' : 'OFFLINE') : 'CHECKING';
    $('qStatus').className = `value ${d.qwert.live ? 'good' : d.qwert.statusKnown ? 'bad' : 'warn'}`;
    $('qDetail').innerHTML = `<a target="_blank" rel="noopener noreferrer" href="${esc(d.qwert.twitchUrl)}">Watch on Twitch</a><br><a target="_blank" rel="noopener noreferrer" href="https://www.youtube.com/@generalqwert/streams">Watch on YouTube</a>`;
    $('streamMeta').innerHTML = d.qwert.live ? `<br><b>Title:</b> ${esc(d.qwert.title || 'Unknown')}<br><b>Category:</b> ${esc(d.qwert.category || 'Unknown')}<br><b>Uptime:</b> ${esc(uptime(d.qwert.uptimeMs))}` : '';

    $('bStatus').textContent = d.bot.online ? 'ONLINE' : 'OFFLINE';
    $('bStatus').className = `value ${d.bot.online ? 'good' : 'bad'}`;
    let botDetail = d.bot.loggingMessages ? `Logging ${d.bot.messagesInWindow} message(s) + ${d.bot.twitchEventsInWindow || 0} Twitch event(s) for hourly recap` : 'Not logging recap messages';
    if (d.bot.recapPaused) botDetail = `Recaps PAUSED - ${d.bot.messagesInWindow} message(s) preserved`;
    if (d.bot.recapInProgress) botDetail += '<br>Recap generation in progress';
    else if (d.bot.nextRecapAt) botDetail += `<br>Next recap in ${countdown(d.bot.nextRecapAt - Date.now())}`;
    $('bDetail').innerHTML = botDetail;

    const recapState = !d.qwert.live ? 'OFFLINE' : d.bot.recapPaused ? 'PAUSED' : d.bot.recapInProgress ? 'GENERATING' : 'RUNNING';
    $('recapState').textContent = recapState;
    $('recapState').className = `value ${!d.qwert.live ? 'warn' : d.bot.recapPaused ? 'warn' : 'good'}`;
    $('recapLogging').textContent = d.bot.loggingMessages ? 'ACTIVE' : 'IDLE';
    $('recapLogging').className = `value ${d.bot.loggingMessages ? 'good' : 'warn'}`;
    $('recapNext').textContent = d.bot.nextRecapAt ? countdown(d.bot.nextRecapAt - Date.now()) : '—';
    $('recapWindow').textContent = `${d.bot.messagesInWindow || 0} msg / ${d.bot.twitchEventsInWindow || 0} event`;

    $('dbStatus').textContent = d.database.connected ? 'CONNECTED' : 'OFFLINE';
    $('dbStatus').className = `value ${d.database.connected ? 'good' : 'bad'}`;
    $('dbDetail').textContent = d.database.connected ? 'Persistent storage ready' : 'Check MONGODB_URI / Atlas network access';

    const botMissing = d.oauth.botMissingScopes || [];
    const broadcaster = d.oauth.broadcaster || {};
    const broadcasterMissing = broadcaster.missingScopes || [];
    const botReady = Boolean(d.oauth.stored && botMissing.length === 0);
    const broadcasterReady = Boolean(broadcaster.stored && broadcasterMissing.length === 0);
    const chatReady = Boolean(d.oauth.chatApiReady);
    $('chatApiStatusBox').textContent = chatReady ? 'BOT BADGE READY' : 'NOT READY';
    $('chatApiStatusBox').className = `value ${chatReady ? 'good' : 'warn'}`;
    $('chatApiDetail').textContent = chatReady
      ? 'Outgoing bot messages use Twitch Send Chat Message API + App Access Token.'
      : (!botReady || !broadcasterReady ? 'Complete both OAuth grants in OAuth Management' : 'OAuth grants are present, but Twitch Chat API is not ready. Check Render logs.');

    if (loggedIn) {
      $('pauseBtn').disabled = !d.qwert.live || d.bot.recapPaused || d.bot.recapInProgress;
      $('resumeBtn').disabled = !d.qwert.live || !d.bot.recapPaused;
      oauth.updateStatus(d);
    }
  } catch (_) {
    $('bDetail').textContent = 'Status request failed';
  }
}

function selectReadOnlyCommandsView(view = 'commands') {
  const commandsSelected = view === 'commands';
  $('readonlyCustomCommandsView').classList.toggle('open', commandsSelected);
  $('readonlyNativeCommandsView').classList.toggle('open', !commandsSelected);
  $('readonlyCustomCommandsTab').classList.toggle('active', commandsSelected);
  $('readonlyNativeCommandsTab').classList.toggle('active', !commandsSelected);
  $('readonlyCustomCommandsTab').setAttribute('aria-selected', commandsSelected ? 'true' : 'false');
  $('readonlyNativeCommandsTab').setAttribute('aria-selected', commandsSelected ? 'false' : 'true');
}

async function loadReadOnlyCommands() {
  const list = $('readonlyCustomCommandList');
  const msg = $('readonlyCustomCommandsMsg');
  msg.textContent = 'Loading public commands...';
  try {
    const response = await fetch('/public-commands', { cache: 'no-store' });
    const d = await response.json();
    if (!d.success) throw new Error(d.error || 'Could not load public commands.');
    const commands = Array.isArray(d.commands) ? d.commands : [];
    if (!commands.length) {
      list.innerHTML = '<div class="coming-soon custom-empty-state">No public custom commands are available right now.</div>';
    } else {
      list.innerHTML = commands.map((command) => {
        const triggers = Array.isArray(command.triggers) ? command.triggers : [];
        const chips = triggers.map((trigger) => {
          const type = trigger.triggerType === 'inline' ? 'Inline' : '!Command';
          return `<span class="custom-trigger-chip"><strong>${esc(trigger.trigger)}</strong><small>${esc(type)}</small></span>`;
        }).join('');
        return `<div class="custom-command-card readonly-command-card"><div class="custom-command-card-main"><div class="custom-command-title-row"><strong class="custom-command-name">${esc(command.name || 'Custom Command')}</strong><span class="native-command-badge">Everyone</span></div><div class="custom-trigger-chip-list">${chips}</div><div class="detail">100% chance · ${esc(command.cooldownSeconds || 0)}s cooldown · ${esc(command.responseDelaySeconds || 0)}s delay</div></div></div>`;
      }).join('');
    }
    msg.textContent = `${commands.length} public custom command${commands.length === 1 ? '' : 's'}.`;
  } catch (err) {
    list.innerHTML = '';
    msg.textContent = err?.message || 'Could not load public commands.';
  }
}

$('readonlyCustomCommandsTab').onclick = () => selectReadOnlyCommandsView('commands');
$('readonlyNativeCommandsTab').onclick = () => selectReadOnlyCommandsView('native');
selectReadOnlyCommandsView('commands');

async function showAuthenticatedUi({ loadLore = true } = {}) {
  loggedIn = true;
  $('login').style.display = 'none';
  $('protected').style.display = 'block';
  $('readonlyCommandsPanel').hidden = true;
  $('openLoginBtn').hidden = true;
  $('readonlyBadge').hidden = true;
  $('password').value = '';
  $('loginMsg').textContent = '';
  if (loadLore) await lore.loadMemory();
  await messaging.loadPrompt();
  await automation.loadSettings();
  await status();
  // Load the Twitch embed only after the login overlay is gone and the dashboard layout is stable.
  requestAnimationFrame(() => requestAnimationFrame(ensureTwitchChatLoaded));
}

function enterReadOnlyMode() {
  loggedIn = false;
  renderLogs.onVisibilityChange(false);
  $('protected').style.display = 'none';
  $('readonlyCommandsPanel').hidden = false;
  $('login').style.display = 'none';
  $('openLoginBtn').hidden = false;
  $('readonlyBadge').hidden = false;
  $('password').value = '';
  $('loginMsg').textContent = '';
  void status();
  void loadReadOnlyCommands();
}

function showLogin(message = '') {
  loggedIn = false;
  renderLogs.onVisibilityChange(false);
  $('protected').style.display = 'none';
  $('readonlyCommandsPanel').hidden = true;
  $('openLoginBtn').hidden = true;
  $('readonlyBadge').hidden = false;
  $('login').style.display = 'block';
  $('loginMsg').textContent = message;
  void status();
  setTimeout(() => $('password').focus(), 0);
}

async function doLogin() {
  const p = $('password').value;
  if (!p) return;
  const d = await postJson('/mod-login', { password: p });
  $('password').value = '';
  if (!d.success) {
    $('loginMsg').textContent = d.error;
    return;
  }
  await showAuthenticatedUi();
}

async function restoreSession() {
  try {
    const response = await fetch('/mod-session', { cache: 'no-store', credentials: 'same-origin' });
    const d = await response.json();
    if (d.authenticated) {
      await showAuthenticatedUi();
      return;
    }
  } catch (_) {}
  showLogin();
}

$('loginBtn').onclick = doLogin;
$('closeLoginBtn').onclick = enterReadOnlyMode;
$('openLoginBtn').onclick = () => showLogin();
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doLogin(); } });
window.addEventListener('dashboard-auth-expired', () => showLogin('MOD session expired. Please log in again.'));
$('chatToggle').onclick = () => setChatOpen(!$('chatSidebar').classList.contains('open'));
setChatOpen(true);

async function recapAction(action) {
  const d = await postJson('/recap-control', { action });
  $('recapMsg').textContent = d.message || d.error;
  status();
}
$('pauseBtn').onclick = () => recapAction('stop');
$('resumeBtn').onclick = () => recapAction('start');


function selectCommandsView(view = 'commands', { load = true } = {}) {
  const commandsSelected = view === 'commands';
  const timersSelected = view === 'timers';
  const reactionsSelected = view === 'reactions';
  const nativeSelected = view === 'native';
  $('customCommandsView').classList.toggle('open', commandsSelected);
  $('timersView').classList.toggle('open', timersSelected);
  $('eventReactionsView').classList.toggle('open', reactionsSelected);
  $('nativeCommandsView').classList.toggle('open', nativeSelected);
  $('customCommandsViewTab').classList.toggle('active', commandsSelected);
  $('timersViewTab').classList.toggle('active', timersSelected);
  $('eventReactionsViewTab').classList.toggle('active', reactionsSelected);
  $('nativeCommandsViewTab').classList.toggle('active', nativeSelected);
  $('customCommandsViewTab').setAttribute('aria-selected', commandsSelected ? 'true' : 'false');
  $('timersViewTab').setAttribute('aria-selected', timersSelected ? 'true' : 'false');
  $('eventReactionsViewTab').setAttribute('aria-selected', reactionsSelected ? 'true' : 'false');
  $('nativeCommandsViewTab').setAttribute('aria-selected', nativeSelected ? 'true' : 'false');
  // Automation Spacing applies to Timers and EventSub Reactions. EventSub adds reaction timing context.
  $('automationSpacingCard').hidden = !(timersSelected || reactionsSelected);
  $('automationSpacingTitle').textContent = reactionsSelected ? 'Automation Spacing & Reaction Timing' : 'Automation Spacing';
  $('automationReactionTimingDetail').hidden = !reactionsSelected;
  if (load) {
    customCommands.onVisibilityChange(commandsSelected);
    timers.onVisibilityChange(timersSelected);
    eventSubReactions.onVisibilityChange(reactionsSelected);
  }
}
$('customCommandsViewTab').onclick = () => selectCommandsView('commands');
$('timersViewTab').onclick = () => selectCommandsView('timers');
$('eventReactionsViewTab').onclick = () => selectCommandsView('reactions');
$('nativeCommandsViewTab').onclick = () => selectCommandsView('native');
selectCommandsView('commands', { load: false });

const sectionMap = {
  messagingTab: 'messagingPanel',
  customCommandsTab: 'customCommandsPanel',
  loreTab: 'lorePanel',
  oauthTab: 'oauthPanel',
  renderLogsTab: 'renderLogsPanel'
};
function toggleSection(tabId) {
  const targetId = sectionMap[tabId];
  const target = $(targetId);
  const shouldOpen = !target.classList.contains('open');
  Object.entries(sectionMap).forEach(([buttonId, panelId]) => {
    $(panelId).classList.remove('open');
    $(buttonId).classList.remove('active');
    $(buttonId).setAttribute('aria-expanded', 'false');
    if (panelId === 'renderLogsPanel') renderLogs.onVisibilityChange(false);
    if (panelId === 'customCommandsPanel') {
      customCommands.onVisibilityChange(false);
      timers.onVisibilityChange(false);
      eventSubReactions.onVisibilityChange(false);
    }
    if (panelId === 'lorePanel') viewerProfiles.onVisibilityChange(false);
  });
  if (shouldOpen) {
    target.classList.add('open');
    $(tabId).classList.add('active');
    $(tabId).setAttribute('aria-expanded', 'true');
    if (targetId === 'renderLogsPanel') renderLogs.onVisibilityChange(true);
    if (targetId === 'customCommandsPanel') selectCommandsView('commands');
    if (targetId === 'lorePanel') lore.selectMemoryView('lore');
  }
}
Object.keys(sectionMap).forEach((tabId) => {
  $(tabId).setAttribute('aria-expanded', 'false');
  $(tabId).onclick = () => toggleSection(tabId);
});

await restoreSession();
setInterval(status, 15000);
