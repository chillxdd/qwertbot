import { $, esc } from './shared.js';

const PAGE_SIZES = new Set([10, 25, 50]);
let customCommands = [];
let customPage = 1;
let nativePage = 1;

const nativeCommands = [
  { name: '!commands', userLevel: 'everyone', description: 'Links to this public SqwertArmyBot command directory.' },
  { name: '!recap', userLevel: 'everyone', description: 'Reports the next hourly recap ETA or the current recap state. Uses its own 5-minute command cooldown.' },
  { name: '!last', userLevel: 'everyone', description: 'Shows the saved clip of the last notable Pokémon run end. Uses a 30-second global cooldown.' },
  { name: '!optout', userLevel: 'everyone', badge: 'AI', description: 'Opts you out of Viewer Profiles immediately. Learning and AI use stop at once; your existing profile is retained for 30 days in case you opt back in, then its stored profile content is deleted.' },
  { name: '!optin', userLevel: 'everyone', badge: 'AI', description: 'Opts you back into Viewer Profiles. If you return within 30 days, your retained profile is reactivated; after that, a new profile starts fresh.' }
];

const USER_LEVEL_LABELS = { everyone: 'Everyone', subscriber: 'Subscriber', twitch_vip: 'VIP', moderator: 'Moderator', owner: 'Broadcaster' };
function normalizedUserLevel(value) {
  return Object.prototype.hasOwnProperty.call(USER_LEVEL_LABELS, value) ? value : 'everyone';
}
function userLevelBadgeHtml(value) {
  const level = normalizedUserLevel(value);
  return `<span class="user-level-badge user-level-${level}">${esc(USER_LEVEL_LABELS[level])}</span>`;
}

function selectView(view = 'commands') {
  const commandsSelected = view === 'commands';
  $('readonlyCustomCommandsView').classList.toggle('open', commandsSelected);
  $('readonlyNativeCommandsView').classList.toggle('open', !commandsSelected);
  $('readonlyCustomCommandsTab').classList.toggle('active', commandsSelected);
  $('readonlyNativeCommandsTab').classList.toggle('active', !commandsSelected);
  $('readonlyCustomCommandsTab').setAttribute('aria-selected', commandsSelected ? 'true' : 'false');
  $('readonlyNativeCommandsTab').setAttribute('aria-selected', commandsSelected ? 'false' : 'true');
}

function pageSize(id) {
  const value = Number($(id)?.value || 10);
  return PAGE_SIZES.has(value) ? value : 10;
}

function updatePagination({ totalItems, page, setPage, pageSizeId, labelId, prevId, nextId, paginationId }) {
  const size = pageSize(pageSizeId);
  const totalPages = Math.max(1, Math.ceil(totalItems / size));
  const safePage = Math.min(Math.max(1, page), totalPages);
  if (safePage !== page) setPage(safePage);
  $(labelId).textContent = `Page ${safePage} of ${totalPages}`;
  $(prevId).disabled = safePage <= 1;
  $(nextId).disabled = safePage >= totalPages;
  $(paginationId).hidden = totalItems === 0;
  return { page: safePage, pageSize: size };
}

function renderCustomCommands() {
  const list = $('readonlyCustomCommandList');
  const msg = $('readonlyCustomCommandsMsg');
  const query = String($('readonlyCustomCommandSearch')?.value || '').trim().toLocaleLowerCase();
  const sort = $('readonlyCustomCommandSort')?.value || 'name_asc';
  const levelFilter = $('readonlyCustomCommandUserLevelFilter')?.value || 'all';
  const filtered = customCommands.filter((command) => {
    if (levelFilter !== 'all' && normalizedUserLevel(command.userLevel) !== levelFilter) return false;
    if (!query) return true;
    const triggers = Array.isArray(command.triggers) ? command.triggers : [];
    const haystack = [command.name, command.publicDescription, ...triggers.flatMap((trigger) => [trigger?.trigger, trigger?.triggerType])]
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

  const { page, pageSize } = updatePagination({
    totalItems: filtered.length,
    page: customPage,
    setPage: (value) => { customPage = value; },
    pageSizeId: 'readonlyCustomCommandPageSize',
    labelId: 'readonlyCustomCommandPageLabel',
    prevId: 'readonlyCustomCommandPrevPage',
    nextId: 'readonlyCustomCommandNextPage',
    paginationId: 'readonlyCustomCommandPagination'
  });
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize);

  if (!customCommands.length) {
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
      const description = String(command.publicDescription || '').trim();
      const descriptionHtml = description ? `<div class="readonly-command-description">${esc(description)}</div>` : '';
      return `<div class="custom-command-card readonly-command-card"><div class="custom-command-card-main"><div class="custom-command-title-row"><strong class="custom-command-name">${esc(command.name || 'Custom Command')}</strong>${userLevelBadgeHtml(command.userLevel)}</div>${descriptionHtml}<div class="custom-trigger-chip-list">${chips}</div><div class="detail">${esc(command.cooldownSeconds || 0)}s cooldown</div></div></div>`;
    }).join('');
  }
  const filteredView = Boolean(query || levelFilter !== 'all');
  msg.textContent = filteredView ? `${filtered.length} matching command${filtered.length === 1 ? '' : 's'}.` : `${customCommands.length} command${customCommands.length === 1 ? '' : 's'} available.`;
}

