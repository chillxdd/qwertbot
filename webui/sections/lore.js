export function initLoreSection({ $, postJson, maxLoreLength, maxBotPersonalityNameLength, maxBotPersonalityLength, maxBotPersonalityCooldownSeconds, botUsername, viewerProfiles }) {
  const maxLength = Number(maxLoreLength) || 12000;
  const personalityNameMaxLength = Number(maxBotPersonalityNameLength) || 80;
  const personalityMaxLength = Number(maxBotPersonalityLength) || 12000;
  const sessionMemoryPromptMaxLength = 6000;
  let learnedLoreObservations = [];
  let approvedLorePage = 1;
  const APPROVED_LORE_PAGE_SIZES = new Set([10, 25, 50]);
  const APPROVED_LORE_SORTS = new Set(['recent_desc', 'text_asc', 'text_desc', 'evidence_desc', 'confidence_desc', 'revision_desc']);
  $('streamLore').maxLength = maxLength;
  $('botPersonalityName').maxLength = personalityNameMaxLength;
  $('botPersonality').maxLength = personalityMaxLength;
  $('sessionMemoryPromptInstructions').maxLength = sessionMemoryPromptMaxLength;
  const taggedMention = String(botUsername || '').replace(/^@+/, '').trim();
  if ($('botTaggedQuestionMention')) $('botTaggedQuestionMention').textContent = taggedMention ? `@${taggedMention}` : '@<bot_username>';

  $('botPersonalityCooldown').min = 5;
  $('botPersonalityCooldown').max = Number(maxBotPersonalityCooldownSeconds) || 86400;
  $('botPersonalityCooldownResponse').maxLength = 500;
  $('botPersonalityRetryCount').max = 2;
  $('botPersonalityFailureResponse').maxLength = 500;
  $('botPersonalitySecurityRefusalResponse').maxLength = 500;

  function selectMemoryView(view) {
    const selected = ['lore', 'personality', 'profiles'].includes(view) ? view : 'lore';
    const loreSelected = selected === 'lore';
    const personalitySelected = selected === 'personality';
    const profilesSelected = selected === 'profiles';
    $('streamLoreView').classList.toggle('open', loreSelected);
    $('botPersonalityView').classList.toggle('open', personalitySelected);
    $('viewerProfilesView').classList.toggle('open', profilesSelected);
    $('streamLoreViewTab').classList.toggle('active', loreSelected);
    $('botPersonalityViewTab').classList.toggle('active', personalitySelected);
    $('viewerProfilesViewTab').classList.toggle('active', profilesSelected);
    $('streamLoreViewTab').setAttribute('aria-selected', loreSelected ? 'true' : 'false');
    $('botPersonalityViewTab').setAttribute('aria-selected', personalitySelected ? 'true' : 'false');
    $('viewerProfilesViewTab').setAttribute('aria-selected', profilesSelected ? 'true' : 'false');
    if (viewerProfiles?.onVisibilityChange) viewerProfiles.onVisibilityChange(profilesSelected);
  }

  function selectStreamLoreView(view) {
    const selected = view === 'manual' ? 'manual' : 'ai';
    const aiSelected = selected === 'ai';
    const manualSelected = selected === 'manual';
    $('streamLoreAiView').classList.toggle('open', aiSelected);
    $('streamLoreManualView').classList.toggle('open', manualSelected);
    $('streamLoreAiTab').classList.toggle('active', aiSelected);
    $('streamLoreManualTab').classList.toggle('active', manualSelected);
    $('streamLoreAiTab').setAttribute('aria-selected', aiSelected ? 'true' : 'false');
    $('streamLoreManualTab').setAttribute('aria-selected', manualSelected ? 'true' : 'false');
  }

  function updateCount() {
    $('loreCount').textContent = `${$('streamLore').value.length}/${maxLength} characters`;
  }

  function updatePersonalityCount() {
    $('botPersonalityCount').textContent = `${$('botPersonality').value.length}/${personalityMaxLength} characters`;
  }

  function updateSessionMemoryPromptCount() {
    $('sessionMemoryPromptCount').textContent = `${$('sessionMemoryPromptInstructions').value.length}/${sessionMemoryPromptMaxLength} characters`;
  }

  function syncCooldownResponseVisibility() {
    $('botPersonalityCooldownResponsePanel').hidden = !$('botPersonalityUseCooldownResponse').checked;
  }

  function syncAiRetryControls() {
    $('botPersonalityRetryCount').disabled = !$('botPersonalityRetryEnabled').checked;
  }

  function setAiRetrySettings(aiRetry = {}) {
    $('botPersonalityRetryEnabled').checked = aiRetry.enabled !== false;
    $('botPersonalityRetryCount').value = aiRetry.maxRetries ?? 2;
    $('botPersonalityFailureResponse').value = aiRetry.failureResponse ?? 'Sorry $user, my AI brain is overloaded right now. Try asking me again in a moment.';
    syncAiRetryControls();
  }

  function getAiRetrySettings() {
    return {
      enabled: $('botPersonalityRetryEnabled').checked,
      maxRetries: Number($('botPersonalityRetryCount').value),
      failureResponse: $('botPersonalityFailureResponse').value.trim()
    };
  }

  function setSessionMemorySettings(memory = {}) {
    $('sessionMemoryEnabled').checked = memory.enabled !== false;
    $('sessionMemoryRecentHours').value = memory.recentDetailedHours ?? 2;
    $('sessionMemoryMaxContext').value = memory.maxContextCharacters ?? 18000;
    $('sessionMemoryRecentChat').value = memory.recentChatMessages ?? 30;
    $('sessionMemoryRelevantOlder').value = memory.relevantOlderBlocks ?? 2;
    $('sessionMemoryPromptInstructions').value = memory.promptInstructions || '';
    updateSessionMemoryPromptCount();
  }

  function getSessionMemorySettings() {
    return {
      enabled: $('sessionMemoryEnabled').checked,
      recentDetailedHours: Number($('sessionMemoryRecentHours').value),
      maxContextCharacters: Number($('sessionMemoryMaxContext').value),
      recentChatMessages: Number($('sessionMemoryRecentChat').value),
      relevantOlderBlocks: Number($('sessionMemoryRelevantOlder').value),
      promptInstructions: $('sessionMemoryPromptInstructions').value
    };
  }

  function toggleSessionMemoryAdvanced(forceOpen = null) {
    const body = $('sessionMemorySettingsBody');
    const button = $('sessionMemorySettingsToggle');
    const open = forceOpen === null ? !body.classList.contains('open') : Boolean(forceOpen);
    body.classList.toggle('open', open);
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    button.textContent = open ? 'Hide Advanced Session Memory Settings' : 'Show Advanced Session Memory Settings';
  }


  function escLore(value) {
    return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function loreApprovalStatus(observation) {
    if (observation?.approvalStatus === 'approved' || observation?.approvalStatus === 'pending') return observation.approvalStatus;
    return observation?.enabled === true ? 'approved' : 'pending';
  }

  function approvedLorePageSize() {
    const value = Number($('streamLoreApprovedPageSize')?.value || 10);
    return APPROVED_LORE_PAGE_SIZES.has(value) ? value : 10;
  }

  function approvedLoreSort() {
    const value = $('streamLoreApprovedSort')?.value || 'recent_desc';
    return APPROVED_LORE_SORTS.has(value) ? value : 'recent_desc';
  }

  function filteredApprovedLore() {
    const query = String($('streamLoreApprovedSearch')?.value || '').trim().toLowerCase();
    const list = learnedLoreObservations.filter((item) => {
      if (loreApprovalStatus(item) !== 'approved') return false;
      const haystack = `${String(item.text || '')} ${String(item.revisionProposal?.text || '')}`.toLowerCase();
      return !query || haystack.includes(query);
    });
    const sort = approvedLoreSort();
    const confidenceRank = { high: 3, medium: 2, low: 1 };
    list.sort((a, b) => {
      if (sort === 'text_asc' || sort === 'text_desc') {
        const cmp = String(a.text || '').localeCompare(String(b.text || ''), undefined, { sensitivity: 'base' });
        return sort === 'text_desc' ? -cmp : cmp;
      }
      if (sort === 'evidence_desc') return Number(b.evidenceCount || 0) - Number(a.evidenceCount || 0);
      if (sort === 'confidence_desc') return (confidenceRank[b.confidence] || 0) - (confidenceRank[a.confidence] || 0) || Number(b.evidenceCount || 0) - Number(a.evidenceCount || 0);
      if (sort === 'revision_desc') return Number(Boolean(b.revisionProposal?.text)) - Number(Boolean(a.revisionProposal?.text)) || new Date(b.revisionProposal?.lastProposedAt || b.lastObservedAt || 0).getTime() - new Date(a.revisionProposal?.lastProposedAt || a.lastObservedAt || 0).getTime();
      return new Date(b.lastObservedAt || b.firstObservedAt || 0).getTime() - new Date(a.lastObservedAt || a.firstObservedAt || 0).getTime();
    });
    return list;
  }

  function renderLearnedLore(observations = learnedLoreObservations) {
    learnedLoreObservations = Array.isArray(observations) ? observations : [];
    const approvedAll = learnedLoreObservations.filter((item) => loreApprovalStatus(item) === 'approved');
    const pending = learnedLoreObservations.filter((item) => loreApprovalStatus(item) === 'pending');
    const pendingRevisions = approvedAll.filter((item) => item.revisionProposal?.text).length;
    $('streamLoreObservationCount').textContent = `${learnedLoreObservations.length} observation${learnedLoreObservations.length === 1 ? '' : 's'}`;
    $('streamLoreApprovedCount').textContent = `${approvedAll.length} approved${pendingRevisions ? ` · ${pendingRevisions} revision${pendingRevisions === 1 ? '' : 's'} to review` : ''}`;
    $('streamLorePendingCount').textContent = `${pending.length} pending`;

    const approved = filteredApprovedLore();
    const pageSize = approvedLorePageSize();
    const pageCount = Math.max(1, Math.ceil(approved.length / pageSize));
    approvedLorePage = Math.max(1, Math.min(approvedLorePage, pageCount));
    const page = approved.slice((approvedLorePage - 1) * pageSize, approvedLorePage * pageSize);

    $('streamLoreApprovedList').innerHTML = page.length ? page.map((observation) => {
      const proposal = observation.revisionProposal?.text ? observation.revisionProposal : null;
      const supportWindows = Math.max(1, Number(observation.supportingWindowCount || 1));
      const contradictions = Math.max(0, Number(observation.contradictionCount || 0));
      const revisions = Math.max(0, Number(observation.revisionCount || 0));
      const proposalEvidence = Math.max(1, Number(proposal?.evidenceCount || 1));
      const proposalWindows = Math.max(1, Number(proposal?.supportingWindowCount || 1));
      const revisionPanel = proposal ? `
        <div class="learned-revision-proposal ${proposal.relation === 'contradict' ? 'contradiction' : 'refinement'}">
          <div class="learned-revision-title"><strong>${proposal.relation === 'contradict' ? 'Conflicting evidence suggests a revision' : 'Suggested wording refinement'}</strong></div>
          <div class="learned-revision-text">${escLore(proposal.text)}</div>
          <div class="detail">${escLore(proposal.confidence || 'medium')} confidence · ${proposalEvidence} new evidence message${proposalEvidence === 1 ? '' : 's'} across ${proposalWindows} learning window${proposalWindows === 1 ? '' : 's'}</div>
          ${proposal.reason ? `<div class="detail learned-revision-reason">${escLore(proposal.reason)}</div>` : ''}
          <div class="custom-command-actions learned-revision-actions">
            <button class="success stream-lore-revision-accept" type="button">Accept Revision</button>
            <button class="secondary stream-lore-revision-dismiss" type="button">Keep Current</button>
          </div>
        </div>` : '';
      return `
      <div class="viewer-profile-fact ${observation.enabled === true ? '' : 'disabled'}" data-observation-id="${escLore(observation.id)}">
        <label class="inline-check"><input class="stream-lore-observation-toggle" type="checkbox" ${observation.enabled === true ? 'checked' : ''}> Use</label>
        <div class="viewer-profile-fact-copy">
          <div>${escLore(observation.text)}</div>
          <div class="detail">${escLore(observation.confidence || 'medium')} confidence · support ${Math.max(1, Number(observation.evidenceCount || 1))}x across ${supportWindows} window${supportWindows === 1 ? '' : 's'}${contradictions ? ` · conflicts ${contradictions}x` : ''}${revisions ? ` · revised ${revisions}x` : ''}${observation.lastObservedAt ? ` · last ${escLore(new Date(observation.lastObservedAt).toLocaleDateString())}` : ''}</div>
          ${observation.evidenceSummary ? `<div class="detail">${escLore(observation.evidenceSummary)}</div>` : ''}
          ${revisionPanel}
        </div>
        <button class="danger stream-lore-observation-unlearn" type="button">Unlearn</button>
      </div>`;
    }).join('') : `<div class="detail custom-empty-state">${approvedAll.length ? 'No approved lore matches your search.' : 'No approved AI-learned lore yet.'}</div>`;

    $('streamLoreApprovedPageLabel').textContent = `Page ${approvedLorePage} of ${pageCount}`;
    $('streamLoreApprovedPrevPage').disabled = approvedLorePage <= 1;
    $('streamLoreApprovedNextPage').disabled = approvedLorePage >= pageCount;
    $('streamLoreApprovedPagination').hidden = approved.length === 0;

    $('streamLorePendingList').innerHTML = pending.length ? pending.map((observation) => {
      const windows = Math.max(1, Number(observation.supportingWindowCount || 1));
      const refinements = Math.max(0, Number(observation.revisionCount || 0));
      return `
      <div class="viewer-profile-fact" data-observation-id="${escLore(observation.id)}">
        <div class="viewer-profile-fact-copy">
          <div>${escLore(observation.text)}</div>
          <div class="detail">${escLore(observation.confidence || 'medium')} confidence · support ${Math.max(1, Number(observation.evidenceCount || 1))}x across ${windows} window${windows === 1 ? '' : 's'}${refinements ? ` · auto-refined ${refinements}x` : ''}${observation.lastObservedAt ? ` · last ${escLore(new Date(observation.lastObservedAt).toLocaleDateString())}` : ''}</div>
          ${observation.evidenceSummary ? `<div class="detail">${escLore(observation.evidenceSummary)}</div>` : ''}
        </div>
        <div class="custom-command-actions">
          <button class="success stream-lore-observation-approve" type="button">Approve</button>
          <button class="danger stream-lore-observation-reject" type="button">Reject</button>
        </div>
      </div>`;
    }).join('') : '<div class="detail custom-empty-state">No pending AI-learned lore.</div>';

    $('streamLoreApprovedList').querySelectorAll('.stream-lore-observation-toggle').forEach((toggle) => {
      toggle.onchange = async () => {
        const row = toggle.closest('.viewer-profile-fact');
        toggle.disabled = true;
        const d = await postJson('/stream-lore/observation-toggle', { observationId: row.dataset.observationId, enabled: toggle.checked });
        toggle.disabled = false;
        if (!d.success) {
          toggle.checked = !toggle.checked;
          $('streamLoreObservationsMsg').textContent = d.error || 'Could not update learned lore.';
          return;
        }
        $('streamLoreObservationsMsg').textContent = toggle.checked ? 'Approved lore enabled for AI context.' : 'Approved lore kept but disabled for AI context.';
        renderLearnedLore(d.learnedObservations || []);
      };
    });

    $('streamLoreApprovedList').querySelectorAll('.stream-lore-observation-unlearn').forEach((button) => {
      button.onclick = async () => {
        const row = button.closest('.viewer-profile-fact');
        if (!window.confirm('Unlearn this approved stream lore observation? This permanently deletes it.')) return;
        button.disabled = true;
        const d = await postJson('/stream-lore/observation-unlearn', { observationId: row.dataset.observationId });
        if (!d.success) {
          button.disabled = false;
          $('streamLoreObservationsMsg').textContent = d.error || 'Could not unlearn stream lore.';
          return;
        }
        $('streamLoreObservationsMsg').textContent = 'Approved lore permanently unlearned.';
        renderLearnedLore(d.learnedObservations || []);
      };
    });

    $('streamLoreApprovedList').querySelectorAll('.stream-lore-revision-accept').forEach((button) => {
      button.onclick = async () => {
        const row = button.closest('.viewer-profile-fact');
        button.disabled = true;
        const d = await postJson('/stream-lore/observation-revision-accept', { observationId: row.dataset.observationId });
        if (!d.success) {
          button.disabled = false;
          $('streamLoreObservationsMsg').textContent = d.error || 'Could not accept the lore revision.';
          return;
        }
        $('streamLoreObservationsMsg').textContent = 'AI revision accepted. The approved lore wording has been updated.';
        renderLearnedLore(d.learnedObservations || []);
      };
    });

    $('streamLoreApprovedList').querySelectorAll('.stream-lore-revision-dismiss').forEach((button) => {
      button.onclick = async () => {
        const row = button.closest('.viewer-profile-fact');
        button.disabled = true;
        const d = await postJson('/stream-lore/observation-revision-dismiss', { observationId: row.dataset.observationId });
        if (!d.success) {
          button.disabled = false;
          $('streamLoreObservationsMsg').textContent = d.error || 'Could not keep the current lore wording.';
          return;
        }
        $('streamLoreObservationsMsg').textContent = 'Current wording kept. Recorded conflicts and any confidence adjustment remain; future evidence may suggest another revision.';
        renderLearnedLore(d.learnedObservations || []);
      };
    });

    $('streamLorePendingList').querySelectorAll('.stream-lore-observation-approve').forEach((button) => {
      button.onclick = async () => {
        const row = button.closest('.viewer-profile-fact');
        button.disabled = true;
        const d = await postJson('/stream-lore/observation-approve', { observationId: row.dataset.observationId });
        if (!d.success) {
          button.disabled = false;
          $('streamLoreObservationsMsg').textContent = d.error || 'Could not approve stream lore.';
          return;
        }
        $('streamLoreObservationsMsg').textContent = 'Lore approved and enabled.';
        renderLearnedLore(d.learnedObservations || []);
      };
    });

    $('streamLorePendingList').querySelectorAll('.stream-lore-observation-reject').forEach((button) => {
      button.onclick = async () => {
        const row = button.closest('.viewer-profile-fact');
        button.disabled = true;
        const d = await postJson('/stream-lore/observation-reject', { observationId: row.dataset.observationId });
        if (!d.success) {
          button.disabled = false;
          $('streamLoreObservationsMsg').textContent = d.error || 'Could not reject stream lore.';
          return;
        }
        $('streamLoreObservationsMsg').textContent = 'Pending lore rejected.';
        renderLearnedLore(d.learnedObservations || []);
      };
    });
  }

  async function loadLore() {
    try {
      $('loreMsg').textContent = 'Loading...';
      const d = await postJson('/stream-lore/get', {});
      if (!d.success) {
        $('loreMsg').textContent = d.error || 'Could not load lore.';
        return;
      }
      $('streamLore').value = d.text || '';
      renderLearnedLore(d.learnedObservations || []);
      $('streamLoreObservationsMsg').textContent = '';
      updateCount();
      $('loreMsg').textContent = d.updatedAt ? '' : 'No lore saved yet.';
    } catch (_) {
      $('loreMsg').textContent = 'Could not load lore.';
    }
  }

  async function saveLore() {
    try {
      $('saveLoreBtn').disabled = true;
      $('loreMsg').textContent = 'Saving...';
      const d = await postJson('/stream-lore/save', { text: $('streamLore').value });
      if (!d.success) {
        $('loreMsg').textContent = d.error || 'Could not save lore.';
        return;
      }
      $('streamLore').value = d.text || '';
      renderLearnedLore(d.learnedObservations || []);
      updateCount();
      $('loreMsg').textContent = d.text ? 'Saved.' : 'Lore cleared.';
    } catch (_) {
      $('loreMsg').textContent = 'Could not save lore.';
    } finally {
      $('saveLoreBtn').disabled = false;
    }
  }

  async function loadSessionMemoryStatus() {
    try {
      $('sessionMemoryStatus').textContent = 'Loading session memory status...';
      const d = await postJson('/session-memory/status', {});
      if (!d.success) {
        $('sessionMemoryStatus').textContent = d.error || 'Could not load session memory status.';
        return;
      }
      if (!d.streamLive) {
        $('sessionMemoryStatus').textContent = d.enabled === false
          ? 'Session Memory is disabled. No active stream memory is in use.'
          : 'Qwert is offline. Session Memory will start fresh with the next stream.';
        return;
      }
      const latest = d.latestBlockAt ? new Date(d.latestBlockAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'none yet';
      $('sessionMemoryStatus').textContent = `Active: ${d.blockCount || 0} completed block(s), ${(d.detailedCharacters || 0).toLocaleString()} detailed chars, ${(d.compactCharacters || 0).toLocaleString()} compact chars, ${d.currentWindowMessages || 0} current-window messages. Latest block: ${latest}.`;
    } catch (_) {
      $('sessionMemoryStatus').textContent = 'Could not load session memory status.';
    }
  }

  async function clearSessionMemory() {
    const confirmed = window.confirm('Clear all temporary Session Memory for the current live stream? This does not change Stream Lore, public recap history, or OAuth settings.');
    if (!confirmed) return;
    try {
      $('clearSessionMemoryBtn').disabled = true;
      $('sessionMemoryActionMsg').textContent = 'Clearing current session memory...';
      const d = await postJson('/session-memory/clear', {});
      $('sessionMemoryActionMsg').textContent = d.success ? (d.message || 'Current session memory cleared.') : (d.error || d.message || 'Could not clear session memory.');
      await loadSessionMemoryStatus();
    } catch (_) {
      $('sessionMemoryActionMsg').textContent = 'Could not clear current session memory.';
    } finally {
      $('clearSessionMemoryBtn').disabled = false;
    }
  }

  async function loadBotPersonality() {
    try {
      $('botPersonalityMsg').textContent = 'Loading...';
      const d = await postJson('/bot-personality/get', {});
      if (!d.success) {
        $('botPersonalityMsg').textContent = d.error || 'Could not load personality settings.';
        return;
      }
      $('botPersonalityName').value = d.name || '';
      $('botPersonality').value = d.personality || '';
      $('botPersonalityModsOnly').checked = d.audience === 'mods';
      $('botPersonalityModsBypassCooldown').checked = d.modsBypassCooldown !== false;
      $('botPersonalityCooldown').value = d.cooldownSeconds ?? 5;
      $('botPersonalityCooldownResponse').value = d.cooldownResponse || '';
      $('botPersonalityUseCooldownResponse').checked = Boolean(d.cooldownResponse);
      setAiRetrySettings(d.aiRetry || {});
      $('botPersonalitySecurityRefusalResponse').value = d.securityRefusalResponse || 'Cute. Chat does not get to rewrite my instructions or make me reveal them. Ask me an actual question.';
      setSessionMemorySettings(d.sessionMemory || {});
      syncCooldownResponseVisibility();
      updatePersonalityCount();
      $('botPersonalityMsg').textContent = d.updatedAt ? '' : 'No personality saved yet.';
      await loadSessionMemoryStatus();
    } catch (_) {
      $('botPersonalityMsg').textContent = 'Could not load personality settings.';
    }
  }

  async function saveBotPersonality() {
    const cooldownSeconds = Number($('botPersonalityCooldown').value);
    if (!Number.isFinite(cooldownSeconds) || cooldownSeconds < 5) {
      $('botPersonalityMsg').textContent = 'Cooldown must be at least 5 seconds.';
      $('botPersonalityCooldown').focus();
      return;
    }
    const retryCount = Number($('botPersonalityRetryCount').value);
    if (!Number.isFinite(retryCount) || retryCount < 0 || retryCount > 2 || !Number.isInteger(retryCount)) {
      $('botPersonalityMsg').textContent = 'AI retry count must be a whole number from 0 to 2.';
      $('botPersonalityRetryCount').focus();
      return;
    }
    try {
      $('saveBotPersonalityBtn').disabled = true;
      $('botPersonalityMsg').textContent = 'Saving...';
      const d = await postJson('/bot-personality/save', {
        name: $('botPersonalityName').value,
        personality: $('botPersonality').value,
        audience: $('botPersonalityModsOnly').checked ? 'mods' : 'everyone',
        cooldownSeconds,
        modsBypassCooldown: $('botPersonalityModsBypassCooldown').checked,
        cooldownResponse: $('botPersonalityUseCooldownResponse').checked ? $('botPersonalityCooldownResponse').value.trim() : '',
        aiRetry: getAiRetrySettings(),
        securityRefusalResponse: $('botPersonalitySecurityRefusalResponse').value.trim(),
        sessionMemory: getSessionMemorySettings()
      });
      if (!d.success) {
        $('botPersonalityMsg').textContent = d.error || 'Could not save personality settings.';
        return;
      }
      $('botPersonalityName').value = d.name || '';
      $('botPersonality').value = d.personality || '';
      $('botPersonalityModsOnly').checked = d.audience === 'mods';
      $('botPersonalityModsBypassCooldown').checked = d.modsBypassCooldown !== false;
      $('botPersonalityCooldown').value = d.cooldownSeconds ?? 5;
      $('botPersonalityCooldownResponse').value = d.cooldownResponse || '';
      $('botPersonalityUseCooldownResponse').checked = Boolean(d.cooldownResponse);
      setAiRetrySettings(d.aiRetry || {});
      $('botPersonalitySecurityRefusalResponse').value = d.securityRefusalResponse || 'Cute. Chat does not get to rewrite my instructions or make me reveal them. Ask me an actual question.';
      setSessionMemorySettings(d.sessionMemory || {});
      syncCooldownResponseVisibility();
      updatePersonalityCount();
      const audienceText = d.audience === 'everyone' ? 'Everyone can ask.' : 'Only Mods/Broadcaster can ask.';
      const cooldownText = ` Cooldown: ${d.cooldownSeconds}s${d.modsBypassCooldown ? ' (Mods/Broadcaster bypass).' : '.'}`;
      const retryText = d.aiRetry?.enabled === false ? ' AI retries: disabled.' : ` AI retries: ${d.aiRetry?.maxRetries ?? 2}.`;
      const memoryText = d.sessionMemory?.enabled === false ? ' Session Memory: disabled.' : ' Session Memory: enabled.';
      $('botPersonalityMsg').textContent = d.personality
        ? `Saved. ${audienceText}${cooldownText}${retryText}${memoryText}`
        : `Personality cleared; tagged AI answers are disabled. ${audienceText}${cooldownText}${retryText}${memoryText}`;
      await loadSessionMemoryStatus();
    } catch (_) {
      $('botPersonalityMsg').textContent = 'Could not save personality settings.';
    } finally {
      $('saveBotPersonalityBtn').disabled = false;
    }
  }

  $('streamLoreApprovedSearch').oninput = () => { approvedLorePage = 1; renderLearnedLore(); };
  $('streamLoreApprovedSort').onchange = () => { approvedLorePage = 1; renderLearnedLore(); };
  $('streamLoreApprovedPageSize').onchange = () => { approvedLorePage = 1; renderLearnedLore(); };
  $('streamLoreApprovedPrevPage').onclick = () => { if (approvedLorePage > 1) { approvedLorePage--; renderLearnedLore(); } };
  $('streamLoreApprovedNextPage').onclick = () => { approvedLorePage++; renderLearnedLore(); };
  $('streamLoreViewTab').onclick = () => selectMemoryView('lore');
  $('viewerProfilesViewTab').onclick = () => selectMemoryView('profiles');
  $('botPersonalityViewTab').onclick = () => selectMemoryView('personality');
  $('streamLoreAiTab').onclick = () => selectStreamLoreView('ai');
  $('streamLoreManualTab').onclick = () => selectStreamLoreView('manual');
  $('streamLore').oninput = updateCount;
  $('saveLoreBtn').onclick = saveLore;
  $('undoLoreBtn').onclick = loadLore;
  $('botPersonality').oninput = updatePersonalityCount;
  $('botPersonalityUseCooldownResponse').onchange = syncCooldownResponseVisibility;
  $('botPersonalityRetryEnabled').onchange = syncAiRetryControls;
  $('sessionMemoryPromptInstructions').oninput = updateSessionMemoryPromptCount;
  $('sessionMemorySettingsToggle').onclick = () => toggleSessionMemoryAdvanced();
  $('refreshSessionMemoryBtn').onclick = loadSessionMemoryStatus;
  $('clearSessionMemoryBtn').onclick = clearSessionMemory;
  $('saveBotPersonalityBtn').onclick = saveBotPersonality;
  $('undoBotPersonalityBtn').onclick = loadBotPersonality;
  updateCount();
  updatePersonalityCount();
  updateSessionMemoryPromptCount();
  syncCooldownResponseVisibility();
  syncAiRetryControls();
  toggleSessionMemoryAdvanced(false);
  selectStreamLoreView('ai');
  selectMemoryView('lore');
  return {
    loadLore,
    loadBotPersonality,
    loadSessionMemoryStatus,
    selectMemoryView,
    async loadMemory() {
      await Promise.all([loadLore(), loadBotPersonality()]);
    }
  };
}
