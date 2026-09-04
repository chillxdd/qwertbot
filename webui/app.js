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
const lore = initLoreSection({ $, postJson, maxBotPersonalityNameLength: config.maxBotPersonalityNameLength, maxBotPersonalityLength: config.maxBotPersonalityLength, maxBotPersonalityCooldownSeconds: config.maxBotPersonalityCooldownSeconds, botUsername: config.botUsername, viewerProfiles });
const customCommands = initCustomCommandsSection({ $, esc, postJson, config: config.customCommands || {} });
const timers = initTimersSection({ $, esc, postJson, config: config.timers || {} });
const eventSubReactions = initEventSubReactionsSection({ $, esc, postJson, config: config.timers || {} });
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
    // Keep Bot Status identical in mod and read-only views. Recap details live in AI Recap.
    $('bDetail').textContent = '';

    const recapState = !d.qwert.live ? 'OFFLINE' : d.bot.recapPaused ? 'PAUSED' : d.bot.recapInProgress ? 'GENERATING' : 'RUNNING';
    $('recapState').textContent = recapState;
    $('recapState').className = `value ${!d.qwert.live ? 'warn' : d.bot.recapPaused ? 'warn' : 'good'}`;
    $('recapLogging').textContent = d.bot.loggingMessages ? 'ACTIVE' : 'IDLE';
    $('recapLogging').className = `value ${d.bot.loggingMessages ? 'good' : 'warn'}`;
    $('recapNext').textContent = d.bot.nextRecapAt ? countdown(d.bot.nextRecapAt - Date.now()) : '—';
    $('recapWindow').textContent = `${d.bot.messagesInWindow || 0} msg / ${d.bot.twitchEventsInWindow || 0} event`;

    $('dbStatusLabel').textContent = 'Database Status';
    $('dbStatus').textContent = d.database.connected ? 'CONNECTED' : 'OFFLINE';
    $('dbStatus').className = `value ${d.database.connected ? 'good' : 'bad'}`;
    $('dbDetail').textContent = loggedIn
      ? (d.database.connected ? 'Ready' : 'Check database connection')
      : '';

    const botMissing = d.oauth.botMissingScopes || [];
    const broadcaster = d.oauth.broadcaster || {};
    const broadcasterMissing = broadcaster.missingScopes || [];
    const botReady = Boolean(d.oauth.stored && botMissing.length === 0);
    const broadcasterReady = Boolean(broadcaster.stored && broadcasterMissing.length === 0);
    const chatReady = Boolean(d.oauth.chatApiReady);
    $('chatApiStatusLabel').textContent = loggedIn ? 'Twitch Chat API Status' : 'Chat Connection';
    $('chatApiStatusBox').textContent = loggedIn
      ? (chatReady ? 'BOT BADGE READY' : 'NOT READY')
      : (chatReady ? 'CONNECTED AS CHATBOT' : 'NOT CONNECTED');
    $('chatApiStatusBox').className = `value ${chatReady ? 'good' : 'warn'}`;
    $('chatApiDetail').textContent = loggedIn
      ? (chatReady
        ? 'Outgoing bot messages use Twitch Send Chat Message API + App Access Token.'
        : (!botReady || !broadcasterReady ? 'Complete both OAuth grants in OAuth Management' : 'OAuth grants are present, but Twitch Chat API is not ready. Check Render Diagnostics.'))
      : '';

    if (loggedIn) {
      $('pauseBtn').disabled = !d.qwert.live || d.bot.recapPaused || d.bot.recapInProgress;
      $('resumeBtn').disabled = !d.qwert.live || !d.bot.recapPaused;
      oauth.updateStatus(d);
    }
  } catch (_) {
    const botDetailEl = $('bDetail');
    if (botDetailEl) botDetailEl.textContent = '';
  }
}


