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
        : (!botReady || !broadcasterReady ? 'Complete both OAuth grants in OAuth Management' : 'OAuth grants are present, but Twitch Chat API is not ready. Check Render logs.'))
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

const READONLY_PAGE_SIZES = new Set([10, 25, 50]);
let readOnlyCustomCommands = [];
let readOnlyCustomPage = 1;
let readOnlyNativePage = 1;

const readOnlyNativeCommands = [
  { name: '!recap', userLevel: 'everyone', description: 'Reports the next hourly recap ETA or the current recap state. Uses its own 5-minute command cooldown.' },
  { name: '!optout', userLevel: 'everyone', description: 'Opts you out of Viewer Profiles immediately. Learning and AI use stop at once; your existing profile is retained for 30 days in case you opt back in, then its stored profile content is deleted.' },
  { name: '!optin', userLevel: 'everyone', description: 'Opts you back into Viewer Profiles. If you return within 30 days, your retained profile is reactivated; after that, a new profile starts fresh.' }

];

const NATIVE_RESPONSE_FIELDS = {
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
let nativeResponses = null;
let nativeResponseDefaults = null;
let editingNativeCommand = null;
let nativeResponseMaxLength = 450;

async function loadNativeResponses() {
  const d = await postJson('/native-commands/responses/get', {});
  if (!d.success) throw new Error(d.error || 'Could not load native command responses.');
  nativeResponses = d.responses || {};
  nativeResponseDefaults = d.defaults || {};
  nativeResponseMaxLength = Number(d.maxLength || 450);
}

function renderNativeResponseFields(command) {
  const fields = NATIVE_RESPONSE_FIELDS[command] || [];
  $('nativeResponseFields').innerHTML = fields.map(([key, label, help]) => {
    const value = nativeResponses?.[command]?.[key] || '';
    return `<div class="native-response-field"><label class="prompt-label">${esc(label)}</label><textarea data-native-response-key="${esc(key)}" maxlength="${nativeResponseMaxLength}">${esc(value)}</textarea><div class="detail">${esc(help)}</div></div>`;
  }).join('');
}

async function openNativeResponseDialog(command) {
  editingNativeCommand = command;
  $('nativeResponseMsg').textContent = 'Loading...';
  if (!nativeResponses) {
    try { await loadNativeResponses(); }
    catch (err) { $('nativeResponseMsg').textContent = err.message; return; }
  }
  $('nativeResponseDialogTitle').textContent = `!${command} Responses`;
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
  $('nativeResponseMsg').textContent = 'Saving...';
  const d = await postJson('/native-commands/responses/save', { responses: nativeResponses });
  if (!d.success) { $('nativeResponseMsg').textContent = d.error || 'Could not save responses.'; return; }
  nativeResponses = d.responses || nativeResponses;
  renderNativeResponseFields(editingNativeCommand);
  $('nativeResponseMsg').textContent = 'Saved.';
}

function resetNativeResponseDialog() {
  if (!editingNativeCommand || !nativeResponseDefaults?.[editingNativeCommand]) return;
  nativeResponses = { ...(nativeResponses || {}), [editingNativeCommand]: JSON.parse(JSON.stringify(nativeResponseDefaults[editingNativeCommand])) };
  renderNativeResponseFields(editingNativeCommand);
  $('nativeResponseMsg').textContent = 'Defaults loaded. Save to apply them.';
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

function readOnlyPageSize(id) {
  const value = Number($(id)?.value || 10);
  return READONLY_PAGE_SIZES.has(value) ? value : 10;
}

function updateReadOnlyPagination({ totalItems, page, setPage, pageSizeId, labelId, prevId, nextId, paginationId }) {
  const pageSize = readOnlyPageSize(pageSizeId);
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  if (safePage !== page) setPage(safePage);
  $(labelId).textContent = `Page ${safePage} of ${totalPages}`;
  $(prevId).disabled = safePage <= 1;
  $(nextId).disabled = safePage >= totalPages;
  $(paginationId).hidden = totalItems === 0;
  return { page: safePage, pageSize };
}

const USER_LEVEL_LABELS = { everyone: 'Everyone', subscriber: 'Subscriber', twitch_vip: 'VIP', moderator: 'Moderator', owner: 'Broadcaster' };
function normalizedUserLevel(value) {
  return Object.prototype.hasOwnProperty.call(USER_LEVEL_LABELS, value) ? value : 'everyone';
}
function userLevelBadgeHtml(value) {
  const level = normalizedUserLevel(value);
  return `<span class="user-level-badge user-level-${level}">${esc(USER_LEVEL_LABELS[level])}</span>`;
}

function renderReadOnlyCustomCommands() {
  const list = $('readonlyCustomCommandList');
  const msg = $('readonlyCustomCommandsMsg');
  const query = String($('readonlyCustomCommandSearch')?.value || '').trim().toLocaleLowerCase();
  const sort = $('readonlyCustomCommandSort')?.value || 'name_asc';
  const userLevelFilter = $('readonlyCustomCommandUserLevelFilter')?.value || 'all';
  const filtered = readOnlyCustomCommands.filter((command) => {
    if (userLevelFilter !== 'all' && normalizedUserLevel(command.userLevel) !== userLevelFilter) return false;
    if (!query) return true;
    const triggers = Array.isArray(command.triggers) ? command.triggers : [];
    const haystack = [command.name, ...triggers.flatMap((trigger) => [trigger?.trigger, trigger?.triggerType])]
      .filter(Boolean).join(' ').toLocaleLowerCase();
    return haystack.includes(query);
  }).sort((a, b) => {
    const nameA = String(a?.name || 'Custom Command');
    const nameB = String(b?.name || 'Custom Command');
    if (sort === 'name_desc') return nameB.localeCompare(nameA, undefined, { sensitivity: 'base', numeric: true });
    if (sort === 'cooldown_asc') return Number(a?.cooldownSeconds || 0) - Number(b?.cooldownSeconds || 0) || nameA.localeCompare(nameB, undefined, { sensitivity: 'base', numeric: true });
    if (sort === 'cooldown_desc') return Number(b?.cooldownSeconds || 0) - Number(a?.cooldownSeconds || 0) || nameA.localeCompare(nameB, undefined, { sensitivity: 'base', numeric: true });
    return nameA.localeCompare(nameB, undefined, { sensitivity: 'base', numeric: true });
  });

  const { page, pageSize } = updateReadOnlyPagination({
    totalItems: filtered.length,
    page: readOnlyCustomPage,
    setPage: (value) => { readOnlyCustomPage = value; },
    pageSizeId: 'readonlyCustomCommandPageSize',
    labelId: 'readonlyCustomCommandPageLabel',
    prevId: 'readonlyCustomCommandPrevPage',
    nextId: 'readonlyCustomCommandNextPage',
    paginationId: 'readonlyCustomCommandPagination'
  });
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize);

  if (!readOnlyCustomCommands.length) {
    list.innerHTML = '<div class="coming-soon custom-empty-state">No commands are available right now.</div>';
  } else if (!visible.length) {
    list.innerHTML = '<div class="coming-soon custom-empty-state">No commands match the current filters.</div>';
  } else {
    list.innerHTML = visible.map((command) => {
      const triggers = Array.isArray(command.triggers) ? command.triggers : [];
      const chips = triggers.map((trigger) => {
        const type = trigger.triggerType === 'inline' ? 'Inline' : '!Command';
        return `<span class="custom-trigger-chip"><strong>${esc(trigger.trigger)}</strong><small>${esc(type)}</small></span>`;
      }).join('');
      return `<div class="custom-command-card readonly-command-card"><div class="custom-command-card-main"><div class="custom-command-title-row"><strong class="custom-command-name">${esc(command.name || 'Custom Command')}</strong>${userLevelBadgeHtml(command.userLevel)}</div><div class="custom-trigger-chip-list">${chips}</div><div class="detail">${esc(command.cooldownSeconds || 0)}s cooldown</div></div></div>`;
    }).join('');
  }
  const filteredView = Boolean(query || userLevelFilter !== 'all');
  msg.textContent = filteredView ? `${filtered.length} matching command${filtered.length === 1 ? '' : 's'}.` : `${readOnlyCustomCommands.length} command${readOnlyCustomCommands.length === 1 ? '' : 's'} available.`;
}

function renderReadOnlyNativeCommands() {
  const list = $('readonlyNativeCommandList');
  const msg = $('readonlyNativeCommandsMsg');
  const query = String($('readonlyNativeCommandSearch')?.value || '').trim().toLocaleLowerCase();
  const sort = $('readonlyNativeCommandSort')?.value || 'name_asc';
  const userLevelFilter = $('readonlyNativeCommandUserLevelFilter')?.value || 'all';
  const filtered = readOnlyNativeCommands.filter((command) => (userLevelFilter === 'all' || normalizedUserLevel(command.userLevel) === userLevelFilter) && (!query || `${command.name} ${command.description}`.toLocaleLowerCase().includes(query)))
    .sort((a, b) => sort === 'name_desc'
      ? b.name.localeCompare(a.name, undefined, { sensitivity: 'base', numeric: true })
      : a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  const { page, pageSize } = updateReadOnlyPagination({
    totalItems: filtered.length,
    page: readOnlyNativePage,
    setPage: (value) => { readOnlyNativePage = value; },
    pageSizeId: 'readonlyNativeCommandPageSize',
    labelId: 'readonlyNativeCommandPageLabel',
    prevId: 'readonlyNativeCommandPrevPage',
    nextId: 'readonlyNativeCommandNextPage',
    paginationId: 'readonlyNativeCommandPagination'
  });
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize);
  list.innerHTML = visible.length
    ? visible.map((command) => `<div class="native-command-card"><div class="native-command-main"><div class="native-command-title"><code>${esc(command.name)}</code>${userLevelBadgeHtml(command.userLevel)}</div><div class="detail">${esc(command.description)}</div></div><span class="native-command-status enabled">Built-in</span></div>`).join('')
    : '<div class="coming-soon custom-empty-state">No commands match the current filters.</div>';
  const filteredView = Boolean(query || userLevelFilter !== 'all');
  msg.textContent = filteredView ? `${filtered.length} matching command${filtered.length === 1 ? '' : 's'}.` : `${readOnlyNativeCommands.length} command${readOnlyNativeCommands.length === 1 ? '' : 's'} available.`;
}

async function loadReadOnlyCommands() {
  const msg = $('readonlyCustomCommandsMsg');
  msg.textContent = 'Loading public commands...';
  try {
    const response = await fetch('/public-commands', { cache: 'no-store' });
    const d = await response.json();
    if (!d.success) throw new Error(d.error || 'Could not load public commands.');
    readOnlyCustomCommands = Array.isArray(d.commands) ? d.commands : [];
    readOnlyCustomPage = 1;
    renderReadOnlyCustomCommands();
    renderReadOnlyNativeCommands();
  } catch (err) {
    readOnlyCustomCommands = [];
    $('readonlyCustomCommandList').innerHTML = '';
    $('readonlyCustomCommandPagination').hidden = true;
    msg.textContent = err?.message || 'Could not load public commands.';
    renderReadOnlyNativeCommands();
  }
}

$('readonlyCustomCommandsTab').onclick = () => selectReadOnlyCommandsView('commands');
$('readonlyNativeCommandsTab').onclick = () => selectReadOnlyCommandsView('native');
selectReadOnlyCommandsView('commands');
$('readonlyCustomCommandSearch').oninput = () => { readOnlyCustomPage = 1; renderReadOnlyCustomCommands(); };
$('readonlyCustomCommandSort').onchange = () => { readOnlyCustomPage = 1; renderReadOnlyCustomCommands(); };
$('readonlyCustomCommandUserLevelFilter').onchange = () => { readOnlyCustomPage = 1; renderReadOnlyCustomCommands(); };
$('readonlyCustomCommandPageSize').onchange = () => { readOnlyCustomPage = 1; renderReadOnlyCustomCommands(); };
$('readonlyCustomCommandPrevPage').onclick = () => { if (readOnlyCustomPage > 1) { readOnlyCustomPage -= 1; renderReadOnlyCustomCommands(); } };
$('readonlyCustomCommandNextPage').onclick = () => { readOnlyCustomPage += 1; renderReadOnlyCustomCommands(); };
$('readonlyNativeCommandSearch').oninput = () => { readOnlyNativePage = 1; renderReadOnlyNativeCommands(); };
$('readonlyNativeCommandSort').onchange = () => { readOnlyNativePage = 1; renderReadOnlyNativeCommands(); };
$('readonlyNativeCommandUserLevelFilter').onchange = () => { readOnlyNativePage = 1; renderReadOnlyNativeCommands(); };
$('readonlyNativeCommandPageSize').onchange = () => { readOnlyNativePage = 1; renderReadOnlyNativeCommands(); };
$('readonlyNativeCommandPrevPage').onclick = () => { if (readOnlyNativePage > 1) { readOnlyNativePage -= 1; renderReadOnlyNativeCommands(); } };
$('readonlyNativeCommandNextPage').onclick = () => { readOnlyNativePage += 1; renderReadOnlyNativeCommands(); };

async function showAuthenticatedUi({ loadLore = true } = {}) {
  loggedIn = true;
  $('login').style.display = 'none';
  $('protected').style.display = 'block';
  $('readonlyCommandsPanel').hidden = true;
  $('openLoginBtn').hidden = true;
  $('logoutBtn').hidden = false;
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
  $('logoutBtn').hidden = true;
  $('readonlyBadge').hidden = false;
  $('password').value = '';
  $('loginMsg').textContent = '';
  void status();
  void loadReadOnlyCommands();
  // Chat is part of the public dashboard too; load it once the login overlay is gone.
  requestAnimationFrame(() => requestAnimationFrame(ensureTwitchChatLoaded));
}

function showLogin(message = '') {
  loggedIn = false;
  renderLogs.onVisibilityChange(false);
  $('protected').style.display = 'none';
  $('readonlyCommandsPanel').hidden = true;
  $('openLoginBtn').hidden = true;
  $('logoutBtn').hidden = true;
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

async function doLogout() {
  const d = await postJson('/mod-logout', {});
  if (!d.success) return;
  enterReadOnlyMode();
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
$('logoutBtn').onclick = doLogout;
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
