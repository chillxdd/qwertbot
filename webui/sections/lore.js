export function initLoreSection({ $, postJson, maxBotPersonalityNameLength, maxBotPersonalityLength, maxBotPersonalityCooldownSeconds, botUsername, viewerProfiles }) {
  const personalityNameMaxLength = Number(maxBotPersonalityNameLength) || 80;
  const personalityMaxLength = Number(maxBotPersonalityLength) || 12000;
  const sessionMemoryPromptMaxLength = 6000;
  let learnedLoreObservations = [];
  let manualLoreEntries = [];
  let manualLoreLimits = { maxEntries: 100, maxTextLength: 2400, maxSubjectLength: 80, maxAliases: 12, maxAliasLength: 80 };
  let loreDirectiveMaxResponseLength = 500;
  const DEFAULT_LORE_DIRECTIVE_CONFIG = {
    enabled: true,
    sendResponses: true,
    successResponse: '@$(user), got it — I queued that in Pending Stream Lore for review.',
    alreadyKnownResponse: '@$(user), that already matches existing Stream Lore.',
    failureResponse: '@$(user), I couldn\'t turn that into a lore proposal. Give me a little more context.'
  };
  let approvedLorePage = 1;
  const APPROVED_LORE_PAGE_SIZES = new Set([10, 25, 50]);
  const APPROVED_LORE_SORTS = new Set(['recent_desc', 'text_asc', 'text_desc', 'evidence_desc', 'confidence_desc', 'revision_desc']);
  $('botPersonalityName').maxLength = personalityNameMaxLength;
  $('botPersonality').maxLength = personalityMaxLength;
  $('sessionMemoryPromptInstructions').maxLength = sessionMemoryPromptMaxLength;
  const taggedMention = String(botUsername || '').replace(/^@+/, '').trim();
  if ($('botTaggedQuestionMention')) $('botTaggedQuestionMention').textContent = taggedMention ? `@${taggedMention}` : '@<bot_username>';
  if ($('streamLoreDirectiveMention')) $('streamLoreDirectiveMention').textContent = taggedMention ? `@${taggedMention}` : '@<bot_username>';

  $('botPersonalityCooldown').min = 5;
  $('botPersonalityCooldown').max = Number(maxBotPersonalityCooldownSeconds) || 86400;
  $('botPersonalityCooldownResponse').maxLength = 500;
  $('botPersonalityRecapBuffer').min = 0;
  $('botPersonalityRecapBuffer').max = 120;
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

  function escManual(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
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

  function syncLoreDirectiveResponseVisibility() {
    $('streamLoreDirectiveResponsePanel').hidden = !$('streamLoreDirectiveSendResponses').checked;
  }

  function setLoreDirectiveSettings(config = {}) {
    const merged = { ...DEFAULT_LORE_DIRECTIVE_CONFIG, ...(config || {}) };
    $('streamLoreDirectiveEnabled').checked = merged.enabled !== false;
    $('streamLoreDirectiveSendResponses').checked = merged.sendResponses !== false;
    $('streamLoreDirectiveSuccessResponse').value = merged.successResponse ?? DEFAULT_LORE_DIRECTIVE_CONFIG.successResponse;
    $('streamLoreDirectiveAlreadyKnownResponse').value = merged.alreadyKnownResponse ?? DEFAULT_LORE_DIRECTIVE_CONFIG.alreadyKnownResponse;
    $('streamLoreDirectiveFailureResponse').value = merged.failureResponse ?? DEFAULT_LORE_DIRECTIVE_CONFIG.failureResponse;
    for (const id of ['streamLoreDirectiveSuccessResponse', 'streamLoreDirectiveAlreadyKnownResponse', 'streamLoreDirectiveFailureResponse']) {
      $(id).maxLength = loreDirectiveMaxResponseLength;
    }
    syncLoreDirectiveResponseVisibility();
  }

  function getLoreDirectiveSettings() {
    return {
      enabled: $('streamLoreDirectiveEnabled').checked,
      sendResponses: $('streamLoreDirectiveSendResponses').checked,
      successResponse: $('streamLoreDirectiveSuccessResponse').value.trim(),
      alreadyKnownResponse: $('streamLoreDirectiveAlreadyKnownResponse').value.trim(),
      failureResponse: $('streamLoreDirectiveFailureResponse').value.trim()
    };
  }

  async function saveLoreDirectiveSettings() {
    $('saveStreamLoreDirectiveSettingsBtn').disabled = true;
    $('streamLoreDirectiveMsg').textContent = 'Saving...';
    try {
      const d = await postJson('/stream-lore/directive-settings-save', getLoreDirectiveSettings());
      if (!d.success) {
        $('streamLoreDirectiveMsg').textContent = d.error || 'Could not save lore directive settings.';
        return;
      }
      loreDirectiveMaxResponseLength = Number(d.directiveLimits?.maxResponseLength || loreDirectiveMaxResponseLength || 500);
      setLoreDirectiveSettings(d.directiveConfig || {});
      $('streamLoreDirectiveMsg').textContent = d.directiveConfig?.enabled === false
        ? 'Lore directives disabled.'
        : `Saved. Clear mod/broadcaster lore-save instructions are enabled${d.directiveConfig?.sendResponses === false ? ' without chat confirmations.' : ' with chat confirmations.'}`;
    } catch (_) {
      $('streamLoreDirectiveMsg').textContent = 'Could not save lore directive settings.';
    } finally {
      $('saveStreamLoreDirectiveSettingsBtn').disabled = false;
    }
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
    const pendingNew = learnedLoreObservations.filter((item) => loreApprovalStatus(item) === 'pending');
    const pendingRevisions = approvedAll.filter((item) => item.revisionProposal?.text);
    const pendingReviews = [
      ...pendingNew.map((observation) => ({ type: 'new', observation, sortAt: observation.lastObservedAt || observation.firstObservedAt })),
      ...pendingRevisions.map((observation) => ({ type: 'revision', observation, sortAt: observation.revisionProposal?.lastProposedAt || observation.lastObservedAt || observation.firstObservedAt }))
    ].sort((a, b) => new Date(b.sortAt || 0).getTime() - new Date(a.sortAt || 0).getTime());

    $('streamLoreObservationCount').textContent = `${learnedLoreObservations.length} observation${learnedLoreObservations.length === 1 ? '' : 's'}`;
    $('streamLoreApprovedCount').textContent = `${approvedAll.length} approved`;
    $('streamLorePendingCount').textContent = `${pendingReviews.length} pending review${pendingReviews.length === 1 ? '' : 's'}`;

    const approved = filteredApprovedLore();
    const pageSize = approvedLorePageSize();
    const pageCount = Math.max(1, Math.ceil(approved.length / pageSize));
    approvedLorePage = Math.max(1, Math.min(approvedLorePage, pageCount));
    const page = approved.slice((approvedLorePage - 1) * pageSize, approvedLorePage * pageSize);

    $('streamLoreApprovedList').innerHTML = page.length ? page.map((observation) => {
      const supportWindows = Math.max(1, Number(observation.supportingWindowCount || 1));
      const contradictions = Math.max(0, Number(observation.contradictionCount || 0));
      const revisions = Math.max(0, Number(observation.revisionCount || 0));
      const hasRevision = Boolean(observation.revisionProposal?.text);
      return `
      <div class="viewer-profile-fact ${observation.enabled === true ? '' : 'disabled'}" data-observation-id="${escLore(observation.id)}">
        <label class="inline-check"><input class="stream-lore-observation-toggle" type="checkbox" ${observation.enabled === true ? 'checked' : ''}> Use</label>
        <div class="viewer-profile-fact-copy">
          <div>${escLore(observation.text)}</div>
          <div class="detail">${escLore(observation.confidence || 'medium')} confidence · support ${Math.max(1, Number(observation.evidenceCount || 1))}x across ${supportWindows} window${supportWindows === 1 ? '' : 's'}${contradictions ? ` · conflicts ${contradictions}x` : ''}${revisions ? ` · revised ${revisions}x` : ''}${hasRevision ? ' · revision pending review' : ''}${observation.lastObservedAt ? ` · last ${escLore(new Date(observation.lastObservedAt).toLocaleDateString())}` : ''}</div>
          ${observation.evidenceSummary ? `<div class="detail">${escLore(observation.evidenceSummary)}</div>` : ''}
        </div>
        <button class="danger stream-lore-observation-unlearn" type="button">Unlearn</button>
      </div>`;
    }).join('') : `<div class="detail custom-empty-state">${approvedAll.length ? 'No approved lore matches your search.' : 'No approved AI-learned lore yet.'}</div>`;

    $('streamLoreApprovedPageLabel').textContent = `Page ${approvedLorePage} of ${pageCount}`;
    $('streamLoreApprovedPrevPage').disabled = approvedLorePage <= 1;
    $('streamLoreApprovedNextPage').disabled = approvedLorePage >= pageCount;
    $('streamLoreApprovedPagination').hidden = approved.length === 0;

    $('streamLorePendingList').innerHTML = pendingReviews.length ? pendingReviews.map(({ type, observation }) => {
      if (type === 'revision') {
        const proposal = observation.revisionProposal;
        const proposalEvidence = Math.max(1, Number(proposal?.evidenceCount || 1));
        const proposalWindows = Math.max(1, Number(proposal?.supportingWindowCount || 1));
        return `
        <div class="viewer-profile-fact" data-observation-id="${escLore(observation.id)}" data-review-type="revision">
          <div class="viewer-profile-fact-copy">
            <div class="learned-revision-title"><strong>${proposal.relation === 'contradict' ? 'Suggested revision from conflicting evidence' : 'Suggested revision'}</strong></div>
            <div class="detail"><strong>Current approved:</strong> ${escLore(observation.text)}</div>
            <div class="learned-revision-proposal ${proposal.relation === 'contradict' ? 'contradiction' : 'refinement'}">
              <div class="learned-revision-text"><strong>Suggested:</strong> ${escLore(proposal.text)}</div>
              <div class="detail">${escLore(proposal.confidence || 'medium')} confidence · ${proposalEvidence} new evidence message${proposalEvidence === 1 ? '' : 's'} across ${proposalWindows} learning window${proposalWindows === 1 ? '' : 's'}</div>
              ${proposal.reason ? `<div class="detail learned-revision-reason">${escLore(proposal.reason)}</div>` : ''}
            </div>
          </div>
          <div class="custom-command-actions learned-revision-actions">
            <button class="success stream-lore-revision-accept" type="button">Accept Revision</button>
            <button class="secondary stream-lore-revision-dismiss" type="button">Keep Current</button>
          </div>
        </div>`;
      }

      const windows = Math.max(1, Number(observation.supportingWindowCount || 1));
      const refinements = Math.max(0, Number(observation.revisionCount || 0));
      return `
      <div class="viewer-profile-fact" data-observation-id="${escLore(observation.id)}" data-review-type="new">
        <div class="viewer-profile-fact-copy">
          <div class="learned-revision-title"><strong>${observation.origin === 'moderator_directive' ? 'Moderator-directed lore' : 'New AI-learned lore'}</strong></div>
          <div>${escLore(observation.text)}</div>
          <div class="detail">${escLore(observation.confidence || 'medium')} confidence · support ${Math.max(1, Number(observation.evidenceCount || 1))}x across ${windows} window${windows === 1 ? '' : 's'}${refinements ? ` · auto-refined ${refinements}x` : ''}${observation.lastObservedAt ? ` · last ${escLore(new Date(observation.lastObservedAt).toLocaleDateString())}` : ''}</div>
          ${observation.evidenceSummary ? `<div class="detail">${escLore(observation.evidenceSummary)}</div>` : ''}
        </div>
        <div class="custom-command-actions">
          <button class="success stream-lore-observation-approve" type="button">Approve</button>
          <button class="danger stream-lore-observation-reject" type="button">Reject</button>
        </div>
      </div>`;
    }).join('') : '<div class="detail custom-empty-state">No pending AI-learned lore or suggested revisions.</div>';

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

    $('streamLorePendingList').querySelectorAll('.stream-lore-revision-accept').forEach((button) => {
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

    $('streamLorePendingList').querySelectorAll('.stream-lore-revision-dismiss').forEach((button) => {
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

  function syncManualLoreEditorScope() {
    const subjectMode = $('manualLoreScope').value === 'subject';
    $('manualLoreAliasesPanel').hidden = !subjectMode;
    $('manualLoreSubjectLabel').innerHTML = subjectMode ? 'Subject <span class="detail">(required)</span>' : 'Label <span class="detail">(optional)</span>';
    $('manualLoreSubject').placeholder = subjectMode ? 'Example: Motmo_' : 'Example: Chat culture';
    $('manualLoreSubjectHelp').textContent = subjectMode
      ? 'The subject or any alias must be referenced before this card is loaded into a Tagged Question.'
      : 'Global lore is always available as background context; this label is only for organization.';
  }

  function updateManualLoreTextCount() {
    const max = Number(manualLoreLimits.maxTextLength || 2400);
    $('manualLoreTextCount').textContent = `${$('manualLoreText').value.length}/${max} characters`;
  }

  function renderManualLore(entries = manualLoreEntries) {
    manualLoreEntries = Array.isArray(entries) ? entries : [];
    $('manualLoreCount').textContent = `${manualLoreEntries.length} entr${manualLoreEntries.length === 1 ? 'y' : 'ies'}`;
    $('manualLoreList').innerHTML = manualLoreEntries.length ? manualLoreEntries.map((entry) => {
      const scope = entry.scope === 'subject' ? 'Subject-specific' : 'Global';
      const title = entry.subject || (entry.scope === 'subject' ? 'Unnamed subject' : 'Global lore');
      const aliases = Array.isArray(entry.aliases) && entry.aliases.length ? `<div class="detail">Aliases: ${escManual(entry.aliases.join(', '))}</div>` : '';
      return `<div class="manual-lore-card ${entry.enabled === false ? 'disabled' : ''}" data-entry-id="${escManual(entry.id)}">
        <div class="manual-lore-card-header"><div><div class="manual-lore-card-title"><span class="manual-lore-badge">${escManual(scope)}</span><span>${escManual(title)}</span></div>${aliases}</div></div>
        <div class="manual-lore-card-text">${escManual(entry.text)}</div>
        <div class="manual-lore-card-actions">
          <label class="inline-check"><input class="manual-lore-toggle" type="checkbox" ${entry.enabled !== false ? 'checked' : ''}> Use</label>
          <button class="secondary manual-lore-edit" type="button">Edit</button>
          <button class="danger manual-lore-delete" type="button">Delete</button>
        </div>
      </div>`;
    }).join('') : '<div class="detail custom-empty-state">No manual lore cards yet. Add Global lore for channel-wide context, or Subject-specific lore for a person, character, entity, or topic.</div>';

    $('manualLoreList').querySelectorAll('.manual-lore-edit').forEach((button) => {
      button.onclick = () => {
        const id = button.closest('.manual-lore-card').dataset.entryId;
        openManualLoreEditor(manualLoreEntries.find((entry) => entry.id === id));
      };
    });
    $('manualLoreList').querySelectorAll('.manual-lore-toggle').forEach((toggle) => {
      toggle.onchange = async () => {
        const row = toggle.closest('.manual-lore-card'); toggle.disabled = true;
        const d = await postJson('/stream-lore/manual-entry-toggle', { entryId: row.dataset.entryId, enabled: toggle.checked });
        toggle.disabled = false;
        if (!d.success) { toggle.checked = !toggle.checked; $('loreMsg').textContent = d.error || 'Could not update lore entry.'; return; }
        renderManualLore(d.manualEntries || []); $('loreMsg').textContent = toggle.checked ? 'Lore entry enabled.' : 'Lore entry disabled.';
      };
    });
    $('manualLoreList').querySelectorAll('.manual-lore-delete').forEach((button) => {
      button.onclick = async () => {
        const row = button.closest('.manual-lore-card');
        if (!window.confirm('Delete this manual lore entry?')) return;
        button.disabled = true;
        const d = await postJson('/stream-lore/manual-entry-delete', { entryId: row.dataset.entryId });
        if (!d.success) { button.disabled = false; $('loreMsg').textContent = d.error || 'Could not delete lore entry.'; return; }
        renderManualLore(d.manualEntries || []); $('loreMsg').textContent = 'Lore entry deleted.';
      };
    });
  }

  function openManualLoreEditor(entry = null) {
    $('manualLoreDialogTitle').textContent = entry ? 'Edit Lore Entry' : 'Add Lore Entry';
    $('manualLoreId').value = entry?.id || '';
    $('manualLoreScope').value = entry?.scope === 'subject' ? 'subject' : 'global';
    $('manualLoreSubject').value = entry?.subject || '';
    $('manualLoreAliases').value = Array.isArray(entry?.aliases) ? entry.aliases.join(', ') : '';
    $('manualLoreText').value = entry?.text || '';
    $('manualLoreEnabled').checked = entry?.enabled !== false;
    $('manualLoreDialogMsg').textContent = '';
    syncManualLoreEditorScope(); updateManualLoreTextCount();
    $('manualLoreDialog').showModal();
  }

  async function saveManualLoreEditor() {
    const scope = $('manualLoreScope').value;
    const subject = $('manualLoreSubject').value.trim();
    const text = $('manualLoreText').value.trim();
    if (scope === 'subject' && !subject) { $('manualLoreDialogMsg').textContent = 'Subject-specific lore requires a subject.'; return; }
    if (!text) { $('manualLoreDialogMsg').textContent = 'Lore text is required.'; return; }
    $('saveManualLoreEntryBtn').disabled = true; $('manualLoreDialogMsg').textContent = 'Saving...';
    const d = await postJson('/stream-lore/manual-entry-save', { id: $('manualLoreId').value || undefined, scope, subject, aliases: $('manualLoreAliases').value, text, enabled: $('manualLoreEnabled').checked });
    $('saveManualLoreEntryBtn').disabled = false;
    if (!d.success) { $('manualLoreDialogMsg').textContent = d.error || 'Could not save lore entry.'; return; }
    renderManualLore(d.manualEntries || []); $('manualLoreDialog').close(); $('loreMsg').textContent = 'Manual lore saved.';
  }

  async function loadLore() {
    try {
      $('loreMsg').textContent = 'Loading...';
      const d = await postJson('/stream-lore/get', {});
      if (!d.success) { $('loreMsg').textContent = d.error || 'Could not load lore.'; return; }
      manualLoreLimits = { ...manualLoreLimits, ...(d.manualLimits || {}) };
      loreDirectiveMaxResponseLength = Number(d.directiveLimits?.maxResponseLength || loreDirectiveMaxResponseLength || 500);
      setLoreDirectiveSettings(d.directiveConfig || {});
      $('manualLoreText').maxLength = Number(manualLoreLimits.maxTextLength || 2400);
      $('manualLoreSubject').maxLength = Number(manualLoreLimits.maxSubjectLength || 80);
      renderManualLore(d.manualEntries || []);
      renderLearnedLore(d.learnedObservations || []);
      $('streamLoreObservationsMsg').textContent = '';
      $('loreMsg').textContent = '';
    } catch (_) { $('loreMsg').textContent = 'Could not load lore.'; }
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
      $('botPersonalityRecapBuffer').value = d.recapCollisionBufferSeconds ?? 12;
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
    const recapCollisionBufferSeconds = Number($('botPersonalityRecapBuffer').value);
    if (!Number.isFinite(recapCollisionBufferSeconds) || recapCollisionBufferSeconds < 0 || recapCollisionBufferSeconds > 120 || !Number.isInteger(recapCollisionBufferSeconds)) {
      $('botPersonalityMsg').textContent = 'Recap Collision Buffer must be a whole number from 0 to 120 seconds.';
      $('botPersonalityRecapBuffer').focus();
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
        recapCollisionBufferSeconds,
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
      $('botPersonalityRecapBuffer').value = d.recapCollisionBufferSeconds ?? 12;
      $('botPersonalityCooldownResponse').value = d.cooldownResponse || '';
      $('botPersonalityUseCooldownResponse').checked = Boolean(d.cooldownResponse);
      setAiRetrySettings(d.aiRetry || {});
      $('botPersonalitySecurityRefusalResponse').value = d.securityRefusalResponse || 'Cute. Chat does not get to rewrite my instructions or make me reveal them. Ask me an actual question.';
      setSessionMemorySettings(d.sessionMemory || {});
      syncCooldownResponseVisibility();
      updatePersonalityCount();
      const audienceText = d.audience === 'everyone' ? 'Everyone can ask.' : 'Only Mods/Broadcaster can ask.';
      const cooldownText = ` Cooldown: ${d.cooldownSeconds}s${d.modsBypassCooldown ? ' (Mods/Broadcaster bypass).' : '.'}`;
      const recapBufferText = ` Recap buffer: ${d.recapCollisionBufferSeconds ?? 12}s.`;
      const retryText = d.aiRetry?.enabled === false ? ' AI retries: disabled.' : ` AI retries: ${d.aiRetry?.maxRetries ?? 2}.`;
      const memoryText = d.sessionMemory?.enabled === false ? ' Session Memory: disabled.' : ' Session Memory: enabled.';
      $('botPersonalityMsg').textContent = d.personality
        ? `Saved. ${audienceText}${cooldownText}${recapBufferText}${retryText}${memoryText}`
        : `Personality cleared; tagged AI answers are disabled. ${audienceText}${cooldownText}${recapBufferText}${retryText}${memoryText}`;
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
  $('streamLoreDirectiveSendResponses').onchange = syncLoreDirectiveResponseVisibility;
  $('saveStreamLoreDirectiveSettingsBtn').onclick = saveLoreDirectiveSettings;
  $('addManualLoreBtn').onclick = () => openManualLoreEditor();
  $('manualLoreScope').onchange = syncManualLoreEditorScope;
  $('manualLoreText').oninput = updateManualLoreTextCount;
  $('saveManualLoreEntryBtn').onclick = saveManualLoreEditor;
  $('cancelManualLoreEntryBtn').onclick = () => $('manualLoreDialog').close();
  $('manualLoreDialogClose').onclick = () => $('manualLoreDialog').close();
  $('botPersonality').oninput = updatePersonalityCount;
  $('botPersonalityUseCooldownResponse').onchange = syncCooldownResponseVisibility;
  $('botPersonalityRetryEnabled').onchange = syncAiRetryControls;
  $('sessionMemoryPromptInstructions').oninput = updateSessionMemoryPromptCount;
  $('sessionMemorySettingsToggle').onclick = () => toggleSessionMemoryAdvanced();
  $('refreshSessionMemoryBtn').onclick = loadSessionMemoryStatus;
  $('clearSessionMemoryBtn').onclick = clearSessionMemory;
  $('saveBotPersonalityBtn').onclick = saveBotPersonality;
  $('undoBotPersonalityBtn').onclick = loadBotPersonality;
  updatePersonalityCount();
  updateSessionMemoryPromptCount();
  syncCooldownResponseVisibility();
  syncAiRetryControls();
  setLoreDirectiveSettings(DEFAULT_LORE_DIRECTIVE_CONFIG);
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