const NATIVE_RESPONSE_FIELDS = {
  commands: [
    ['response', 'Response', 'Variable: $(user)']
  ],
  last: [
    ['response', 'Response', 'Variables: $(user), $(clipurl), $(cliptitle)'],
    ['cooldown', 'Cooldown', 'Variables: $(user), $(remaining)'],
    ['empty', 'No Saved Clip', 'Variable: $(user)'],
    ['error', 'Error', 'Variable: $(user)']
  ],
  setlast: [
    ['success', 'Success (blank = silent)', 'Variables: $(user), $(clipurl), $(cliptitle)'],
    ['fail', 'Fail Response', 'Variable: $(user)'],
    ['cooldown', 'Cooldown', 'Variables: $(user), $(remaining)']
  ],
  cliplast: [
    ['success', 'Success (blank = silent)', 'Variables: $(user), $(clipurl), $(cliptitle)'],
    ['fail', 'Fail Response', 'Variable: $(user)'],
    ['cooldown', 'Cooldown', 'Variables: $(user), $(remaining)']
  ],
  clip: [
    ['success', 'Success (blank = silent)', 'Variables: $(user), $(clipurl), $(cliptitle)'],
    ['fail', 'Fail Response', 'Variable: $(user)'],
    ['cooldown', 'Cooldown', 'Variables: $(user), $(remaining)']
  ],
  recap: [
    ['cooldown', 'Cooldown', 'Variables: $(user), $(remaining)'],
    ['offline', 'Offline', 'Variable: $(user)'],
    ['paused', 'Paused', 'Variable: $(user)'],
    ['generating', 'Generating', 'Variable: $(user)'],
    ['eta', 'Next Recap ETA', 'Variables: $(user), $(remaining)']
  ],
  startrecap: [
    ['offline', 'Offline', 'Variable: $(user)'],
    ['alreadyRunning', 'Already Running', 'Variable: $(user)'],
    ['success', 'Resumed', 'Variables: $(user), $(remaining)']
  ],
  stoprecap: [
    ['offline', 'Offline', 'Variable: $(user)'],
    ['alreadyPaused', 'Already Paused', 'Variable: $(user)'],
    ['generating', 'Generating', 'Variable: $(user)'],
    ['success', 'Paused', 'Variables: $(user), $(messages), $(remaining)']
  ],
  optout: [
    ['success', 'Opted Out', 'Variable: $(user)'],
    ['error', 'Error', 'Variable: $(user)']
  ],
  optin: [
    ['reactivated', 'Profile Reactivated', 'Variable: $(user)'],
    ['fresh', 'Fresh Profile', 'Variable: $(user)'],
    ['error', 'Error', 'Variable: $(user)']
  ]
};
const NATIVE_SETTING_DEFAULTS = {
  clip: { defaultDuration: 45 },
  cliplast: { defaultDuration: 45 }
};
const NATIVE_SETTING_FIELDS = {
  clip: [
    ['defaultDuration', 'Default Duration', 'Used when duration is omitted.', 'number']
  ],
  cliplast: [
    ['defaultDuration', 'Default Duration', 'Used when duration is omitted.', 'number']
  ]
};
let nativeResponses = null;
let nativeResponseDefaults = null;
let nativeClipSettings = null;
let nativeLastClip = null;
let nativeClipCooldowns = null;
let editingNativeCommand = null;
let nativeResponseMaxLength = 450;

async function loadNativeResponses() {
  const d = await postJson('/native-commands/responses/get', {});
  if (!d.success) throw new Error(d.error || 'Could not load native command responses.');
  nativeResponses = d.responses || {};
  nativeResponseDefaults = d.defaults || {};
  nativeClipSettings = d.clipSettings || nativeClipSettings || {};
  nativeLastClip = d.lastClip || null;
  nativeClipCooldowns = d.clipCooldowns || nativeClipCooldowns || {};
  nativeResponseMaxLength = Number(d.maxLength || 450);
}

