(function () {
  'use strict';

  var skillRuns = [];
  var skillDraftSessions = [];
  var publishedSkills = [];
  var selectedSkillRunId = null;
  var selectedSkillRun = null;
  var selectedPublishedSkillId = null;
  var selectedPublishedSkill = null;
  var selectedSkillDiff = null;
  var currentSkillDraft = null;
  var draftSaveTimer = null;
  var showArchivedSkillDrafts = false;

  function skillEscHtml(str) {
    var div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  function skillEscAttr(str) {
    return skillEscHtml(str).replace(/"/g, '&quot;');
  }

  function skillFormatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString();
  }

  function parseJsonField(value, label, fallback) {
    if (!value || !value.trim()) {
      return fallback;
    }
    try {
      return JSON.parse(value);
    } catch (err) {
      throw new Error(label + ' must be valid JSON');
    }
  }

  async function fetchSkillRuns() {
    var res = await fetch('/api/skills/runs');
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load skill runs');
    skillRuns = data.runs || [];
    if (!selectedSkillRunId && skillRuns.length) {
      selectedSkillRunId = skillRuns[0].runId;
    }
  }

  async function fetchSkillDraftSessions() {
    var res = await fetch('/api/skills/drafts');
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load skill drafts');
    skillDraftSessions = data.sessions || [];
  }

  async function fetchPublishedSkills() {
    var res = await fetch('/api/skills/library');
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load published skills');
    publishedSkills = data.skills || [];
  }

  async function fetchSkillRun(runId) {
    var res = await fetch('/api/skills/runs/' + encodeURIComponent(runId));
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load skill run');
    return data.run;
  }

  async function fetchSkillArtifacts(runId) {
    var res = await fetch('/api/skills/runs/' + encodeURIComponent(runId) + '/artifacts');
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load artifacts');
    return data.artifacts || [];
  }

  async function fetchSkillVersion(runId, version) {
    var res = await fetch('/api/skills/runs/' + encodeURIComponent(runId) + '/versions/' + encodeURIComponent(version));
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load skill version');
    return data.artifact;
  }

  async function fetchSkillDiff(runId, leftVersion, rightVersion) {
    var res = await fetch(
      '/api/skills/runs/' + encodeURIComponent(runId) + '/diff?left=' + encodeURIComponent(leftVersion) + '&right=' + encodeURIComponent(rightVersion)
    );
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load diff');
    return data.diff;
  }

  async function updateSkillDraftSession(sessionId, payload) {
    var res = await fetch('/api/skills/drafts/' + encodeURIComponent(sessionId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save draft session');
    return data.session;
  }

  async function deleteSkillDraftSessionRequest(sessionId) {
    var res = await fetch('/api/skills/drafts/' + encodeURIComponent(sessionId), {
      method: 'DELETE'
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || 'Failed to delete draft session');
    return data;
  }

  async function cleanupSkillDraftSessionsRequest(payload) {
    var res = await fetch('/api/skills/drafts/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || 'Failed to clean up draft sessions');
    return data;
  }

  async function publishSkillDraft(sessionId, payload) {
    var res = await fetch('/api/skills/drafts/' + encodeURIComponent(sessionId) + '/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || 'Failed to publish draft skill');
    return data.skill;
  }

  async function publishSkillRun(runId, payload) {
    var res = await fetch('/api/skills/runs/' + encodeURIComponent(runId) + '/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || 'Failed to publish optimized skill');
    return data.skill;
  }

  async function updatePublishedSkill(publishedSkillId, payload) {
    var res = await fetch('/api/skills/library/' + encodeURIComponent(publishedSkillId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || 'Failed to update published skill');
    return data.skill;
  }

  async function regenerateRejectedExamples(sessionId) {
    var res = await fetch('/api/skills/drafts/' + encodeURIComponent(sessionId) + '/regenerate-rejected', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to regenerate rejected examples');
    return data.session;
  }

  async function setSkillDraftApproval(sessionId, approved, approvalNote) {
    var action = approved ? 'approve' : 'unapprove';
    var res = await fetch('/api/skills/drafts/' + encodeURIComponent(sessionId) + '/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvalNote: approvalNote || undefined }),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update draft approval');
    return data.session;
  }

  async function optimizeSkillRun(payload) {
    var res = await fetch('/api/skills/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Optimization failed');
    return data;
  }

  async function evaluateSkillDraft(payload) {
    var res = await fetch('/api/skills/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Evaluation failed');
    return data;
  }

  async function generateSkillDraftRequest(payload) {
    var res = await fetch('/api/skills/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Draft generation failed');
    return data.session;
  }

  function getCurrentDraft() {
    return currentSkillDraft && currentSkillDraft.draft ? currentSkillDraft.draft : null;
  }

  function scheduleDraftSessionSave() {
    if (!currentSkillDraft || !currentSkillDraft.sessionId) return;
    if (draftSaveTimer) {
      clearTimeout(draftSaveTimer);
    }
    draftSaveTimer = setTimeout(async function () {
      try {
        currentSkillDraft = await updateSkillDraftSession(currentSkillDraft.sessionId, {
          draft: currentSkillDraft.draft,
          approvedForOptimization: false,
        });
        upsertDraftSession(currentSkillDraft);
        renderSkillsSidebar();
      } catch (err) {
        toast('Failed to save draft review: ' + err.message, 'error');
      }
    }, 350);
  }

  function upsertDraftSession(session) {
    if (!session || !session.sessionId) return;
    skillDraftSessions = [session].concat(skillDraftSessions.filter(function (candidate) {
      return candidate.sessionId !== session.sessionId;
    }));
    skillDraftSessions.sort(function (left, right) {
      return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
    });
  }

  function upsertPublishedSkill(skill) {
    if (!skill || !skill.publishedSkillId) return;
    publishedSkills = [skill].concat(publishedSkills.filter(function (candidate) {
      return candidate.publishedSkillId !== skill.publishedSkillId;
    }));
    publishedSkills.sort(function (left, right) {
      return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
    });
  }

  function getVisibleDraftSessions() {
    return skillDraftSessions.filter(function (session) {
      return showArchivedSkillDrafts || !session.archivedAt;
    });
  }

  function buildDraftDerivedTestCases() {
    var draft = getCurrentDraft();
    if (!draft || !Array.isArray(draft.examples)) return [];
    return draft.examples
      .filter(function (example) { return example.approvalStatus !== 'rejected'; })
      .map(function (example) {
        var testCase = JSON.parse(JSON.stringify(example.testCase || {}));
        if (example.critique) {
          testCase.rubricNotes = (testCase.rubricNotes ? testCase.rubricNotes + '\n' : '') + 'Reviewer critique: ' + example.critique;
        }
        return testCase;
      });
  }

  function buildDraftCritiqueConstraints() {
    var draft = getCurrentDraft();
    if (!draft || !Array.isArray(draft.examples)) return [];
    return draft.examples
      .filter(function (example) { return example.approvalStatus === 'rejected' && example.critique; })
      .map(function (example) {
        return 'Avoid rejected draft example ' + example.id + ': ' + example.critique;
      });
  }

  function buildDraftDerivedSkill() {
    var draft = getCurrentDraft();
    if (!draft || !draft.skill) return null;
    var nextSkill = JSON.parse(JSON.stringify(draft.skill));
    var approvedExamples = draft.examples
      .filter(function (example) {
        return example.approvalStatus !== 'rejected' && example.testCase && example.testCase.expectedOutput != null;
      })
      .slice(0, 4)
      .map(function (example) {
        return {
          input: example.testCase.input,
          output: example.testCase.expectedOutput,
          note: example.critique || example.rationale,
        };
      });
    nextSkill.examples = approvedExamples;
    return nextSkill;
  }

  function syncDraftTextareas() {
    var baseSkillEl = document.getElementById('skill-base-skill');
    var testCasesEl = document.getElementById('skill-test-cases');
    var draftSkill = buildDraftDerivedSkill();
    var draftCases = buildDraftDerivedTestCases();
    if (baseSkillEl && draftSkill) {
      baseSkillEl.value = JSON.stringify(draftSkill, null, 2);
    }
    if (testCasesEl && draftCases.length) {
      testCasesEl.value = JSON.stringify(draftCases, null, 2);
    }
  }

  function renderSkillDraftOutput() {
    var output = document.getElementById('skill-builder-output');
    if (!output) return;

    var draft = getCurrentDraft();

    if (!currentSkillDraft || !draft) {
      output.innerHTML = '<div class="memory-detail-title">Draft Output</div><pre class="skill-pre">No draft yet. Describe the skill, generate a draft, then review the proposed examples.</pre>';
      return;
    }

    var notesHtml = (draft.notes || []).length
      ? '<div class="skill-note-list">' + draft.notes.map(function (note) {
          return '<div class="skill-note-item">' + skillEscHtml(note) + '</div>';
        }).join('') + '</div>'
      : '';

    var approvalHtml = '<div class="skill-draft-approval-bar">'
      + '<div>'
      + '<div class="memory-detail-title">Optimization Gate</div>'
      + '<div class="memory-detail-meta">'
      + (currentSkillDraft.approvedForOptimization
          ? 'Approved for optimization' + (currentSkillDraft.approvedAt ? ' · ' + skillFormatDate(currentSkillDraft.approvedAt) : '')
          : 'Waiting for explicit approval before optimization can start')
      + '</div>'
      + '</div>'
      + '<div class="skill-form-button-row">'
      + '<button id="skill-regenerate-rejected-btn" class="memory-action-btn memory-action-secondary">Regenerate Rejected</button>'
      + '<button id="skill-approve-draft-btn" class="memory-action-btn">' + (currentSkillDraft.approvedForOptimization ? 'Approved' : 'Approve for Optimization') + '</button>'
      + '<button id="skill-publish-draft-btn" class="memory-action-btn memory-action-secondary">Publish for Chat + Pipelines</button>'
      + '</div>'
      + '</div>';

    var examplesHtml = (draft.examples || []).map(function (example) {
      return '<div class="skill-draft-example-card" data-draft-example-id="' + skillEscAttr(example.id) + '">' +
        '<div class="skill-draft-example-head">' +
          '<div>' +
            '<div class="memory-detail-title">' + skillEscHtml(example.testCase && example.testCase.id ? example.testCase.id : example.id) + '</div>' +
            '<div class="memory-detail-meta">' + skillEscHtml(example.testCase && example.testCase.split ? example.testCase.split : 'seed') + (example.rationale ? ' · ' + skillEscHtml(example.rationale) : '') + '</div>' +
          '</div>' +
          '<div class="skill-draft-status-row">' +
            '<button class="skill-draft-status-btn' + (example.approvalStatus === 'approved' ? ' active' : '') + '" data-draft-action="approve" data-draft-example-id="' + skillEscAttr(example.id) + '">Approve</button>' +
            '<button class="skill-draft-status-btn skill-draft-status-reject' + (example.approvalStatus === 'rejected' ? ' active' : '') + '" data-draft-action="reject" data-draft-example-id="' + skillEscAttr(example.id) + '">Reject</button>' +
          '</div>' +
        '</div>' +
        '<div class="skill-draft-example-grid">' +
          '<div><strong>Input</strong><pre class="skill-pre">' + skillEscHtml(JSON.stringify(example.testCase ? example.testCase.input : '', null, 2)) + '</pre></div>' +
          '<div><strong>Expected Output</strong><pre class="skill-pre">' + skillEscHtml(JSON.stringify(example.testCase ? example.testCase.expectedOutput : '', null, 2)) + '</pre></div>' +
        '</div>' +
        '<label class="skill-field"><span>Reviewer critique</span><textarea class="skill-draft-critique" data-draft-example-id="' + skillEscAttr(example.id) + '" rows="3" placeholder="Optional critique or correction guidance.">' + skillEscHtml(example.critique || '') + '</textarea></label>' +
      '</div>';
    }).join('');

    output.innerHTML =
      '<div class="memory-detail-title">Generated Draft</div>' +
      '<div class="memory-detail-meta">Review the proposed examples before evaluating or optimizing the skill.</div>' +
      approvalHtml +
      notesHtml +
      '<div class="skill-draft-skill-block"><strong>Generated Skill Spec</strong><pre class="skill-pre">' + skillEscHtml(JSON.stringify(draft.skill, null, 2)) + '</pre></div>' +
      '<div class="skill-draft-example-stack">' + examplesHtml + '</div>';

    wireSkillDraftReview();
  }

  function wireSkillDraftReview() {
    document.querySelectorAll('[data-draft-action]').forEach(function (button) {
      button.addEventListener('click', function () {
        var draft = getCurrentDraft();
        if (!currentSkillDraft || !draft) return;
        var exampleId = button.dataset.draftExampleId;
        var nextStatus = button.dataset.draftAction === 'reject' ? 'rejected' : 'approved';
        draft.examples = (draft.examples || []).map(function (example) {
          if (example.id !== exampleId) return example;
          example.approvalStatus = nextStatus;
          return example;
        });
        currentSkillDraft.approvedForOptimization = false;
        syncDraftTextareas();
        scheduleDraftSessionSave();
        renderSkillDraftOutput();
      });
    });

    document.querySelectorAll('.skill-draft-critique').forEach(function (field) {
      field.addEventListener('input', function () {
        var draft = getCurrentDraft();
        if (!currentSkillDraft || !draft) return;
        var exampleId = field.dataset.draftExampleId;
        draft.examples = (draft.examples || []).map(function (example) {
          if (example.id !== exampleId) return example;
          example.critique = field.value;
          return example;
        });
        currentSkillDraft.approvedForOptimization = false;
        syncDraftTextareas();
        scheduleDraftSessionSave();
      });
    });

    var regenerateBtn = document.getElementById('skill-regenerate-rejected-btn');
    if (regenerateBtn) {
      regenerateBtn.addEventListener('click', async function () {
        if (!currentSkillDraft) return;
        regenerateBtn.disabled = true;
        try {
          currentSkillDraft = await regenerateRejectedExamples(currentSkillDraft.sessionId);
          upsertDraftSession(currentSkillDraft);
          renderSkillsSidebar();
          syncDraftTextareas();
          renderSkillDraftOutput();
          toast('Rejected examples regenerated', 'success');
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          regenerateBtn.disabled = false;
        }
      });
    }

    var approveBtn = document.getElementById('skill-approve-draft-btn');
    if (approveBtn) {
      approveBtn.addEventListener('click', async function () {
        if (!currentSkillDraft) return;
        try {
          currentSkillDraft = await setSkillDraftApproval(currentSkillDraft.sessionId, true);
          upsertDraftSession(currentSkillDraft);
          renderSkillsSidebar();
          renderSkillDraftOutput();
          toast('Draft approved for optimization', 'success');
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }

    var publishBtn = document.getElementById('skill-publish-draft-btn');
    if (publishBtn) {
      publishBtn.addEventListener('click', async function () {
        if (!currentSkillDraft) return;
        publishBtn.disabled = true;
        try {
          var published = await publishSkillDraft(currentSkillDraft.sessionId);
          upsertPublishedSkill(published);
          selectedPublishedSkill = published;
          selectedPublishedSkillId = published.publishedSkillId;
          renderSkillsSidebar();
          toast('Published skill for chat and pipelines: ' + published.name, 'success');
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          publishBtn.disabled = false;
        }
      });
    }
  }

  function getAllVersions(run) {
    var versions = {};
    if (run && run.baseline && run.baseline.skill) {
      versions[run.baseline.skill.version] = true;
    }
    (run.rounds || []).forEach(function (round) {
      (round.candidates || []).forEach(function (candidate) {
        versions[candidate.skill.version] = true;
      });
    });
    return Object.keys(versions).map(function (value) { return Number(value); }).sort(function (a, b) { return a - b; });
  }

  function renderSkillsSidebar() {
    var list = document.getElementById('skills-list');
    if (!list) return;

    var visibleDraftSessions = getVisibleDraftSessions();
    var hiddenArchivedCount = skillDraftSessions.filter(function (session) {
      return !!session.archivedAt;
    }).length;

    var html = '';
    html += '<div class="skill-sidebar-toolbar">';
    html += '<button id="skill-new-run-btn" class="memory-action-btn">New Dataset</button>';
    html += '<button id="skill-refresh-btn" class="memory-action-btn memory-action-secondary">Refresh</button>';
    html += '<button id="skill-cleanup-btn" class="memory-action-btn memory-action-secondary">Cleanup Old Drafts</button>';
    if (hiddenArchivedCount) {
      html += '<button id="skill-toggle-archived-btn" class="memory-action-btn memory-action-secondary">'
        + (showArchivedSkillDrafts ? 'Hide Archived' : 'Show Archived (' + hiddenArchivedCount + ')')
        + '</button>';
    }
    html += '</div>';

    if (publishedSkills.length) {
      html += '<div class="skill-sidebar-section-label">Published Skills</div>';
      publishedSkills.forEach(function (skill) {
        var active = selectedPublishedSkillId === skill.publishedSkillId ? ' active' : '';
        var unpublished = skill.unpublishedAt ? ' archived' : '';
        var audience = [];
        if (skill.audience && skill.audience.chat) audience.push('chat');
        if (skill.audience && skill.audience.pipelines) audience.push('pipelines');
        if (!audience.length) audience.push('library-only');
        html += '<div class="memory-item' + active + unpublished + '" data-published-skill-id="' + skillEscAttr(skill.publishedSkillId) + '">';
        html += '<div class="skill-sidebar-item-head">';
        html += '<div class="memory-item-title">' + skillEscHtml(skill.name) + '</div>';
        html += '<div class="skill-sidebar-item-actions">';
        html += '<button class="skill-sidebar-icon-btn" data-published-skill-toggle="' + skillEscAttr(skill.publishedSkillId) + '" title="' + (skill.unpublishedAt ? 'Republish skill' : 'Unpublish skill') + '">' + (skill.unpublishedAt ? 'Republish' : 'Unpublish') + '</button>';
        html += '</div>';
        html += '</div>';
        html += '<div class="memory-item-meta">' + skillEscHtml(audience.join(' · ')) + (skill.unpublishedAt ? ' · unpublished' : '') + '</div>';
        html += '<div class="memory-item-score">' + skillEscHtml(skillFormatDate(skill.updatedAt)) + '</div>';
        html += '</div>';
      });
    }

    if (skillDraftSessions.length) {
      html += '<div class="skill-sidebar-section-label">Draft Sessions</div>';
      visibleDraftSessions.forEach(function (session) {
        var active = currentSkillDraft && currentSkillDraft.sessionId === session.sessionId && !selectedSkillRunId ? ' active' : '';
        var archived = session.archivedAt ? ' archived' : '';
        var title = session.title || (session.request && (session.request.goal || session.request.description)) || session.sessionId;
        var approvedLabel = session.approvedForOptimization ? 'approved' : 'reviewing';
        if (session.archivedAt) approvedLabel += ' · archived';
        var exampleCount = session.draft && session.draft.examples ? session.draft.examples.length : 0;
        html += '<div class="memory-item' + active + archived + '" data-skill-draft-id="' + skillEscAttr(session.sessionId) + '">';
        html += '<div class="skill-sidebar-item-head">';
        html += '<div class="memory-item-title">' + skillEscHtml(String(title).slice(0, 72)) + '</div>';
        html += '<div class="skill-sidebar-item-actions">';
        html += '<button class="skill-sidebar-icon-btn" data-skill-draft-archive="' + skillEscAttr(session.sessionId) + '" title="' + (session.archivedAt ? 'Restore draft' : 'Archive draft') + '">' + (session.archivedAt ? 'Restore' : 'Archive') + '</button>';
        html += '<button class="skill-sidebar-icon-btn" data-skill-draft-rename="' + skillEscAttr(session.sessionId) + '" title="Rename draft">Rename</button>';
        html += '<button class="skill-sidebar-icon-btn skill-sidebar-icon-btn-danger" data-skill-draft-delete="' + skillEscAttr(session.sessionId) + '" title="Delete draft">Delete</button>';
        html += '</div>';
        html += '</div>';
        html += '<div class="memory-item-meta">' + skillEscHtml(approvedLabel) + ' · ' + skillEscHtml(String(exampleCount)) + ' examples</div>';
        html += '<div class="memory-item-score">' + skillEscHtml(skillFormatDate(session.updatedAt)) + '</div>';
        html += '</div>';
      });
      if (!visibleDraftSessions.length && hiddenArchivedCount) {
        html += '<div class="memory-empty">All draft sessions are currently archived.</div>';
      }
    }

    if (skillRuns.length) {
      html += '<div class="skill-sidebar-section-label">Optimization Runs</div>';
      skillRuns.forEach(function (run) {
        var active = run.runId === selectedSkillRunId ? ' active' : '';
        html += '<div class="memory-item' + active + '" data-skill-run-id="' + skillEscAttr(run.runId) + '">';
        html += '<div class="memory-item-title">' + skillEscHtml(run.bestSkillName || run.namespace) + '</div>';
        html += '<div class="memory-item-meta">score ' + skillEscHtml(run.bestScore.toFixed(3)) + ' · holdout ' + skillEscHtml(run.holdoutScore.toFixed(3)) + '</div>';
        html += '<div class="memory-item-score">' + skillEscHtml(skillFormatDate(run.createdAt)) + '</div>';
        html += '</div>';
      });
    }

    if (!skillRuns.length && !skillDraftSessions.length && !publishedSkills.length) {
      html += '<div class="memory-empty">No draft sessions, published skills, or optimization runs yet.</div>';
      list.innerHTML = html;
      wireSkillsSidebar();
      return;
    }

    list.innerHTML = html;
    wireSkillsSidebar();
  }

  function renderSkillBuilder() {
    var main = document.getElementById('main');
    if (!main) return;

    main.innerHTML =
      '<div class="ext-header">' +
      '<h2>Skill Builder</h2>' +
      '<div class="ext-header-meta">Describe a skill, generate a draft, review generated examples, then evaluate or optimize with approved examples.</div>' +
      '</div>' +
      '<div class="skill-builder-grid">' +
      '<div class="memory-detail-card">' +
      '<div class="skill-form-grid">' +
      '<label class="skill-field"><span>Goal</span><textarea id="skill-goal" rows="3" placeholder="Describe the skill goal."></textarea></label>' +
      '<label class="skill-field"><span>Skill Description</span><textarea id="skill-description" rows="5" placeholder="Describe what the skill should do, the kinds of inputs it sees, the output shape, and any failure modes to test."></textarea></label>' +
      '<label class="skill-field"><span>Namespace</span><input id="skill-namespace" type="text" placeholder="customer-summary"></label>' +
      '<label class="skill-field"><span>Example Count</span><input id="skill-example-count" type="number" min="2" max="12" value="4"></label>' +
      '<label class="skill-field"><span>Constraints JSON array</span><textarea id="skill-constraints" rows="3" placeholder=' + '"[\"Keep it short\"]"' + '></textarea></label>' +
      '<label class="skill-field"><span>Generated / Editable Test Cases JSON</span><textarea id="skill-test-cases" rows="12" placeholder=' + '"[{\n  \"id\": \"seed-1\",\n  \"input\": {\"ticket\": \"...\"},\n  \"split\": \"seed\",\n  \"deterministicChecks\": [{\"type\": \"contains\", \"value\": \"verified\"}]\n}]"' + '></textarea></label>' +
      '<label class="skill-field"><span>Generated / Editable Base Skill JSON</span><textarea id="skill-base-skill" rows="10" placeholder=' + '"Optional existing SkillSpec JSON"' + '></textarea></label>' +
      '<label class="skill-field"><span>Budget JSON</span><textarea id="skill-budgets" rows="5" placeholder=' + '"{\"maxTotalTokens\": 6000, \"maxEstimatedCostUsd\": 0.02}"' + '></textarea></label>' +
      '</div>' +
      '<div class="skill-form-actions">' +
      '<label class="skill-checkbox"><input id="skill-pairwise" type="checkbox" checked> Pairwise candidate vs best judging</label>' +
      '<div class="skill-form-button-row">' +
      '<button id="skill-generate-btn" class="memory-action-btn">Generate Draft</button>' +
      '<button id="skill-evaluate-btn" class="memory-action-btn memory-action-secondary">Evaluate Draft</button>' +
      '<button id="skill-optimize-btn" class="memory-action-btn">Optimize Approved Examples</button>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div id="skill-builder-output" class="memory-detail-card skill-output-card">' +
      '<div class="memory-detail-title">Draft Output</div>' +
      '<pre class="skill-pre">No draft yet. Describe the skill and generate examples.</pre>' +
      '</div>' +
      '</div>';

    wireSkillBuilder();

    if (currentSkillDraft) {
      document.getElementById('skill-goal').value = currentSkillDraft.request && currentSkillDraft.request.goal ? currentSkillDraft.request.goal : '';
      document.getElementById('skill-description').value = currentSkillDraft.request && currentSkillDraft.request.description ? currentSkillDraft.request.description : '';
      document.getElementById('skill-namespace').value = currentSkillDraft.request && currentSkillDraft.request.artifactNamespace ? currentSkillDraft.request.artifactNamespace : '';
      document.getElementById('skill-example-count').value = String(currentSkillDraft.request && currentSkillDraft.request.exampleCount ? currentSkillDraft.request.exampleCount : 4);
      document.getElementById('skill-constraints').value = JSON.stringify((currentSkillDraft.request && currentSkillDraft.request.constraints) || [], null, 2);
      syncDraftTextareas();
      renderSkillDraftOutput();
    }
  }

  function renderPublishedSkillDetail(skill) {
    var main = document.getElementById('main');
    if (!main || !skill) return;

    var audiences = [];
    if (skill.audience && skill.audience.chat) audiences.push('Chat');
    if (skill.audience && skill.audience.pipelines) audiences.push('Pipelines');
    if (!audiences.length) audiences.push('Library only');

    main.innerHTML =
      '<div class="ext-header">' +
      '<h2>' + skillEscHtml(skill.name) + '</h2>' +
      '<div class="ext-header-meta">Published ' + skillEscHtml(skillFormatDate(skill.publishedAt)) + (skill.unpublishedAt ? ' · currently unpublished' : '') + '</div>' +
      '</div>' +
      '<div class="skill-builder-grid">' +
      '<div class="memory-detail-card">' +
      '<div class="memory-detail-head">' +
      '<div><div class="memory-detail-title">Published Skill</div><div class="memory-detail-meta">' + skillEscHtml(skill.description || skill.skill.purpose || '') + '</div></div>' +
      '<div class="skill-form-button-row">' +
      '<button id="published-skill-chat-btn" class="memory-action-btn memory-action-secondary">' + (skill.audience.chat ? 'Disable Chat' : 'Enable Chat') + '</button>' +
      '<button id="published-skill-pipeline-btn" class="memory-action-btn memory-action-secondary">' + (skill.audience.pipelines ? 'Disable Pipelines' : 'Enable Pipelines') + '</button>' +
      '<button id="published-skill-toggle-btn" class="memory-action-btn">' + (skill.unpublishedAt ? 'Republish' : 'Unpublish') + '</button>' +
      '</div>' +
      '</div>' +
      '<div class="memory-detail-grid">' +
      '<div><strong>Audience</strong><div>' + skillEscHtml(audiences.join(', ')) + '</div></div>' +
      '<div><strong>Source</strong><div>' + skillEscHtml(skill.source.type + (skill.source.runId ? ' · ' + skill.source.runId : skill.source.draftSessionId ? ' · ' + skill.source.draftSessionId : '')) + '</div></div>' +
      '<div><strong>Updated</strong><div>' + skillEscHtml(skillFormatDate(skill.updatedAt)) + '</div></div>' +
      '<div><strong>Trigger Conditions</strong><div>' + skillEscHtml((skill.skill.triggerConditions || []).join(', ') || 'None') + '</div></div>' +
      '</div>' +
      (skill.notes && skill.notes.length ? '<div class="memory-file-panel"><div class="memory-file-row"><strong>Notes</strong><div class="memory-file-path">' + skillEscHtml(skill.notes.join('\n')) + '</div></div></div>' : '') +
      '</div>' +
      '<div class="memory-detail-card">' +
      '<div class="memory-detail-title">Skill Spec</div>' +
      '<pre class="skill-pre">' + skillEscHtml(JSON.stringify(skill.skill, null, 2)) + '</pre>' +
      '</div>' +
      '</div>';

    var toggleBtn = document.getElementById('published-skill-toggle-btn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', async function () {
        toggleBtn.disabled = true;
        try {
          var updated = await updatePublishedSkill(skill.publishedSkillId, { unpublished: !skill.unpublishedAt });
          upsertPublishedSkill(updated);
          selectedPublishedSkill = updated;
          selectedPublishedSkillId = updated.publishedSkillId;
          renderSkillsSidebar();
          renderPublishedSkillDetail(updated);
          toast(updated.unpublishedAt ? 'Skill unpublished from chat and pipelines' : 'Skill republished', 'success');
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          toggleBtn.disabled = false;
        }
      });
    }

    var chatBtn = document.getElementById('published-skill-chat-btn');
    if (chatBtn) {
      chatBtn.addEventListener('click', async function () {
        chatBtn.disabled = true;
        try {
          var updated = await updatePublishedSkill(skill.publishedSkillId, { chat: !skill.audience.chat, unpublished: false });
          upsertPublishedSkill(updated);
          selectedPublishedSkill = updated;
          renderSkillsSidebar();
          renderPublishedSkillDetail(updated);
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          chatBtn.disabled = false;
        }
      });
    }

    var pipelineBtn = document.getElementById('published-skill-pipeline-btn');
    if (pipelineBtn) {
      pipelineBtn.addEventListener('click', async function () {
        pipelineBtn.disabled = true;
        try {
          var updated = await updatePublishedSkill(skill.publishedSkillId, { pipelines: !skill.audience.pipelines, unpublished: false });
          upsertPublishedSkill(updated);
          selectedPublishedSkill = updated;
          renderSkillsSidebar();
          renderPublishedSkillDetail(updated);
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          pipelineBtn.disabled = false;
        }
      });
    }
  }

  async function selectSkillRun(runId) {
    selectedSkillRunId = runId;
    currentSkillDraft = null;
    selectedPublishedSkillId = null;
    selectedPublishedSkill = null;
    renderSkillsSidebar();
    var main = document.getElementById('main');
    main.innerHTML = '<div class="loading"><div class="spinner"></div> Loading...</div>';
    try {
      var run = await fetchSkillRun(runId);
      var artifacts = await fetchSkillArtifacts(runId);
      selectedSkillRun = run;
      renderSkillRunDetail(run, artifacts);
    } catch (err) {
      main.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#x26a0;</div><h2>Error</h2><p>' + skillEscHtml(err.message) + '</p></div>';
    }
  }

  function renderSkillRunDetail(run, artifacts) {
    var main = document.getElementById('main');
    var versions = getAllVersions(run);
    var leftVersion = versions.length ? versions[0] : '';
    var rightVersion = versions.length ? versions[versions.length - 1] : '';
    var roundsHtml = (run.rounds || []).map(function (round) {
      return '<div class="skill-round-card">' +
        '<div class="skill-round-head">Round ' + skillEscHtml(round.round) + ' · baseline v' + skillEscHtml(round.baselineVersion) + '</div>' +
        '<div class="skill-round-body">' +
        (round.candidates || []).map(function (candidate) {
          return '<div class="skill-candidate-row">' +
            '<div><strong>v' + skillEscHtml(candidate.skill.version) + '</strong> score ' + skillEscHtml(candidate.evaluation.overallScore.toFixed(3)) + '</div>' +
            '<div>holdout ' + skillEscHtml(candidate.evaluation.holdoutScore.toFixed(3)) + ' · budget ' + skillEscHtml(candidate.evaluation.budget.exceeded ? 'exceeded' : 'ok') + '</div>' +
            '<div>' + skillEscHtml(candidate.pairwiseComparison ? candidate.pairwiseComparison.rationale : 'No pairwise comparison recorded.') + '</div>' +
          '</div>';
        }).join('') +
        '</div>' +
      '</div>';
    }).join('');

    main.innerHTML =
      '<div class="ext-header">' +
      '<h2>' + skillEscHtml(run.bestSkill.name) + '</h2>' +
      '<div class="ext-header-meta">Run ' + skillEscHtml(run.runId) + ' · ' + skillEscHtml(skillFormatDate(run.createdAt)) + '</div>' +
      '</div>' +
      '<div class="skill-summary-grid">' +
      '<div class="memory-stat-card"><div class="memory-stat-value">' + skillEscHtml(run.bestSkill.version) + '</div><div class="memory-stat-label">Best Version</div></div>' +
      '<div class="memory-stat-card"><div class="memory-stat-value">' + skillEscHtml(run.rounds.length) + '</div><div class="memory-stat-label">Rounds</div></div>' +
      '<div class="memory-stat-card"><div class="memory-stat-value">' + skillEscHtml(run.baseline.evaluation.overallScore.toFixed(3)) + '</div><div class="memory-stat-label">Baseline</div></div>' +
      '<div class="memory-stat-card"><div class="memory-stat-value">' + skillEscHtml(run.rounds.length ? run.rounds[run.rounds.length - 1].winnerScore ? run.rounds[run.rounds.length - 1].winnerScore.toFixed(3) : run.bestSkill.version : run.baseline.evaluation.overallScore.toFixed(3)) + '</div><div class="memory-stat-label">Latest Winner</div></div>' +
      '</div>' +
      '<div class="skill-builder-grid">' +
      '<div class="memory-detail-card">' +
      '<div class="memory-detail-head"><div><div class="memory-detail-title">Artifacts</div><div class="memory-detail-meta">' + skillEscHtml(run.artifactDir) + '</div></div><button id="skill-publish-run-btn" class="memory-action-btn memory-action-secondary">Publish Best Skill</button></div>' +
      '<div class="skill-chip-row">' + artifacts.map(function (artifact) { return '<span class="memory-chip">' + skillEscHtml(artifact) + '</span>'; }).join('') + '</div>' +
      '<div class="skill-round-stack">' + roundsHtml + '</div>' +
      '</div>' +
      '<div class="memory-detail-card">' +
      '<div class="memory-detail-title">Compare Versions</div>' +
      '<div class="skill-compare-controls">' +
      '<select id="skill-left-version" class="memory-select">' + versions.map(function (version) { return '<option value="' + skillEscAttr(version) + '">v' + skillEscHtml(version) + '</option>'; }).join('') + '</select>' +
      '<select id="skill-right-version" class="memory-select">' + versions.map(function (version) { return '<option value="' + skillEscAttr(version) + '"' + (version === rightVersion ? ' selected' : '') + '>v' + skillEscHtml(version) + '</option>'; }).join('') + '</select>' +
      '<button id="skill-compare-btn" class="memory-action-btn">Load Diff</button>' +
      '</div>' +
      '<div id="skill-diff-output"><pre class="skill-pre">Select two versions to inspect changes.</pre></div>' +
      '<div id="skill-version-output"><pre class="skill-pre">Select a version in the diff controls to inspect artifacts.</pre></div>' +
      '</div>' +
      '</div>';

    var compareBtn = document.getElementById('skill-compare-btn');
    if (compareBtn) {
      compareBtn.addEventListener('click', async function () {
        var left = Number(document.getElementById('skill-left-version').value);
        var right = Number(document.getElementById('skill-right-version').value);
        try {
          var diff = await fetchSkillDiff(run.runId, left, right);
          selectedSkillDiff = diff;
          document.getElementById('skill-diff-output').innerHTML = '<pre class="skill-pre">' + skillEscHtml(JSON.stringify(diff, null, 2)) + '</pre>';
          var versionArtifact = await fetchSkillVersion(run.runId, right);
          document.getElementById('skill-version-output').innerHTML = '<pre class="skill-pre">' + skillEscHtml(JSON.stringify(versionArtifact, null, 2)) + '</pre>';
        } catch (err) {
          toast('Failed: ' + err.message, 'error');
        }
      });
    }

    var publishRunBtn = document.getElementById('skill-publish-run-btn');
    if (publishRunBtn) {
      publishRunBtn.addEventListener('click', async function () {
        publishRunBtn.disabled = true;
        try {
          var published = await publishSkillRun(run.runId);
          upsertPublishedSkill(published);
          selectedPublishedSkill = published;
          selectedPublishedSkillId = published.publishedSkillId;
          renderSkillsSidebar();
          toast('Published skill for chat and pipelines: ' + published.name, 'success');
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          publishRunBtn.disabled = false;
        }
      });
    }
  }

  function wireSkillsSidebar() {
    var refreshBtn = document.getElementById('skill-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        initSkills();
      });
    }
    var cleanupBtn = document.getElementById('skill-cleanup-btn');
    if (cleanupBtn) {
      cleanupBtn.addEventListener('click', async function () {
        var daysText = prompt('Delete all unapproved draft sessions older than how many days?', '7');
        if (daysText == null) return;
        var olderThanDays = Number(daysText);
        if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
          toast('Cleanup window must be a non-negative number of days', 'error');
          return;
        }
        try {
          var result = await cleanupSkillDraftSessionsRequest({ olderThanDays: olderThanDays, unapprovedOnly: true });
          var deletedIds = result.deletedSessionIds || [];
          skillDraftSessions = skillDraftSessions.filter(function (session) {
            return deletedIds.indexOf(session.sessionId) === -1;
          });
          if (currentSkillDraft && deletedIds.indexOf(currentSkillDraft.sessionId) !== -1) {
            currentSkillDraft = null;
            selectedSkillRunId = null;
            selectedSkillRun = null;
            renderSkillBuilder();
          }
          renderSkillsSidebar();
          toast(deletedIds.length ? ('Deleted ' + deletedIds.length + ' old unapproved draft' + (deletedIds.length === 1 ? '' : 's')) : 'No old unapproved drafts matched the cleanup rule', 'success');
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }
    var toggleArchivedBtn = document.getElementById('skill-toggle-archived-btn');
    if (toggleArchivedBtn) {
      toggleArchivedBtn.addEventListener('click', function () {
        showArchivedSkillDrafts = !showArchivedSkillDrafts;
        if (!showArchivedSkillDrafts && currentSkillDraft && currentSkillDraft.archivedAt) {
          currentSkillDraft = null;
          selectedSkillRunId = null;
          selectedSkillRun = null;
          renderSkillBuilder();
        }
        renderSkillsSidebar();
      });
    }
    var newBtn = document.getElementById('skill-new-run-btn');
    if (newBtn) {
      newBtn.addEventListener('click', function () {
        selectedSkillRunId = null;
        selectedSkillRun = null;
        selectedPublishedSkillId = null;
        selectedPublishedSkill = null;
        currentSkillDraft = null;
        renderSkillsSidebar();
        renderSkillBuilder();
      });
    }
    document.querySelectorAll('[data-published-skill-id]').forEach(function (item) {
      item.addEventListener('click', function () {
        var publishedSkillId = item.dataset.publishedSkillId;
        selectedPublishedSkillId = publishedSkillId;
        selectedPublishedSkill = publishedSkills.find(function (skill) { return skill.publishedSkillId === publishedSkillId; }) || null;
        selectedSkillRunId = null;
        selectedSkillRun = null;
        currentSkillDraft = null;
        renderSkillsSidebar();
        renderPublishedSkillDetail(selectedPublishedSkill);
      });
    });
    document.querySelectorAll('[data-published-skill-toggle]').forEach(function (button) {
      button.addEventListener('click', async function (event) {
        event.stopPropagation();
        var publishedSkillId = button.dataset.publishedSkillToggle;
        var skill = publishedSkills.find(function (candidate) { return candidate.publishedSkillId === publishedSkillId; });
        if (!skill) return;
        try {
          var updated = await updatePublishedSkill(publishedSkillId, { unpublished: !skill.unpublishedAt });
          upsertPublishedSkill(updated);
          if (selectedPublishedSkillId === publishedSkillId) {
            selectedPublishedSkill = updated;
            renderPublishedSkillDetail(updated);
          }
          renderSkillsSidebar();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
    document.querySelectorAll('[data-skill-draft-id]').forEach(function (item) {
      item.addEventListener('click', function () {
        var sessionId = item.dataset.skillDraftId;
        currentSkillDraft = skillDraftSessions.find(function (session) { return session.sessionId === sessionId; }) || null;
        selectedSkillRunId = null;
        selectedSkillRun = null;
        selectedPublishedSkillId = null;
        selectedPublishedSkill = null;
        renderSkillsSidebar();
        renderSkillBuilder();
      });
    });
    document.querySelectorAll('[data-skill-draft-archive]').forEach(function (button) {
      button.addEventListener('click', async function (event) {
        event.stopPropagation();
        var sessionId = button.dataset.skillDraftArchive;
        var session = skillDraftSessions.find(function (candidate) { return candidate.sessionId === sessionId; });
        if (!session) return;
        try {
          var updated = await updateSkillDraftSession(sessionId, { archived: !session.archivedAt });
          skillDraftSessions = skillDraftSessions.map(function (candidate) {
            return candidate.sessionId === sessionId ? updated : candidate;
          });
          if (currentSkillDraft && currentSkillDraft.sessionId === sessionId) {
            currentSkillDraft = updated.archivedAt && !showArchivedSkillDrafts ? null : updated;
          }
          renderSkillsSidebar();
          if (currentSkillDraft && currentSkillDraft.sessionId === sessionId && !selectedSkillRunId) {
            renderSkillBuilder();
          } else if (sessionId === (session && session.sessionId) && updated.archivedAt && !showArchivedSkillDrafts && !selectedSkillRunId) {
            renderSkillBuilder();
          }
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
    document.querySelectorAll('[data-skill-draft-rename]').forEach(function (button) {
      button.addEventListener('click', async function (event) {
        event.stopPropagation();
        var sessionId = button.dataset.skillDraftRename;
        var session = skillDraftSessions.find(function (candidate) { return candidate.sessionId === sessionId; });
        if (!session) return;
        var currentTitle = session.title || (session.request && (session.request.goal || session.request.description)) || session.sessionId;
        var nextTitle = prompt('Rename draft session', currentTitle);
        if (nextTitle == null) return;
        try {
          var updated = await updateSkillDraftSession(sessionId, { title: nextTitle });
          skillDraftSessions = skillDraftSessions.map(function (candidate) {
            return candidate.sessionId === sessionId ? updated : candidate;
          });
          if (currentSkillDraft && currentSkillDraft.sessionId === sessionId) {
            currentSkillDraft = updated;
          }
          renderSkillsSidebar();
          if (currentSkillDraft && currentSkillDraft.sessionId === sessionId && !selectedSkillRunId) {
            renderSkillBuilder();
          }
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
    document.querySelectorAll('[data-skill-draft-delete]').forEach(function (button) {
      button.addEventListener('click', async function (event) {
        event.stopPropagation();
        var sessionId = button.dataset.skillDraftDelete;
        if (!confirm('Delete this draft session?')) return;
        try {
          await deleteSkillDraftSessionRequest(sessionId);
          skillDraftSessions = skillDraftSessions.filter(function (candidate) { return candidate.sessionId !== sessionId; });
          if (currentSkillDraft && currentSkillDraft.sessionId === sessionId) {
            currentSkillDraft = null;
            selectedSkillRunId = null;
            selectedSkillRun = null;
            renderSkillBuilder();
          }
          renderSkillsSidebar();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
    document.querySelectorAll('[data-skill-run-id]').forEach(function (item) {
      item.addEventListener('click', function () {
        selectSkillRun(item.dataset.skillRunId);
      });
    });
  }

  function wireSkillBuilder() {
    var optimizeBtn = document.getElementById('skill-optimize-btn');
    var evaluateBtn = document.getElementById('skill-evaluate-btn');
    var generateBtn = document.getElementById('skill-generate-btn');

    function collectDraftRequest() {
      var description = document.getElementById('skill-description').value.trim();
      if (!description) throw new Error('Skill description is required');
      return {
        description: description,
        goal: document.getElementById('skill-goal').value.trim() || description,
        artifactNamespace: document.getElementById('skill-namespace').value.trim() || undefined,
        constraints: parseJsonField(document.getElementById('skill-constraints').value, 'Constraints', []),
        exampleCount: Number(document.getElementById('skill-example-count').value) || 4,
      };
    }

    async function collectPayload() {
      var goal = document.getElementById('skill-goal').value.trim();
      if (!goal) throw new Error('Goal is required');
      var testCases = parseJsonField(document.getElementById('skill-test-cases').value, 'Test cases', []);
      if (!Array.isArray(testCases) || !testCases.length) throw new Error('Test cases must be a non-empty JSON array');
      var mergedConstraints = parseJsonField(document.getElementById('skill-constraints').value, 'Constraints', []);
      if (currentSkillDraft) {
        mergedConstraints = mergedConstraints.concat(buildDraftCritiqueConstraints());
      }
      return {
        goal: goal,
        artifactNamespace: document.getElementById('skill-namespace').value.trim() || undefined,
        constraints: mergedConstraints,
        testCases: testCases,
        baseSkill: parseJsonField(document.getElementById('skill-base-skill').value, 'Base skill', undefined),
        budgets: parseJsonField(document.getElementById('skill-budgets').value, 'Budgets', undefined),
        pairwiseJudging: !!document.getElementById('skill-pairwise').checked,
        draftSessionId: currentSkillDraft ? currentSkillDraft.sessionId : undefined,
      };
    }

    if (generateBtn) {
      generateBtn.addEventListener('click', async function () {
        generateBtn.disabled = true;
        generateBtn.textContent = 'Generating...';
        try {
          currentSkillDraft = await generateSkillDraftRequest(collectDraftRequest());
          upsertDraftSession(currentSkillDraft);
          selectedSkillRunId = null;
          selectedSkillRun = null;
          renderSkillsSidebar();
          syncDraftTextareas();
          renderSkillDraftOutput();
          toast('Skill draft generated', 'success');
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          generateBtn.disabled = false;
          generateBtn.textContent = 'Generate Draft';
        }
      });
    }

    if (evaluateBtn) {
      evaluateBtn.addEventListener('click', async function () {
        try {
          var payload = await collectPayload();
          if (!payload.baseSkill) throw new Error('Base skill JSON is required for draft evaluation');
          var result = await evaluateSkillDraft({ skill: payload.baseSkill, testCases: payload.testCases, budgets: payload.budgets });
          document.getElementById('skill-builder-output').innerHTML = '<div class="memory-detail-title">Draft Evaluation</div><pre class="skill-pre">' + skillEscHtml(JSON.stringify(result, null, 2)) + '</pre>';
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }

    if (optimizeBtn) {
      optimizeBtn.addEventListener('click', async function () {
        optimizeBtn.disabled = true;
        optimizeBtn.textContent = 'Optimizing...';
        try {
          var payload = await collectPayload();
          if (currentSkillDraft && !buildDraftDerivedTestCases().length) {
            throw new Error('Approve at least one generated example before optimization');
          }
          if (currentSkillDraft && !currentSkillDraft.approvedForOptimization) {
            throw new Error('Approve the draft for optimization before starting the loop');
          }
          var result = await optimizeSkillRun(payload);
          toast('Optimization finished', 'success');
          await fetchSkillRuns();
          selectedSkillRunId = result.runId;
          renderSkillsSidebar();
          await selectSkillRun(result.runId);
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          optimizeBtn.disabled = false;
          optimizeBtn.textContent = 'Optimize Approved Examples';
        }
      });
    }
  }

  async function initSkills() {
    var main = document.getElementById('main');
    if (main) {
      main.innerHTML = '<div class="loading"><div class="spinner"></div> Loading...</div>';
    }
    try {
      await fetchSkillRuns();
      await fetchSkillDraftSessions();
      await fetchPublishedSkills();
      if (selectedPublishedSkillId) {
        selectedPublishedSkill = publishedSkills.find(function (skill) { return skill.publishedSkillId === selectedPublishedSkillId; }) || null;
      }
      currentSkillDraft = getVisibleDraftSessions()[0] || null;
      renderSkillsSidebar();
      if (selectedPublishedSkill) {
        renderPublishedSkillDetail(selectedPublishedSkill);
      } else if (selectedSkillRunId) {
        await selectSkillRun(selectedSkillRunId);
      } else {
        renderSkillBuilder();
      }
    } catch (err) {
      if (main) {
        main.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#x26a0;</div><h2>Skills</h2><p>' + skillEscHtml(err.message) + '</p></div>';
      }
    }
  }

  window.initSkills = initSkills;
})();