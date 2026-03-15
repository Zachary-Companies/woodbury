function showGeneratePipelineModal() {
  var existing = document.querySelector('#comp-pipeline-gen-overlay');
  if (existing) existing.remove();

  var availableContextNodes = (compData && compData.nodes ? compData.nodes : []).slice();
  var selectedContextNodeIds = Array.from(selectedNodes || []).filter(function(id) {
    return availableContextNodes.some(function(node) { return node.id === id; });
  });
  var publishedSkillsSectionHtml =
    '<div id="comp-published-skills-section" style="margin-top:0.75rem;padding:0.75rem;border-radius:8px;background:rgba(15,23,42,0.65);border:1px solid rgba(56,189,248,0.18);">' +
      '<div style="color:#cbd5e1;font-size:0.74rem;font-weight:600;margin-bottom:0.5rem;">Published Skills Bias</div>' +
      '<div style="color:#64748b;font-size:0.68rem;margin-bottom:0.55rem;">Optionally select published skills to bias this pipeline. If you select any, generation will prioritize only those skill patterns.</div>' +
      '<div id="comp-published-skills-list" style="display:flex;flex-direction:column;gap:0.45rem;max-height:180px;overflow:auto;color:#94a3b8;font-size:0.7rem;">Loading published skills…</div>' +
    '</div>';
  var contextSectionHtml = '';
  if (availableContextNodes.length > 0) {
    var contextItemsHtml = availableContextNodes.map(function(node) {
      var checked = selectedContextNodeIds.indexOf(node.id) !== -1;
      return '<label style="display:flex;align-items:flex-start;gap:8px;padding:0.45rem 0.55rem;border-radius:8px;background:rgba(15,23,42,0.45);border:1px solid rgba(255,255,255,0.06);cursor:pointer;">' +
        '<input type="checkbox" class="comp-pipeline-context-picker" data-node-id="' + compEscAttr(node.id) + '"' + (checked ? ' checked' : '') + ' style="margin-top:2px;accent-color:#818cf8;">' +
        '<span style="display:flex;flex-direction:column;gap:2px;min-width:0;">' +
          '<span style="color:#e2e8f0;font-size:0.72rem;">' + compEscHtml(getCompositionNodeDisplayName(node)) + '</span>' +
          '<span style="color:#64748b;font-size:0.64rem;line-height:1.35;">' + compEscHtml(describeScriptGenerationNode(node)) + '</span>' +
        '</span>' +
      '</label>';
    }).join('');
    contextSectionHtml =
      '<div style="margin-top:0.75rem;padding:0.75rem;border-radius:8px;background:rgba(15,23,42,0.65);border:1px solid rgba(129,140,248,0.18);">' +
        '<div style="color:#cbd5e1;font-size:0.74rem;font-weight:600;margin-bottom:0.5rem;">Generation Context</div>' +
        '<div style="color:#64748b;font-size:0.68rem;margin-bottom:0.55rem;">Select the existing nodes the generator should consider while extending or reworking this pipeline.</div>' +
        '<div style="display:flex;flex-direction:column;gap:0.45rem;max-height:180px;overflow:auto;">' + contextItemsHtml + '</div>' +
      '</div>';
  }

  var overlay = document.createElement('div');
  overlay.id = 'comp-pipeline-gen-overlay';
  overlay.className = 'comp-modal-overlay';
  overlay.innerHTML =
    '<div class="comp-modal comp-script-modal">' +
      '<div class="comp-modal-header">' +
        '<span>&#x2728; Generate Pipeline</span>' +
        '<button class="comp-modal-close" id="comp-pipeline-gen-close">&times;</button>' +
      '</div>' +
      '<div class="comp-modal-body">' +
        '<p style="color:#94a3b8;font-size:0.78rem;margin:0 0 0.75rem 0;">' +
          'Describe a multi-step task. The AI will decompose it into connected pipeline nodes — each with simple, focused code.' +
        '</p>' +
        '<textarea id="comp-pipeline-gen-desc" class="comp-props-input comp-gate-textarea" style="min-height:100px;" ' +
          'placeholder="e.g. Take a photo from the asset library, generate a cartoon version with nanobanana, then copy the result to ~/Gallery/cartoons"></textarea>' +
        publishedSkillsSectionHtml +
        contextSectionHtml +
        '<div style="display:flex;gap:0.5rem;margin-top:1rem;">' +
          '<button class="comp-tb-btn comp-tb-btn-run" id="comp-pipeline-gen-go" style="flex:1;">Generate Pipeline</button>' +
          '<button class="comp-tb-btn" id="comp-pipeline-gen-cancel" style="flex:0;">Cancel</button>' +
        '</div>' +
        '<div id="comp-pipeline-gen-status" style="margin-top:0.75rem;display:none;">' +
          '<div style="height:4px;background:#334155;border-radius:2px;overflow:hidden;">' +
            '<div id="comp-pipeline-gen-bar" style="height:100%;background:linear-gradient(90deg,#7c3aed,#8b5cf6);width:0%;transition:width 0.4s;"></div>' +
          '</div>' +
          '<div style="display:flex;align-items:center;margin-top:6px;">' +
            '<div class="spinner" style="display:inline-block;width:12px;height:12px;margin-right:6px;flex-shrink:0;"></div>' +
            '<span id="comp-pipeline-gen-phase" style="color:#94a3b8;font-size:0.72rem;">Analyzing task structure...</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);

  fetch('/api/skills/library')
    .then(function(res) { return res.json().then(function(data) { return { ok: res.ok, data: data }; }); })
    .then(function(result) {
      var listEl = overlay.querySelector('#comp-published-skills-list');
      if (!listEl) return;
      if (!result.ok) {
        listEl.textContent = result.data && result.data.error ? result.data.error : 'Failed to load published skills';
        return;
      }
      var skills = (result.data.skills || []).filter(function(skill) {
        return !skill.unpublishedAt && skill.audience && skill.audience.pipelines;
      });
      if (!skills.length) {
        listEl.textContent = 'No published pipeline skills available yet.';
        return;
      }
      listEl.innerHTML = skills.map(function(skill) {
        return '<label style="display:flex;align-items:flex-start;gap:8px;padding:0.45rem 0.55rem;border-radius:8px;background:rgba(15,23,42,0.45);border:1px solid rgba(255,255,255,0.06);cursor:pointer;">' +
          '<input type="checkbox" class="comp-published-skill-picker" data-skill-id="' + compEscAttr(skill.publishedSkillId) + '" style="margin-top:2px;accent-color:#38bdf8;">' +
          '<span style="display:flex;flex-direction:column;gap:2px;min-width:0;">' +
            '<span style="color:#e2e8f0;font-size:0.72rem;">' + compEscHtml(skill.name) + '</span>' +
            '<span style="color:#64748b;font-size:0.64rem;line-height:1.35;">' + compEscHtml(skill.description || skill.skill.purpose || '') + '</span>' +
          '</span>' +
        '</label>';
      }).join('');
    })
    .catch(function() {
      var listEl = overlay.querySelector('#comp-published-skills-list');
      if (listEl) listEl.textContent = 'Failed to load published skills';
    });

  overlay.querySelector('#comp-pipeline-gen-close').addEventListener('click', function() { overlay.remove(); });
  overlay.querySelector('#comp-pipeline-gen-cancel').addEventListener('click', function() { overlay.remove(); });
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector('#comp-pipeline-gen-go').addEventListener('click', async function() {
    var desc = overlay.querySelector('#comp-pipeline-gen-desc').value.trim();
    if (!desc) { toast('Please describe the pipeline you want to create', 'error'); return; }

    var genBtn = overlay.querySelector('#comp-pipeline-gen-go');
    var statusEl = overlay.querySelector('#comp-pipeline-gen-status');
    var barEl = overlay.querySelector('#comp-pipeline-gen-bar');
    var phaseEl = overlay.querySelector('#comp-pipeline-gen-phase');
    genBtn.disabled = true;
    statusEl.style.display = '';

    var pipelinePhases = [
      { pct: '15%', text: 'Analyzing task structure...', delay: 0 },
      { pct: '30%', text: 'Decomposing into sub-contracts...', delay: 3000 },
      { pct: '50%', text: 'Generating pipeline nodes...', delay: 8000 },
      { pct: '65%', text: 'Generating code for pipeline nodes...', delay: 15000 },
      { pct: '80%', text: 'Validating and repairing node code...', delay: 25000 },
      { pct: '90%', text: 'Almost done...', delay: 45000 },
    ];
    var phaseTimers = [];
    pipelinePhases.forEach(function(phase) {
      phaseTimers.push(setTimeout(function() {
        if (barEl) barEl.style.width = phase.pct;
        if (phaseEl) phaseEl.textContent = phase.text;
      }, phase.delay));
    });

    try {
      var chosenContextNodeIds = Array.from(overlay.querySelectorAll('.comp-pipeline-context-picker:checked')).map(function(input) {
        return input.getAttribute('data-node-id');
      }).filter(Boolean);
      var chosenPublishedSkillIds = Array.from(overlay.querySelectorAll('.comp-published-skill-picker:checked')).map(function(input) {
        return input.getAttribute('data-skill-id');
      }).filter(Boolean);
      var res = await fetch('/api/compositions/generate-pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: desc,
          selectedPublishedSkillIds: chosenPublishedSkillIds,
          graphContext: chosenContextNodeIds.length > 0
            ? buildScriptGenerationContext(null, chosenContextNodeIds)
            : undefined,
        }),
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Pipeline generation failed');

      phaseTimers.forEach(clearTimeout);
      if (barEl) barEl.style.width = '100%';
      if (phaseEl) phaseEl.textContent = 'Done!';

      addGeneratedPipeline(data.nodes, data.edges, data.name, data.documentation);

      overlay.remove();
      toast('Pipeline generated with ' + data.nodes.length + ' nodes!', 'success');
    } catch (err) {
      phaseTimers.forEach(clearTimeout);
      if (barEl) barEl.style.width = '0%';
      toast('Failed to generate pipeline: ' + err.message, 'error');
      genBtn.disabled = false;
      statusEl.style.display = 'none';
    }
  });

  requestAnimationFrame(function() {
    var ta = overlay.querySelector('#comp-pipeline-gen-desc');
    if (ta) ta.focus();
  });
}