function renderNativeResponseFields(command) {
  const responseFields = (NATIVE_RESPONSE_FIELDS[command] || []).map(([key, label, help]) => {
    const value = nativeResponses?.[command]?.[key] ?? '';
    return `<div class="native-response-field"><label class="prompt-label">${esc(label)}</label><textarea data-native-response-key="${esc(key)}" maxlength="${nativeResponseMaxLength}">${esc(value)}</textarea><div class="detail">${esc(help)}</div></div>`;
  });

  const settingFields = (NATIVE_SETTING_FIELDS[command] || []).map(([key, label, help, type]) => {
    const value = nativeClipSettings?.[command]?.[key] ?? '';
    const attrs = type === 'number' ? ' min="5" max="60" step="1"' : '';
    return `<div class="native-response-field"><label class="prompt-label">${esc(label)}</label><input data-native-setting-key="${esc(key)}" type="${type}" value="${esc(value)}"${attrs}><div class="detail">${esc(help)}</div></div>`;
  });

  const info = [];
  if (command === 'last' || command === 'setlast' || command === 'cliplast') {
    const current = nativeLastClip?.url
      ? `<a href="${esc(nativeLastClip.url)}" target="_blank" rel="noopener noreferrer">${esc(nativeLastClip.url)}</a>`
      : 'None saved yet.';
    info.push(`<div class="native-response-field native-current-clip"><label class="prompt-label">Current !last Clip</label><div class="detail">${current}</div></div>`);
  }
  if (command === 'last' && nativeClipCooldowns?.lastSeconds != null) {
    info.push(`<div class="detail">Cooldown: ${esc(nativeClipCooldowns.lastSeconds)}s global.</div>`);
  }
  if (command === 'clip' && nativeClipCooldowns?.clipSeconds != null) {
    info.push(`<div class="detail">Cooldown: ${esc(nativeClipCooldowns.clipSeconds)}s global.</div>`);
  }
  if (command === 'setlast' || command === 'cliplast') {
    const seconds = nativeClipCooldowns?.[`${command}Seconds`] ?? 60;
    info.push(`<div class="detail">Cooldown: ${esc(seconds)}s shared with the other !last editor. Official Pokémon categories only.</div>`);
  }
  if (command === 'clip' || command === 'cliplast') {
    info.push(`<div class="detail native-command-syntax"><code>!${esc(command)} [title]</code><br><code>!${esc(command)} [5–60s] | [title]</code><br>Leave title blank for automatic naming.</div>`);
  }

  $('nativeResponseFields').innerHTML = [...settingFields, ...responseFields, ...info].join('');
}

async function openNativeResponseDialog(command) {
  editingNativeCommand = command;
  $('nativeResponseMsg').textContent = 'Loading...';
  try { await loadNativeResponses(); }
  catch (err) { $('nativeResponseMsg').textContent = err.message; return; }
  $('nativeResponseDialogTitle').textContent = NATIVE_SETTING_FIELDS[command]?.length ? `!${command} Settings & Responses` : `!${command} Responses`;
  renderNativeResponseFields(command);
  $('nativeResponseMsg').textContent = '';
  const dialog = $('nativeResponseDialog');
  if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
}

function closeNativeResponseDialog() {
  const dialog = $('nativeResponseDialog');
  if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
}

async function saveNativeResponseDialog() {
  if (!editingNativeCommand) return;
  const commandResponses = { ...(nativeResponses?.[editingNativeCommand] || {}) };
  $('nativeResponseFields').querySelectorAll('[data-native-response-key]').forEach((field) => {
    commandResponses[field.dataset.nativeResponseKey] = field.value.trim();
  });
  nativeResponses = { ...(nativeResponses || {}), [editingNativeCommand]: commandResponses };
  const commandSettings = { ...(nativeClipSettings?.[editingNativeCommand] || {}) };
  $('nativeResponseFields').querySelectorAll('[data-native-setting-key]').forEach((field) => {
    commandSettings[field.dataset.nativeSettingKey] = field.type === 'number' ? Number(field.value) : field.value.trim();
  });
  if (Object.keys(commandSettings).length) {
    nativeClipSettings = { ...(nativeClipSettings || {}), [editingNativeCommand]: commandSettings };
  }
  $('nativeResponseMsg').textContent = 'Saving...';
  const d = await postJson('/native-commands/responses/save', { responses: nativeResponses, clipSettings: nativeClipSettings });
  if (!d.success) { $('nativeResponseMsg').textContent = d.error || 'Could not save responses.'; return; }
  nativeResponses = d.responses || nativeResponses;
  nativeClipSettings = d.clipSettings || nativeClipSettings;
  renderNativeResponseFields(editingNativeCommand);
  $('nativeResponseMsg').textContent = 'Saved.';
}

