export function initViewerProfilesSection({ $, esc, postJson }) {
  let profiles = [];
  let loaded = false;
  let currentPage = 1;
  let editingId = null;
  const PAGE_SIZE_STORAGE_KEY = 'sqwert-viewer-profile-page-size';
  const SORT_STORAGE_KEY = 'sqwert-viewer-profile-sort';
  const VALID_PAGE_SIZES = new Set([10, 25, 50]);
  const VALID_SORTS = new Set(['updated_desc', 'name_asc', 'name_desc', 'facts_desc']);
  const dialog = $('viewerProfileDialog');

  function setMessage(text, isError = false) {
    const el = $('viewerProfilesMsg');
    el.textContent = text || '';
    el.classList.toggle('bad', Boolean(isError));
  }

  function setSettingsMessage(text, isError = false) {
    const el = $('viewerProfileSettingsMsg');
    el.textContent = text || '';
    el.classList.toggle('bad', Boolean(isError));
  }

  function setDialogMessage(text, isError = false) {
    const el = $('viewerProfileDialogMsg');
    el.textContent = text || '';
    el.classList.toggle('bad', Boolean(isError));
  }

  function selectedPageSize() {
    const value = Number($('viewerProfilePageSize').value || 10);
    return VALID_PAGE_SIZES.has(value) ? value : 10;
  }

  function selectedSort() {
    const value = $('viewerProfileSort').value || 'updated_desc';
    return VALID_SORTS.has(value) ? value : 'updated_desc';
  }

  function searchableText(profile) {
    return [
      profile.username,
      profile.displayName,
      ...(profile.aliases || []),
      profile.pinnedNotes,
      ...(profile.facts || []).map((fact) => fact.text)
    ].join(' ').toLowerCase();
  }

  function filteredProfiles() {
    const query = $('viewerProfileSearch').value.trim().toLowerCase();
    const list = query ? profiles.filter((profile) => searchableText(profile).includes(query)) : [...profiles];
    const sort = selectedSort();
    list.sort((a, b) => {
      if (sort === 'name_asc' || sort === 'name_desc') {
        const cmp = String(a.displayName || a.username).localeCompare(String(b.displayName || b.username), undefined, { sensitivity: 'base' });
        return sort === 'name_desc' ? -cmp : cmp;
      }
      if (sort === 'facts_desc') return (b.facts?.length || 0) - (a.facts?.length || 0);
      return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
    });
    return list;
  }

  function renderList() {
    const list = filteredProfiles();
    const pageSize = selectedPageSize();
    const pageCount = Math.max(1, Math.ceil(list.length / pageSize));
    currentPage = Math.max(1, Math.min(currentPage, pageCount));
    const start = (currentPage - 1) * pageSize;
    const page = list.slice(start, start + pageSize);
    const listEl = $('viewerProfileList');

    if (!page.length) {
      listEl.innerHTML = `<div class="custom-empty-state detail">${profiles.length ? 'No viewer profiles match your search.' : 'No viewer profiles yet. Profiles can be learned automatically from meaningful chat during hourly recap processing.'}</div>`;
    } else {
      listEl.innerHTML = page.map((profile) => {
        const activeFacts = (profile.facts || []).filter((fact) => fact.enabled !== false).length;
        const aliases = profile.aliases?.length ? ` · ${profile.aliases.map((alias) => esc(alias)).join(', ')}` : '';
        const disabled = profile.enabled === false ? '<span class="custom-command-state disabled">AI context off</span>' : '<span class="custom-command-state enabled">AI context on</span>';
        const learning = profile.optedOut === true
          ? '<span class="custom-command-state disabled">Opted out</span>'
          : profile.learningEnabled === false
            ? '<span class="custom-command-state disabled">Learning off</span>'
            : '<span class="custom-command-state enabled">Learning on</span>';
        return `<div class="custom-command-card viewer-profile-card" data-profile-id="${esc(profile.id)}">
          <div class="custom-command-card-main">
            <div class="custom-command-title-row"><strong class="custom-command-name">${esc(profile.displayName || profile.username)}</strong><span class="detail">@${esc(profile.username)}</span>${disabled}${learning}</div>
            <div class="detail">${activeFacts} active learned fact${activeFacts === 1 ? '' : 's'}${aliases}</div>
            <div class="detail">Last updated: ${profile.updatedAt ? esc(new Date(profile.updatedAt).toLocaleString()) : 'Unknown'}</div>
          </div>
          <div class="custom-command-actions"><button class="secondary viewer-profile-view-btn" type="button">View / Edit</button></div>
        </div>`;
      }).join('');
      listEl.querySelectorAll('.viewer-profile-card').forEach((card) => {
        const profile = profiles.find((item) => item.id === card.dataset.profileId);
        card.querySelector('.viewer-profile-view-btn').onclick = () => openProfile(profile);
      });
    }

    $('viewerProfilePageLabel').textContent = `Page ${currentPage} of ${pageCount}`;
    $('viewerProfilePrevPage').disabled = currentPage <= 1;
    $('viewerProfileNextPage').disabled = currentPage >= pageCount;
    $('viewerProfilePagination').hidden = list.length === 0;
  }

  function renderFacts(profile) {
    const facts = Array.isArray(profile?.facts) ? profile.facts : [];
    $('viewerProfileFactCount').textContent = `${facts.length} fact${facts.length === 1 ? '' : 's'}`;
    $('viewerProfileFacts').innerHTML = facts.length ? facts.map((fact) => `
      <div class="viewer-profile-fact ${fact.enabled === false ? 'disabled' : ''}" data-fact-id="${esc(fact.id)}">
        <label class="inline-check"><input class="viewer-profile-fact-toggle" type="checkbox" ${fact.enabled === false ? '' : 'checked'}> Use</label>
        <div class="viewer-profile-fact-copy">
          <div>${esc(fact.text)}</div>
          <div class="detail">${esc(fact.confidence || 'medium')} confidence · observed ${Number(fact.evidenceCount || 1)}x${fact.lastObservedAt ? ` · last ${esc(new Date(fact.lastObservedAt).toLocaleDateString())}` : ''}</div>
        </div>
      </div>`).join('') : '<div class="detail custom-empty-state">No AI-learned observations yet.</div>';

    $('viewerProfileFacts').querySelectorAll('.viewer-profile-fact-toggle').forEach((toggle) => {
      toggle.onchange = async () => {
        if (!editingId) return;
        const row = toggle.closest('.viewer-profile-fact');
        toggle.disabled = true;
        const d = await postJson('/viewer-profiles/fact-toggle', { profileId: editingId, factId: row.dataset.factId, enabled: toggle.checked });
        toggle.disabled = false;
        if (!d.success) {
          toggle.checked = !toggle.checked;
          return setDialogMessage(d.error || 'Could not update fact.', true);
        }
        const index = profiles.findIndex((item) => item.id === editingId);
        if (index >= 0) profiles[index] = d.profile;
        renderFacts(d.profile);
        renderList();
      };
    });
  }

  function clearProfileForm() {
    editingId = null;
    $('viewerProfileDialogTitle').textContent = 'Add Viewer Profile';
    $('viewerProfileDialogMeta').textContent = 'Manual profiles can be added before the AI has learned anything about a viewer.';
    $('viewerProfileUsername').disabled = false;
    $('viewerProfileUsername').value = '';
    $('viewerProfileDisplayName').value = '';
    $('viewerProfileAliases').value = '';
    $('viewerProfilePinnedNotes').value = '';
    $('viewerProfileEnabled').checked = true;
    $('viewerProfileLearningForUser').checked = true;
    $('viewerProfileEnabled').disabled = false;
    $('viewerProfileLearningForUser').disabled = false;
    $('viewerProfileAliases').disabled = false;
    $('viewerProfilePinnedNotes').disabled = false;
    $('saveViewerProfileBtn').disabled = false;
    $('deleteViewerProfileBtn').hidden = true;
    setDialogMessage('');
    renderFacts({ facts: [] });
  }

  function showDialog() {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function closeDialog() {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  function openProfile(profile = null) {
    clearProfileForm();
    if (profile) {
      editingId = profile.id;
      $('viewerProfileDialogTitle').textContent = profile.displayName || profile.username;
      $('viewerProfileDialogMeta').textContent = profile.optedOut === true
        ? `@${profile.username} · Opted out via !optout`
        : `@${profile.username} · persistent across streams`;
      $('viewerProfileUsername').disabled = true;
      $('viewerProfileUsername').value = profile.username || '';
      $('viewerProfileDisplayName').value = profile.displayName || '';
      $('viewerProfileAliases').value = (profile.aliases || []).join(', ');
      $('viewerProfilePinnedNotes').value = profile.pinnedNotes || '';
      $('viewerProfileEnabled').checked = profile.enabled !== false;
      $('viewerProfileLearningForUser').checked = profile.learningEnabled !== false;
      $('viewerProfileEnabled').disabled = profile.optedOut === true;
      $('viewerProfileLearningForUser').disabled = profile.optedOut === true;
      $('viewerProfileAliases').disabled = profile.optedOut === true;
      $('viewerProfilePinnedNotes').disabled = profile.optedOut === true;
      $('saveViewerProfileBtn').disabled = profile.optedOut === true;
      $('deleteViewerProfileBtn').hidden = profile.optedOut === true;
      renderFacts(profile);
    }
    showDialog();
  }

  async function loadSettings({ quiet = false } = {}) {
    if (!quiet) setSettingsMessage('Loading...');
    const d = await postJson('/viewer-profiles/settings/get', {});
    if (!d.success) return setSettingsMessage(d.error || 'Could not load viewer profile settings.', true);
    $('viewerProfileLearningEnabled').checked = d.settings?.automaticLearningEnabled !== false;
    $('viewerProfilesTaggedEnabled').checked = d.settings?.useInTaggedQuestions === true;
    if (!quiet) setSettingsMessage('Loaded.');
  }

  async function saveSettings() {
    $('saveViewerProfileSettingsBtn').disabled = true;
    setSettingsMessage('Saving...');
    const d = await postJson('/viewer-profiles/settings/save', {
      automaticLearningEnabled: $('viewerProfileLearningEnabled').checked,
      useInTaggedQuestions: $('viewerProfilesTaggedEnabled').checked
    });
    $('saveViewerProfileSettingsBtn').disabled = false;
    if (!d.success) return setSettingsMessage(d.error || 'Could not save viewer profile settings.', true);
    setSettingsMessage('Saved. Changes are live immediately.');
  }

  async function loadProfiles({ quiet = false } = {}) {
    if (!quiet) setMessage('Loading viewer profiles...');
    const d = await postJson('/viewer-profiles/list', {});
    if (!d.success) return setMessage(d.error || 'Could not load viewer profiles.', true);
    profiles = Array.isArray(d.profiles) ? d.profiles : [];
    loaded = true;
    renderList();
    setMessage(`${profiles.length} viewer profile${profiles.length === 1 ? '' : 's'} loaded.`);
  }

  async function saveProfile() {
    const username = $('viewerProfileUsername').value.trim();
    if (!username) return setDialogMessage('Twitch Username is required.', true);
    $('saveViewerProfileBtn').disabled = true;
    setDialogMessage('Saving...');
    const d = await postJson('/viewer-profiles/save', {
      username,
      displayName: $('viewerProfileDisplayName').value.trim(),
      aliases: $('viewerProfileAliases').value.split(',').map((item) => item.trim()).filter(Boolean),
      pinnedNotes: $('viewerProfilePinnedNotes').value,
      enabled: $('viewerProfileEnabled').checked,
      learningEnabled: $('viewerProfileLearningForUser').checked
    });
    $('saveViewerProfileBtn').disabled = false;
    if (!d.success) return setDialogMessage(d.error || 'Could not save viewer profile.', true);
    closeDialog();
    await loadProfiles({ quiet: true });
    setMessage(`Saved viewer profile for ${d.profile?.displayName || d.profile?.username || username}.`);
  }

  async function deleteProfile() {
    if (!editingId) return;
    const profile = profiles.find((item) => item.id === editingId);
    if (!confirm(`Delete the viewer profile for ${profile?.displayName || profile?.username || 'this viewer'}? This removes learned facts and moderator notes.`)) return;
    const d = await postJson('/viewer-profiles/delete', { id: editingId });
    if (!d.success) return setDialogMessage(d.error || 'Could not delete viewer profile.', true);
    closeDialog();
    await loadProfiles({ quiet: true });
    setMessage('Viewer profile deleted.');
  }

  try {
    const savedPageSize = Number(localStorage.getItem(PAGE_SIZE_STORAGE_KEY));
    if (VALID_PAGE_SIZES.has(savedPageSize)) $('viewerProfilePageSize').value = String(savedPageSize);
    const savedSort = localStorage.getItem(SORT_STORAGE_KEY);
    if (VALID_SORTS.has(savedSort)) $('viewerProfileSort').value = savedSort;
  } catch {}

  $('viewerProfileSearch').oninput = () => { currentPage = 1; renderList(); };
  $('viewerProfileSort').onchange = () => { currentPage = 1; try { localStorage.setItem(SORT_STORAGE_KEY, selectedSort()); } catch {} renderList(); };
  $('viewerProfilePageSize').onchange = () => { currentPage = 1; try { localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(selectedPageSize())); } catch {} renderList(); };
  $('viewerProfilePrevPage').onclick = () => { if (currentPage > 1) { currentPage--; renderList(); } };
  $('viewerProfileNextPage').onclick = () => { currentPage++; renderList(); };
  $('refreshViewerProfilesBtn').onclick = () => Promise.all([loadProfiles(), loadSettings()]);
  $('saveViewerProfileSettingsBtn').onclick = saveSettings;
  $('addViewerProfileBtn').onclick = () => openProfile();
  $('saveViewerProfileBtn').onclick = saveProfile;
  $('deleteViewerProfileBtn').onclick = deleteProfile;
  $('closeViewerProfileBtn').onclick = closeDialog;
  dialog.addEventListener('click', (event) => { if (event.target === dialog) closeDialog(); });

  return {
    async onVisibilityChange(visible) {
      if (!visible) {
        if (dialog.open) closeDialog();
        return;
      }
      if (!loaded) await Promise.all([loadProfiles(), loadSettings()]);
    },
    loadProfiles,
    loadSettings
  };
}