function renderNativeCommands() {
  const list = $('readonlyNativeCommandList');
  const msg = $('readonlyNativeCommandsMsg');
  const query = String($('readonlyNativeCommandSearch')?.value || '').trim().toLocaleLowerCase();
  const sort = $('readonlyNativeCommandSort')?.value || 'name_asc';
  const levelFilter = $('readonlyNativeCommandUserLevelFilter')?.value || 'all';
  const filtered = nativeCommands.filter((command) => (levelFilter === 'all' || normalizedUserLevel(command.userLevel) === levelFilter) && (!query || `${command.name} ${command.badge || ''} ${command.description}`.toLocaleLowerCase().includes(query)))
    .sort((a, b) => sort === 'name_desc'
      ? b.name.localeCompare(a.name, undefined, { sensitivity: 'base', numeric: true })
      : a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  const { page, pageSize } = updatePagination({
    totalItems: filtered.length,
    page: nativePage,
    setPage: (value) => { nativePage = value; },
    pageSizeId: 'readonlyNativeCommandPageSize',
    labelId: 'readonlyNativeCommandPageLabel',
    prevId: 'readonlyNativeCommandPrevPage',
    nextId: 'readonlyNativeCommandNextPage',
    paginationId: 'readonlyNativeCommandPagination'
  });
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize);
  list.innerHTML = visible.length
    ? visible.map((command) => {
      const badge = command.badge ? `<span class="native-command-status enabled">${esc(command.badge)}</span>` : '';
      return `<div class="native-command-card"><div class="native-command-main"><div class="native-command-title"><code>${esc(command.name)}</code>${userLevelBadgeHtml(command.userLevel)}</div><div class="detail">${esc(command.description)}</div></div>${badge}</div>`;
    }).join('')
    : '<div class="coming-soon custom-empty-state">No commands match the current filters.</div>';
  const filteredView = Boolean(query || levelFilter !== 'all');
  msg.textContent = filteredView ? `${filtered.length} matching command${filtered.length === 1 ? '' : 's'}.` : `${nativeCommands.length} command${nativeCommands.length === 1 ? '' : 's'} available.`;
}

async function loadCommands() {
  const msg = $('readonlyCustomCommandsMsg');
  msg.textContent = 'Loading commands...';
  try {
    const response = await fetch('/public-commands', { cache: 'no-store' });
    const data = await response.json();
    if (!data.success) throw new Error(data.error || 'Could not load public commands.');
    customCommands = Array.isArray(data.commands) ? data.commands : [];
    customPage = 1;
    renderCustomCommands();
    renderNativeCommands();
  } catch (err) {
    customCommands = [];
    $('readonlyCustomCommandList').innerHTML = '';
    $('readonlyCustomCommandPagination').hidden = true;
    msg.textContent = err?.message || 'Could not load public commands.';
    renderNativeCommands();
  }
}

$('readonlyCustomCommandsTab').onclick = () => selectView('commands');
$('readonlyNativeCommandsTab').onclick = () => selectView('native');
$('readonlyCustomCommandSearch').oninput = () => { customPage = 1; renderCustomCommands(); };
$('readonlyCustomCommandSort').onchange = () => { customPage = 1; renderCustomCommands(); };
$('readonlyCustomCommandUserLevelFilter').onchange = () => { customPage = 1; renderCustomCommands(); };
$('readonlyCustomCommandPageSize').onchange = () => { customPage = 1; renderCustomCommands(); };
$('readonlyCustomCommandPrevPage').onclick = () => { if (customPage > 1) { customPage -= 1; renderCustomCommands(); } };
$('readonlyCustomCommandNextPage').onclick = () => { customPage += 1; renderCustomCommands(); };
$('readonlyNativeCommandSearch').oninput = () => { nativePage = 1; renderNativeCommands(); };
$('readonlyNativeCommandSort').onchange = () => { nativePage = 1; renderNativeCommands(); };
$('readonlyNativeCommandUserLevelFilter').onchange = () => { nativePage = 1; renderNativeCommands(); };
$('readonlyNativeCommandPageSize').onchange = () => { nativePage = 1; renderNativeCommands(); };
$('readonlyNativeCommandPrevPage').onclick = () => { if (nativePage > 1) { nativePage -= 1; renderNativeCommands(); } };
$('readonlyNativeCommandNextPage').onclick = () => { nativePage += 1; renderNativeCommands(); };

selectView('commands');
await loadCommands();