function resetNativeResponseDialog() {
  if (!editingNativeCommand) return;
  if (nativeResponseDefaults?.[editingNativeCommand]) {
    nativeResponses = { ...(nativeResponses || {}), [editingNativeCommand]: JSON.parse(JSON.stringify(nativeResponseDefaults[editingNativeCommand])) };
  }
  if (NATIVE_SETTING_DEFAULTS[editingNativeCommand]) {
    nativeClipSettings = { ...(nativeClipSettings || {}), [editingNativeCommand]: JSON.parse(JSON.stringify(NATIVE_SETTING_DEFAULTS[editingNativeCommand])) };
  }
  renderNativeResponseFields(editingNativeCommand);
  $('nativeResponseMsg').textContent = 'Defaults loaded. Save to apply them.';
}

const USER_LEVEL_LABELS = { everyone: 'Everyone', subscriber: 'Subscriber', twitch_vip: 'VIP', moderator: 'Moderator', owner: 'Broadcaster' };
function normalizedUserLevel(value) {
  return Object.prototype.hasOwnProperty.call(USER_LEVEL_LABELS, value) ? value : 'everyone';
}
function userLevelBadgeHtml(value) {
  const level = normalizedUserLevel(value);
  return `<span class="user-level-badge user-level-${level}">${esc(USER_LEVEL_LABELS[level])}</span>`;
}

async function showAuthenticatedUi({ loadLore = true } = {}) {
  loggedIn = true;
  $('login').style.display = 'none';
  $('protected').style.display = 'block';
  $('logoutBtn').hidden = false;
  $('password').value = '';
  $('loginMsg').textContent = '';
  if (loadLore) await lore.loadMemory();
  await messaging.loadPrompt();
  await automation.loadSettings();
  await status();
  // Load the Twitch embed only after the login overlay is gone and the dashboard layout is stable.
  requestAnimationFrame(() => requestAnimationFrame(ensureTwitchChatLoaded));
}

function showLogin(message = '') {
  loggedIn = false;
  renderLogs.onVisibilityChange(false);
  $('protected').style.display = 'none';
  $('logoutBtn').hidden = true;
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

async function doLogout() {
  const d = await postJson('/mod-logout', {});
  if (!d.success) return;
  showLogin();
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
$('logoutBtn').onclick = doLogout;
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doLogin(); } });
window.addEventListener('dashboard-auth-expired', () => showLogin('MOD session expired. Please log in again.'));
$('chatToggle').onclick = () => setChatOpen(!$('chatSidebar').classList.contains('open'));
setChatOpen(false);

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
const nativeCommandUserLevelFilter = $('nativeCommandUserLevelFilter');
function applyNativeCommandUserLevelFilter() {
  const level = nativeCommandUserLevelFilter?.value || 'all';
  document.querySelectorAll('#nativeCommandList [data-native-command]').forEach((card) => {
    card.hidden = level !== 'all' && normalizedUserLevel(card.dataset.userLevel) !== level;
  });
}
if (nativeCommandUserLevelFilter) nativeCommandUserLevelFilter.onchange = applyNativeCommandUserLevelFilter;
applyNativeCommandUserLevelFilter();
document.querySelectorAll('.native-response-edit-btn').forEach((button) => {
  button.onclick = () => openNativeResponseDialog(button.closest('[data-native-command]')?.dataset.nativeCommand || '');
});
$('closeNativeResponseDialogBtn').onclick = closeNativeResponseDialog;
$('saveNativeResponseBtn').onclick = saveNativeResponseDialog;
$('resetNativeResponseBtn').onclick = resetNativeResponseDialog;
$('nativeResponseDialog').addEventListener('click', (event) => { if (event.target === $('nativeResponseDialog')) closeNativeResponseDialog(); });
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