function storeGeneratedPipelineDocumentation(documentation, nodes, edges) {
  if (!compData || !documentation || !documentation.markdown) return;
  if (!compData.metadata) {
    compData.metadata = {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (!Array.isArray(compData.metadata.generatedPipelineDocs)) {
    compData.metadata.generatedPipelineDocs = [];
  }
  compData.metadata.generatedPipelineDocs.unshift({
    id: genId('gendoc'),
    title: documentation.title || 'Generated Pipeline',
    summary: documentation.summary || '',
    markdown: documentation.markdown,
    request: documentation.request || '',
    createdAt: new Date().toISOString(),
    nodeIds: Array.isArray(nodes) ? nodes.map(function(node) { return node.id; }) : undefined,
    edgeIds: Array.isArray(edges) ? edges.map(function(edge) { return edge.id; }) : undefined,
  });
  if (!compData.description && documentation.summary) {
    compData.description = documentation.summary;
  }
}

function addGeneratedPipeline(nodes, edges, pipelineName, documentation) {
  if (!compData) return;
  pushUndoSnapshot();

  for (var i = 0; i < nodes.length; i++) {
    compData.nodes.push(nodes[i]);
  }

  for (var j = 0; j < edges.length; j++) {
    compData.edges.push(edges[j]);
  }

  storeGeneratedPipelineDocumentation(documentation, nodes, edges);

  layoutNodesInternal();

  selectedNodes.clear();
  for (var k = 0; k < nodes.length; k++) {
    selectedNodes.add(nodes[k].id);
  }
  selectedEdge = null; selectedEdges.clear();

  renderNodes();
  renderEdges();
  wireUpCanvas();
  updateNodeSelection();
  updateDeleteButton();
  updatePropertiesPanel();
  immediateSave();
  fetchCompositions();
}