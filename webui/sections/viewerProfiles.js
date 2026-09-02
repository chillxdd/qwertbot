export function initViewerProfilesSection({ $, esc, postJson }) {
  let profiles = [];
  let loaded = false;
  let currentPage = 1;
  let editingId = null;
  let factCurrentPage = 1;
  let currentProfileFacts = [];
  const FACT_PAGE_SIZES = new Set([10, 25, 50]);
  const FACT_SORTS = new Set(['recent_desc', 'text_asc', 'text_desc', 'evidence_desc', 'confidence_desc', 'revision_desc']);
  const PAGE_SIZE_STORAGE_KEY = 'sqwert-viewer-profile-page-size';
  const SORT_STORAGE_KEY = 'sqwert-viewer-profile-sort';
  const PENDING_CONFIDENCE_FILTERS = new Set(['all', 'high', 'medium', 'low']);
  const PENDING_CONFIDENCE_STORAGE_KEY = 'sqwert-viewer-pending-confidence-filter';
  const PENDING_FACT_CONFIDENCE_STORAGE_KEY = 'sqwert-viewer-profile-pending-confidence-filter';
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

  function setPendingReviewMessage(text, isError = false) {
    const el = $('viewerProfilePendingReviewMsg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('bad', Boolean(isError));
  }

  function setBulkCleanupMessage(text, isError = false) {
    const el = $('viewerProfileBulkCleanupMsg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('bad', Boolean(isError));
  }

  function selectedPendingConfidence() {
    const value = String($('viewerProfilePendingConfidenceFilter')?.value || 'all').toLowerCase();
    return PENDING_CONFIDENCE_FILTERS.has(value) ? value : 'all';
  }

  function selectedPendingFactConfidence() {
    const value = String($('viewerProfilePendingFactConfidenceFilter')?.value || 'all').toLowerCase();
    return PENDING_CONFIDENCE_FILTERS.has(value) ? value : 'all';
  }

  function pendingReviewConfidence(type, fact) {
    if (type === 'revision') return String(fact?.revisionProposal?.confidence || 'medium').toLowerCase();
    return String(fact?.confidence || 'medium').toLowerCase();
  }

  function pendingReviewsAcrossProfiles() {
    return profiles.flatMap((profile) => {
      const facts = Array.isArray(profile.facts) ? profile.facts : [];
      const pendingNew = facts
        .filter((fact) => factApprovalStatus(fact) === 'pending' && fact.source !== 'deterministic')
        .map((fact) => ({ type: 'new', profile, fact, sortAt: fact.lastObservedAt || fact.firstObservedAt || profile.updatedAt }));
      const pendingRevisions = facts
        .filter((fact) => factApprovalStatus(fact) === 'approved' && fact.source !== 'deterministic' && fact.revisionProposal?.text)
        .map((fact) => ({ type: 'revision', profile, fact, sortAt: fact.revisionProposal?.lastProposedAt || fact.lastObservedAt || profile.updatedAt }));
      return [...pendingNew, ...pendingRevisions];
    }).sort((a, b) => new Date(b.sortAt || 0).getTime() - new Date(a.sortAt || 0).getTime());
  }

  function renderPendingReview() {
    const listEl = $('viewerProfilePendingReviewList');
    const countEl = $('viewerProfilePendingReviewCount');
    if (!listEl || !countEl) return;
    const pendingAll = pendingReviewsAcrossProfiles();
    const pendingConfidence = selectedPendingConfidence();
    const pending = pendingConfidence === 'all'
      ? pendingAll
      : pendingAll.filter(({ type, fact }) => pendingReviewConfidence(type, fact) === pendingConfidence);
    countEl.textContent = pendingConfidence === 'all'
      ? `${pendingAll.length} pending review${pendingAll.length === 1 ? '' : 's'}`
      : `${pending.length} of ${pendingAll.length} pending reviews`;
    listEl.innerHTML = pending.length ? pending.map(({ type, profile, fact }) => {
      const displayName = profile.displayName || profile.username || 'Unknown viewer';
      const disabled = profile.optedOut === true ? 'disabled' : '';
      if (type === 'revision') {
        const proposal = fact.revisionProposal;
        const proposalEvidence = Math.max(1, Number(proposal?.evidenceCount || 1));
        const proposalWindows = Math.max(1, Number(proposal?.supportingWindowCount || 1));
        return `<div class="viewer-profile-fact viewer-profile-pending-review-row" data-profile-id="${esc(profile.id)}" data-fact-id="${esc(fact.id)}" data-review-type="revision">
          <div class="viewer-profile-fact-copy">
            <div class="viewer-pending-profile"><strong>${esc(displayName)}</strong> <span class="detail">@${esc(profile.username || '')}</span>${profile.optedOut === true ? ' <span class="custom-command-state disabled">Opted out</span>' : ''}</div>
            <div class="learned-revision-title"><strong>${proposal.relation === 'contradict' ? 'Suggested revision from conflicting evidence' : 'Suggested revision'}</strong></div>
            <div class="detail"><strong>Current approved:</strong> ${esc(fact.text)}</div>
            <div class="learned-revision-proposal ${proposal.relation === 'contradict' ? 'contradiction' : 'refinement'}">
              <div class="learned-revision-text"><strong>Suggested:</strong> ${esc(proposal.text)}</div>
              <div class="detail">${esc(proposal.kind || fact.kind || 'fact')} · ${esc(proposal.confidence || 'medium')} confidence · ${proposalEvidence} new evidence message${proposalEvidence === 1 ? '' : 's'} across ${proposalWindows} learning window${proposalWindows === 1 ? '' : 's'}</div>
              ${proposal.reason ? `<div class="detail learned-revision-reason">${esc(proposal.reason)}</div>` : ''}
            </div>
          </div>
          <div class="custom-command-actions learned-revision-actions">
            <button class="success viewer-global-revision-accept" type="button" ${disabled}>Accept Revision</button>
            <button class="secondary viewer-global-revision-dismiss" type="button" ${disabled}>Keep Current</button>
          </div>
        </div>`;
      }

      const windows = Math.max(1, Number(fact.supportingWindowCount || 1));
      const refinements = Math.max(0, Number(fact.revisionCount || 0));
      return `<div class="viewer-profile-fact viewer-profile-pending-review-row" data-profile-id="${esc(profile.id)}" data-fact-id="${esc(fact.id)}" data-review-type="new">
        <div class="viewer-profile-fact-copy">
          <div class="viewer-pending-profile"><strong>${esc(displayName)}</strong> <span class="detail">@${esc(profile.username || '')}</span>${profile.optedOut === true ? ' <span class="custom-command-state disabled">Opted out</span>' : ''}</div>
          <div class="learned-revision-title"><strong>New AI observation</strong></div>
          <div>${esc(fact.text)}</div>
          <div class="detail">${esc(fact.kind || 'fact')} · AI · ${esc(fact.confidence || 'medium')} confidence · support ${Number(fact.evidenceCount || 1)}x across ${windows} window${windows === 1 ? '' : 's'}${refinements ? ` · auto-refined ${refinements}x` : ''}${fact.lastObservedAt ? ` · last ${esc(new Date(fact.lastObservedAt).toLocaleDateString())}` : ''}</div>
          ${fact.evidenceSummary ? `<div class="detail">${esc(fact.evidenceSummary)}</div>` : ''}
        </div>
        <div class="custom-command-actions">
          <button class="success viewer-global-fact-approve" type="button" ${disabled}>Approve</button>
          <button class="danger viewer-global-fact-reject" type="button" ${disabled}>Reject</button>
        </div>
      </div>`;
    }).join('') : `<div class="detail custom-empty-state">${pendingConfidence === 'all' ? 'No pending AI viewer observations or suggested revisions.' : `No ${esc(pendingConfidence)}-confidence pending viewer observations or revisions.`}</div>`;

    listEl.querySelectorAll('.viewer-global-fact-approve, .viewer-global-fact-reject').forEach((button) => {
      button.onclick = async () => {
        const row = button.closest('.viewer-profile-pending-review-row');
        const profileId = row?.dataset.profileId;
        const factId = row?.dataset.factId;
        if (!profileId || !factId) return;
        const approving = button.classList.contains('viewer-global-fact-approve');
        button.disabled = true;
        setPendingReviewMessage(approving ? 'Approving observation...' : 'Rejecting observation...');
        const d = await postJson(approving ? '/viewer-profiles/fact-approve' : '/viewer-profiles/fact-reject', { profileId, factId });
        if (!d.success) {
          button.disabled = false;
          return setPendingReviewMessage(d.error || `Could not ${approving ? 'approve' : 'reject'} observation.`, true);
        }
        const index = profiles.findIndex((item) => item.id === profileId);
        if (index >= 0) profiles[index] = d.profile;
        if (editingId === profileId && dialog.open) renderFacts(d.profile);
        renderList();
        setPendingReviewMessage(approving ? 'Observation approved and enabled.' : 'Pending observation rejected.');
      };
    });

    listEl.querySelectorAll('.viewer-global-revision-accept, .viewer-global-revision-dismiss').forEach((button) => {
      button.onclick = async () => {
        const row = button.closest('.viewer-profile-pending-review-row');
        const profileId = row?.dataset.profileId;
        const factId = row?.dataset.factId;
        if (!profileId || !factId) return;
        const accepting = button.classList.contains('viewer-global-revision-accept');
        button.disabled = true;
        setPendingReviewMessage(accepting ? 'Accepting revision...' : 'Keeping current wording...');
        const d = await postJson(accepting ? '/viewer-profiles/fact-revision-accept' : '/viewer-profiles/fact-revision-dismiss', { profileId, factId });
        if (!d.success) {
          button.disabled = false;
          return setPendingReviewMessage(d.error || `Could not ${accepting ? 'accept the revision' : 'keep the current wording'}.`, true);
        }
        const index = profiles.findIndex((item) => item.id === profileId);
        if (index >= 0) profiles[index] = d.profile;
        if (editingId === profileId && dialog.open) renderFacts(d.profile);
        renderList();
        setPendingReviewMessage(accepting ? 'AI revision accepted. The approved observation wording has been updated.' : 'Current wording kept. Future evidence may suggest another revision.');
      };
    });
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
      ...(profile.facts || []).flatMap((fact) => [fact.text, fact.revisionProposal?.text || ''])
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
        const approvedFacts = (profile.facts || []).filter((fact) => (fact.approvalStatus || 'approved') === 'approved');
        const activeFacts = approvedFacts.filter((fact) => fact.enabled !== false).length;
        const pendingFacts = (profile.facts || []).filter((fact) => fact.approvalStatus === 'pending').length;
        const pendingRevisions = approvedFacts.filter((fact) => fact.revisionProposal?.text).length;
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
            <div class="detail">${activeFacts} active approved observation${activeFacts === 1 ? '' : 's'}${pendingFacts ? ` · ${pendingFacts} pending` : ''}${pendingRevisions ? ` · ${pendingRevisions} revision${pendingRevisions === 1 ? '' : 's'} to review` : ''}${aliases}</div>
            ${profile.optedOut === true ? `<div class="detail">${profile.profileDataPurgedAt ? 'Stored profile content deleted after opt-out retention.' : profile.profileRetentionExpiresAt ? `Stored profile retained until ${esc(new Date(profile.profileRetentionExpiresAt).toLocaleDateString())}.` : 'Profile learning and use are paused.'}</div>` : ''}
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
    renderPendingReview();
  }

  function factApprovalStatus(fact) {
    if (fact?.approvalStatus === 'pending' || fact?.approvalStatus === 'approved') return fact.approvalStatus;
    return 'approved';
  }

  function selectedFactPageSize() {
    const value = Number($('viewerProfileFactPageSize')?.value || 10);
    return FACT_PAGE_SIZES.has(value) ? value : 10;
  }

  function selectedFactSort() {
    const value = $('viewerProfileFactSort')?.value || 'recent_desc';
    return FACT_SORTS.has(value) ? value : 'recent_desc';
  }

  function filteredApprovedFacts() {
    const query = String($('viewerProfileFactSearch')?.value || '').trim().toLowerCase();
    const list = currentProfileFacts.filter((fact) => {
      if (factApprovalStatus(fact) !== 'approved') return false;
      const haystack = `${String(fact.text || '')} ${String(fact.revisionProposal?.text || '')}`.toLowerCase();
      return !query || haystack.includes(query);
    });
    const sort = selectedFactSort();
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

  function renderFacts(profile, { preservePage = true } = {}) {
    currentProfileFacts = Array.isArray(profile?.facts) ? profile.facts : [];
    if (!preservePage) factCurrentPage = 1;
    const approvedAll = currentProfileFacts.filter((fact) => factApprovalStatus(fact) === 'approved');
    const pendingNew = currentProfileFacts.filter((fact) => factApprovalStatus(fact) === 'pending');
    const pendingRevisions = approvedAll.filter((fact) => fact.source !== 'deterministic' && fact.revisionProposal?.text);
    const pendingReviewsAll = [
      ...pendingNew.map((fact) => ({ type: 'new', fact, sortAt: fact.lastObservedAt || fact.firstObservedAt })),
      ...pendingRevisions.map((fact) => ({ type: 'revision', fact, sortAt: fact.revisionProposal?.lastProposedAt || fact.lastObservedAt || fact.firstObservedAt }))
    ].sort((a, b) => new Date(b.sortAt || 0).getTime() - new Date(a.sortAt || 0).getTime());
    const pendingConfidence = selectedPendingFactConfidence();
    const pendingReviews = pendingConfidence === 'all'
      ? pendingReviewsAll
      : pendingReviewsAll.filter(({ type, fact }) => pendingReviewConfidence(type, fact) === pendingConfidence);

    $('viewerProfileFactCount').textContent = `${approvedAll.length} approved`;
    $('viewerProfilePendingFactCount').textContent = pendingConfidence === 'all'
      ? `${pendingReviewsAll.length} pending review${pendingReviewsAll.length === 1 ? '' : 's'}`
      : `${pendingReviews.length} of ${pendingReviewsAll.length} pending reviews`;

    const approved = filteredApprovedFacts();
    const pageSize = selectedFactPageSize();
    const pageCount = Math.max(1, Math.ceil(approved.length / pageSize));
    factCurrentPage = Math.max(1, Math.min(factCurrentPage, pageCount));
    const page = approved.slice((factCurrentPage - 1) * pageSize, factCurrentPage * pageSize);

    $('viewerProfileFacts').innerHTML = page.length ? page.map((fact) => {
      const supportWindows = Math.max(1, Number(fact.supportingWindowCount || 1));
      const contradictions = Math.max(0, Number(fact.contradictionCount || 0));
      const revisions = Math.max(0, Number(fact.revisionCount || 0));
      const hasRevision = Boolean(fact.revisionProposal?.text);
      return `
      <div class="viewer-profile-fact ${fact.enabled === false ? 'disabled' : ''}" data-fact-id="${esc(fact.id)}">
        <label class="inline-check"><input class="viewer-profile-fact-toggle" type="checkbox" ${fact.enabled === false ? '' : 'checked'} ${profile?.optedOut === true ? 'disabled' : ''}> Use</label>
        <div class="viewer-profile-fact-copy">
          <div>${esc(fact.text)}</div>
          <div class="detail">${esc(fact.kind || 'fact')} · ${fact.source === 'deterministic' ? 'deterministic' : 'AI'} · ${esc(fact.confidence || 'medium')} confidence · support ${Number(fact.evidenceCount || 1)}x across ${supportWindows} window${supportWindows === 1 ? '' : 's'}${contradictions ? ` · conflicts ${contradictions}x` : ''}${revisions ? ` · revised ${revisions}x` : ''}${hasRevision ? ' · revision pending review' : ''}${fact.lastObservedAt ? ` · last ${esc(new Date(fact.lastObservedAt).toLocaleDateString())}` : ''}</div>
          ${fact.evidenceSummary ? `<div class="detail">${esc(fact.evidenceSummary)}</div>` : ''}
        </div>
        <button class="danger viewer-profile-fact-unlearn" type="button" ${profile?.optedOut === true ? 'disabled' : ''}>Unlearn</button>
      </div>`;
    }).join('') : `<div class="detail custom-empty-state">${approvedAll.length ? 'No approved observations match your search.' : 'No approved learned observations yet.'}</div>`;

    $('viewerProfileFactPageLabel').textContent = `Page ${factCurrentPage} of ${pageCount}`;
    $('viewerProfileFactPrevPage').disabled = factCurrentPage <= 1;
    $('viewerProfileFactNextPage').disabled = factCurrentPage >= pageCount;
    $('viewerProfileFactPagination').hidden = approved.length === 0;

    $('viewerProfilePendingFacts').innerHTML = pendingReviews.length ? pendingReviews.map(({ type, fact }) => {
      if (type === 'revision') {
        const proposal = fact.revisionProposal;
        const proposalEvidence = Math.max(1, Number(proposal?.evidenceCount || 1));
        const proposalWindows = Math.max(1, Number(proposal?.supportingWindowCount || 1));
        return `
        <div class="viewer-profile-fact" data-fact-id="${esc(fact.id)}" data-review-type="revision">
          <div class="viewer-profile-fact-copy">
            <div class="learned-revision-title"><strong>${proposal.relation === 'contradict' ? 'Suggested revision from conflicting evidence' : 'Suggested revision'}</strong></div>
            <div class="detail"><strong>Current approved:</strong> ${esc(fact.text)}</div>
            <div class="learned-revision-proposal ${proposal.relation === 'contradict' ? 'contradiction' : 'refinement'}">
              <div class="learned-revision-text"><strong>Suggested:</strong> ${esc(proposal.text)}</div>
              <div class="detail">${esc(proposal.kind || fact.kind || 'fact')} · ${esc(proposal.confidence || 'medium')} confidence · ${proposalEvidence} new evidence message${proposalEvidence === 1 ? '' : 's'} across ${proposalWindows} learning window${proposalWindows === 1 ? '' : 's'}</div>
              ${proposal.reason ? `<div class="detail learned-revision-reason">${esc(proposal.reason)}</div>` : ''}
            </div>
          </div>
          <div class="custom-command-actions learned-revision-actions">
            <button class="success viewer-profile-pending-revision-accept" type="button" ${profile?.optedOut === true ? 'disabled' : ''}>Accept Revision</button>
            <button class="secondary viewer-profile-pending-revision-dismiss" type="button" ${profile?.optedOut === true ? 'disabled' : ''}>Keep Current</button>
          </div>
        </div>`;
      }

      const windows = Math.max(1, Number(fact.supportingWindowCount || 1));
      const refinements = Math.max(0, Number(fact.revisionCount || 0));
      return `
      <div class="viewer-profile-fact" data-fact-id="${esc(fact.id)}" data-review-type="new">
        <div class="viewer-profile-fact-copy">
          <div class="learned-revision-title"><strong>New AI observation</strong></div>
          <div>${esc(fact.text)}</div>
          <div class="detail">${esc(fact.kind || 'fact')} · AI · ${esc(fact.confidence || 'medium')} confidence · support ${Number(fact.evidenceCount || 1)}x across ${windows} window${windows === 1 ? '' : 's'}${refinements ? ` · auto-refined ${refinements}x` : ''}${fact.lastObservedAt ? ` · last ${esc(new Date(fact.lastObservedAt).toLocaleDateString())}` : ''}</div>
          ${fact.evidenceSummary ? `<div class="detail">${esc(fact.evidenceSummary)}</div>` : ''}
        </div>
        <div class="custom-command-actions">
          <button class="success viewer-profile-fact-approve" type="button" ${profile?.optedOut === true ? 'disabled' : ''}>Approve</button>
          <button class="danger viewer-profile-fact-reject" type="button" ${profile?.optedOut === true ? 'disabled' : ''}>Reject</button>
        </div>
      </div>`;
    }).join('') : `<div class="detail custom-empty-state">${pendingConfidence === 'all' ? 'No pending AI observations or suggested revisions.' : `No ${esc(pendingConfidence)}-confidence pending observations or revisions for this viewer.`}</div>`;

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

    $('viewerProfileFacts').querySelectorAll('.viewer-profile-fact-unlearn').forEach((button) => {
      button.onclick = async () => {
        if (!editingId) return;
        const row = button.closest('.viewer-profile-fact');
        if (!window.confirm('Unlearn this approved observation? This permanently deletes it from the viewer profile.')) return;
        button.disabled = true;
        const d = await postJson('/viewer-profiles/fact-unlearn', { profileId: editingId, factId: row.dataset.factId });
        if (!d.success) {
          button.disabled = false;
          return setDialogMessage(d.error || 'Could not unlearn fact.', true);
        }
        const index = profiles.findIndex((item) => item.id === editingId);
        if (index >= 0) profiles[index] = d.profile;
        renderFacts(d.profile);
        renderList();
        setDialogMessage('Observation permanently unlearned.');
      };
    });

    $('viewerProfilePendingFacts').querySelectorAll('.viewer-profile-pending-revision-accept, .viewer-profile-pending-revision-dismiss').forEach((button) => {
      button.onclick = async () => {
        if (!editingId) return;
        const row = button.closest('.viewer-profile-fact');
        const accepting = button.classList.contains('viewer-profile-pending-revision-accept');
        button.disabled = true;
        const d = await postJson(accepting ? '/viewer-profiles/fact-revision-accept' : '/viewer-profiles/fact-revision-dismiss', { profileId: editingId, factId: row.dataset.factId });
        if (!d.success) {
          button.disabled = false;
          return setDialogMessage(d.error || `Could not ${accepting ? 'accept the revision' : 'keep the current wording'}.`, true);
        }
        const index = profiles.findIndex((item) => item.id === editingId);
        if (index >= 0) profiles[index] = d.profile;
        renderFacts(d.profile);
        renderList();
        setDialogMessage(accepting ? 'AI revision accepted. The approved observation wording has been updated.' : 'Current wording kept. Recorded conflicts and any confidence adjustment remain; future evidence may suggest another revision.');
      };
    });

    $('viewerProfilePendingFacts').querySelectorAll('.viewer-profile-fact-approve').forEach((button) => {
      button.onclick = async () => {
        if (!editingId) return;
        const row = button.closest('.viewer-profile-fact');
        button.disabled = true;
        const d = await postJson('/viewer-profiles/fact-approve', { profileId: editingId, factId: row.dataset.factId });
        if (!d.success) {
          button.disabled = false;
          return setDialogMessage(d.error || 'Could not approve observation.', true);
        }
        const index = profiles.findIndex((item) => item.id === editingId);
        if (index >= 0) profiles[index] = d.profile;
        renderFacts(d.profile);
        renderList();
        setDialogMessage('Observation approved and enabled.');
      };
    });

    $('viewerProfilePendingFacts').querySelectorAll('.viewer-profile-fact-reject').forEach((button) => {
      button.onclick = async () => {
        if (!editingId) return;
        const row = button.closest('.viewer-profile-fact');
        button.disabled = true;
        const d = await postJson('/viewer-profiles/fact-reject', { profileId: editingId, factId: row.dataset.factId });
        if (!d.success) {
          button.disabled = false;
          return setDialogMessage(d.error || 'Could not reject observation.', true);
        }
        const index = profiles.findIndex((item) => item.id === editingId);
        if (index >= 0) profiles[index] = d.profile;
        renderFacts(d.profile);
        renderList();
        setDialogMessage('Pending observation rejected.');
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
    factCurrentPage = 1;
    if ($('viewerProfileFactSearch')) $('viewerProfileFactSearch').value = '';
    renderFacts({ facts: [] }, { preservePage: false });
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
      if (profile.optedOut === true) {
        if (profile.profileDataPurgedAt) {
          $('viewerProfileDialogMeta').textContent = `@${profile.username} · Opted out · stored profile content deleted`;
        } else if (profile.profileRetentionExpiresAt) {
          $('viewerProfileDialogMeta').textContent = `@${profile.username} · Opted out · retained until ${new Date(profile.profileRetentionExpiresAt).toLocaleDateString()}`;
        } else {
          $('viewerProfileDialogMeta').textContent = `@${profile.username} · Opted out`;
        }
      } else {
        $('viewerProfileDialogMeta').textContent = `@${profile.username} · persistent across streams`;
      }
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
      renderFacts(profile, { preservePage: false });
    }
    showDialog();
  }

  async function loadSettings({ quiet = false } = {}) {
    if (!quiet) setSettingsMessage('Loading...');
    const d = await postJson('/viewer-profiles/settings/get', {});
    if (!d.success) return setSettingsMessage(d.error || 'Could not load viewer profile settings.', true);
    $('viewerProfileLearningEnabled').checked = d.settings?.automaticLearningEnabled !== false;
    $('viewerProfilesTaggedEnabled').checked = d.settings?.useInTaggedQuestions === true;
    if (!quiet) setSettingsMessage('');
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
    setSettingsMessage('Saved.');
  }

  async function loadProfiles({ quiet = false } = {}) {
    if (!quiet) setMessage('Loading viewer profiles...');
    const d = await postJson('/viewer-profiles/list', {});
    if (!d.success) return setMessage(d.error || 'Could not load viewer profiles.', true);
    profiles = Array.isArray(d.profiles) ? d.profiles : [];
    loaded = true;
    renderList();
    setMessage(`${profiles.length} viewer profile${profiles.length === 1 ? '' : 's'}.`);
  }

  function cleanupScopeLabel(value) {
    if (value === 'pending') return 'pending';
    if (value === 'approved') return 'approved';
    return 'pending + approved';
  }

  function cleanupConfidenceLabel(value) {
    if (value === 'low') return 'low-confidence';
    if (value === 'high') return 'all-confidence';
    return 'medium-and-lower';
  }

  async function deleteMatchingViewerObservations() {
    const approvalScope = $('viewerProfileCleanupStatus').value || 'both';
    const maxConfidence = $('viewerProfileCleanupConfidence').value || 'medium';
    const label = `${cleanupScopeLabel(approvalScope)} ${cleanupConfidenceLabel(maxConfidence)} viewer observations`;
    if (!window.confirm(`Permanently delete all ${label}?`)) return;

    const button = $('deleteViewerFactsByConfidenceBtn');
    button.disabled = true;
    setBulkCleanupMessage('Deleting matching observations...');
    try {
      const d = await postJson('/viewer-profiles/facts-bulk-delete', { approvalScope, maxConfidence });
      if (!d.success) return setBulkCleanupMessage(d.error || 'Could not delete matching viewer observations.', true);
      await loadProfiles({ quiet: true });
      setBulkCleanupMessage(`Deleted ${Number(d.deletedFacts || 0)} observation${Number(d.deletedFacts || 0) === 1 ? '' : 's'} across ${Number(d.affectedProfiles || 0)} profile${Number(d.affectedProfiles || 0) === 1 ? '' : 's'}.`);
    } finally {
      button.disabled = false;
    }
  }

  async function clearAllProfiles() {
    if (!window.confirm('Clear ALL viewer profiles? This deletes all non-opted-out profiles, including notes, command history, and every pending/approved observation. Opt-out privacy records are preserved.')) return;
    if (!window.confirm('Final confirmation: permanently clear all viewer profile data? This cannot be undone.')) return;

    const button = $('clearAllViewerProfilesBtn');
    button.disabled = true;
    setBulkCleanupMessage('Clearing viewer profiles...');
    try {
      const d = await postJson('/viewer-profiles/clear-all', {});
      if (!d.success) return setBulkCleanupMessage(d.error || 'Could not clear viewer profiles.', true);
      if (dialog.open) closeDialog();
      await loadProfiles({ quiet: true });
      const preserved = Number(d.preservedOptOutRecords || 0);
      setBulkCleanupMessage(`Cleared ${Number(d.deletedProfiles || 0)} viewer profile${Number(d.deletedProfiles || 0) === 1 ? '' : 's'}${preserved ? `; preserved ${preserved} opt-out privacy record${preserved === 1 ? '' : 's'}` : ''}.`);
    } finally {
      button.disabled = false;
    }
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
    const savedPendingConfidence = localStorage.getItem(PENDING_CONFIDENCE_STORAGE_KEY);
    if (PENDING_CONFIDENCE_FILTERS.has(savedPendingConfidence)) $('viewerProfilePendingConfidenceFilter').value = savedPendingConfidence;
    const savedPendingFactConfidence = localStorage.getItem(PENDING_FACT_CONFIDENCE_STORAGE_KEY);
    if (PENDING_CONFIDENCE_FILTERS.has(savedPendingFactConfidence)) $('viewerProfilePendingFactConfidenceFilter').value = savedPendingFactConfidence;
  } catch {}

  $('viewerProfilePendingConfidenceFilter').onchange = () => {
    try { localStorage.setItem(PENDING_CONFIDENCE_STORAGE_KEY, selectedPendingConfidence()); } catch {}
    renderPendingReview();
  };
  $('viewerProfilePendingFactConfidenceFilter').onchange = () => {
    try { localStorage.setItem(PENDING_FACT_CONFIDENCE_STORAGE_KEY, selectedPendingFactConfidence()); } catch {}
    const profile = profiles.find((item) => item.id === editingId) || { facts: currentProfileFacts };
    renderFacts(profile);
  };
  $('viewerProfileFactSearch').oninput = () => { factCurrentPage = 1; const profile = profiles.find((item) => item.id === editingId) || { facts: currentProfileFacts }; renderFacts(profile); };
  $('viewerProfileFactSort').onchange = () => { factCurrentPage = 1; const profile = profiles.find((item) => item.id === editingId) || { facts: currentProfileFacts }; renderFacts(profile); };
  $('viewerProfileFactPageSize').onchange = () => { factCurrentPage = 1; const profile = profiles.find((item) => item.id === editingId) || { facts: currentProfileFacts }; renderFacts(profile); };
  $('viewerProfileFactPrevPage').onclick = () => { if (factCurrentPage > 1) { factCurrentPage--; const profile = profiles.find((item) => item.id === editingId) || { facts: currentProfileFacts }; renderFacts(profile); } };
  $('viewerProfileFactNextPage').onclick = () => { factCurrentPage++; const profile = profiles.find((item) => item.id === editingId) || { facts: currentProfileFacts }; renderFacts(profile); };
  $('viewerProfileSearch').oninput = () => { currentPage = 1; renderList(); };
  $('viewerProfileSort').onchange = () => { currentPage = 1; try { localStorage.setItem(SORT_STORAGE_KEY, selectedSort()); } catch {} renderList(); };
  $('viewerProfilePageSize').onchange = () => { currentPage = 1; try { localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(selectedPageSize())); } catch {} renderList(); };
  $('viewerProfilePrevPage').onclick = () => { if (currentPage > 1) { currentPage--; renderList(); } };
  $('viewerProfileNextPage').onclick = () => { currentPage++; renderList(); };
  $('deleteViewerFactsByConfidenceBtn').onclick = deleteMatchingViewerObservations;
  $('clearAllViewerProfilesBtn').onclick = clearAllProfiles;
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
