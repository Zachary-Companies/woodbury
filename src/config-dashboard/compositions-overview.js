function getGeneratedPipelineDocs() {
  if (!compData || !compData.metadata || !Array.isArray(compData.metadata.generatedPipelineDocs)) return [];
  return compData.metadata.generatedPipelineDocs.filter(Boolean);
}

function getSelectedGeneratedPipelineDocs() {
  if (!selectedNodes || selectedNodes.size === 0) return [];
  return getGeneratedPipelineDocs().filter(function(entry) {
    return entry && Array.isArray(entry.nodeIds) && entry.nodeIds.length > 0 && entry.nodeIds.every(function(nodeId) {
      return selectedNodes.has(nodeId);
    });
  });
}

function renderGeneratedPipelineDocsSection(entries, title, emptyMessage) {
  var docs = Array.isArray(entries) ? entries.filter(Boolean) : [];
  var html = '';
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">' + compEscHtml(title || 'Documentation') + '</div>';
  if (docs.length === 0) {
    html += '<div class="comp-props-value" style="font-size:0.72rem;color:#64748b;">' + compEscHtml(emptyMessage || 'No documentation available yet.') + '</div>';
    html += '</div>';
    return html;
  }
  html += '<div style="display:flex;flex-direction:column;gap:0.55rem;max-height:360px;overflow:auto;">';
  for (var i = 0; i < docs.length; i++) {
    var entry = docs[i] || {};
    var markdown = String(entry.markdown || '').trim();
    var bodyHtml = markdown
      ? (typeof marked !== 'undefined'
          ? '<div class="comp-form-markdown-viewer" style="padding:0.7rem 0.9rem;">' + marked.parse(markdown) + '</div>'
          : '<pre style="margin:0;padding:0.7rem 0.9rem;white-space:pre-wrap;word-break:break-word;font-size:0.72rem;line-height:1.45;color:#cbd5e1;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">' + compEscHtml(markdown) + '</pre>')
      : '<div style="padding:0.7rem 0.9rem;color:#64748b;font-size:0.72rem;">No documentation body recorded.</div>';
    var metaBits = [];
    if (entry.createdAt) metaBits.push(new Date(entry.createdAt).toLocaleString());
    if (Array.isArray(entry.nodeIds) && entry.nodeIds.length > 0) metaBits.push(entry.nodeIds.length + ' node' + (entry.nodeIds.length === 1 ? '' : 's'));
    html += '<details style="border:1px solid rgba(56,189,248,0.16);border-radius:10px;background:rgba(15,23,42,0.5);"' + (i === 0 ? ' open' : '') + '>';
    html += '<summary style="cursor:pointer;list-style:none;padding:0.55rem 0.75rem;display:flex;flex-direction:column;gap:0.2rem;">';
    html += '<span style="color:#e2e8f0;font-size:0.74rem;font-weight:600;">' + compEscHtml(entry.title || ('Generated Documentation ' + (i + 1))) + '</span>';
    if (entry.summary) {
      html += '<span style="color:#94a3b8;font-size:0.68rem;line-height:1.4;">' + compEscHtml(entry.summary) + '</span>';
    }
    if (metaBits.length > 0) {
      html += '<span style="color:#64748b;font-size:0.64rem;">' + compEscHtml(metaBits.join(' · ')) + '</span>';
    }
    html += '</summary>';
    html += bodyHtml;
    html += '</details>';
  }
  html += '</div>';
  html += '</div>';
  return html;
}

function renderScriptGenerationOverviewMetrics(container, payload) {
  if (!container) return;
  var aggregate = payload && payload.aggregate ? payload.aggregate : null;
  var recent = payload && Array.isArray(payload.recent) ? payload.recent : [];
  if (!aggregate) {
    container.innerHTML = '<div class="comp-props-value" style="font-size:0.68rem;color:#64748b;">No generation metrics available yet.</div>';
    return;
  }
  var html = '';
  html += '<div class="comp-props-value" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0.45rem;font-size:0.68rem;">';
  html += '<div><strong>Policy:</strong> ' + compEscHtml(payload.policy || 'mixed') + '</div>';
  html += '<div><strong>Total requests:</strong> ' + compEscHtml(String(aggregate.totalRequests || 0)) + '</div>';
  html += '<div><strong>Fallback rate:</strong> ' + compEscHtml(Math.round((aggregate.fallbackRate || 0) * 100) + '%') + '</div>';
  html += '<div><strong>Repair rate:</strong> ' + compEscHtml(Math.round((aggregate.repairRate || 0) * 100) + '%') + '</div>';
  html += '<div><strong>Runtime evidence:</strong> ' + compEscHtml(Math.round((aggregate.runtimeEvidenceRate || 0) * 100) + '%') + '</div>';
  html += '<div><strong>Execution verified:</strong> ' + compEscHtml(Math.round((aggregate.executionVerifiedRate || 0) * 100) + '%') + '</div>';
  html += '<div><strong>Sample execution:</strong> ' + compEscHtml(Math.round((aggregate.sampleExecutionRate || 0) * 100) + '%') + '</div>';
  html += '<div><strong>Avg. retrieved examples:</strong> ' + compEscHtml((aggregate.averageRetrievedExamples || 0).toFixed(1)) + '</div>';
  html += '<div><strong>Avg. manual edits:</strong> ' + compEscHtml((aggregate.averageManualEdits || 0).toFixed(1)) + '</div>';
  html += '<div><strong>Direct/agentic/fallback:</strong> ' + compEscHtml([aggregate.byPath && aggregate.byPath.direct || 0, aggregate.byPath && aggregate.byPath.agentic || 0, aggregate.byPath && aggregate.byPath.fallback || 0].join(' / ')) + '</div>';
  html += '</div>';
  if (payload.modeOverrides) {
    var overrideBits = [];
    ['generate', 'edit', 'repair', 'verify'].forEach(function(mode) {
      var override = payload.modeOverrides && payload.modeOverrides[mode];
      if (override && override !== 'inherit') overrideBits.push(mode + ':' + override);
    });
    html += '<div style="margin-top:0.45rem;color:#64748b;font-size:0.66rem;">Mode overrides: ' + compEscHtml(overrideBits.length > 0 ? overrideBits.join(' · ') : 'inherit') + '</div>';
  }
  if (recent.length > 0) {
    html += '<div style="margin-top:0.55rem;color:#64748b;font-size:0.66rem;">Recent runs:</div>';
    html += '<div style="display:flex;flex-direction:column;gap:0.35rem;margin-top:0.35rem;">';
    recent.slice(0, 5).forEach(function(entry) {
      var when = entry && entry.timestamp ? new Date(entry.timestamp).toLocaleString() : 'Unknown time';
      var label = entry && entry.currentNodeLabel ? entry.currentNodeLabel : (entry && entry.mode ? entry.mode : 'generation');
      var path = entry && entry.metrics ? entry.metrics.generationPath : 'unknown';
      var metrics = entry && entry.metrics ? entry.metrics : {};
      var extras = [];
      if (metrics.sampleExecutionUsed) extras.push('sample:' + (metrics.sampleExecutionSource || 'yes'));
      if (metrics.manualEditCount) extras.push('manual edits:' + metrics.manualEditCount);
      html += '<div style="font-size:0.66rem;color:#94a3b8;">' + compEscHtml(when + ' · ' + label + ' · ' + path + (extras.length ? ' · ' + extras.join(' · ') : '')) + '</div>';
    });
    html += '</div>';
  }
  container.innerHTML = html;
}

function loadScriptGenerationOverviewMetrics(body) {
  var container = body && body.querySelector ? body.querySelector('#comp-props-script-generation-metrics') : null;
  if (!container) return;
  container.innerHTML = '<div class="comp-props-value" style="font-size:0.68rem;color:#64748b;">Loading script generation metrics...</div>';
  fetch('/api/compositions/script-generation-metrics?limit=12')
    .then(function(res) { return res.json().then(function(data) { return { ok: res.ok, data: data }; }); })
    .then(function(result) {
      if (!result.ok) throw new Error(result.data && result.data.error ? result.data.error : 'Failed to load metrics');
      renderScriptGenerationOverviewMetrics(container, result.data);
    })
    .catch(function(err) {
      container.innerHTML = '<div class="comp-props-value" style="font-size:0.68rem;color:#ef4444;">' + compEscHtml(err && err.message ? err.message : String(err)) + '</div>';
    });
}

function renderCompositionOverviewProperties(panel, body) {
  if (!panel || !body || !compData) {
    hidePropertiesPanel();
    return;
  }
  var docs = getGeneratedPipelineDocs();
  panel.style.display = '';
  body.innerHTML =
    '<div class="comp-props-section">' +
    '<div class="comp-props-label">Pipeline</div>' +
    '<div class="comp-props-value" style="font-weight:600;">' + compEscHtml(compData.name || 'Untitled Pipeline') + '</div>' +
    '<div class="comp-props-value" style="font-size:0.7rem;color:#64748b;margin-top:0.2rem;">' + compEscHtml((compData.nodes || []).length + ' nodes · ' + (compData.edges || []).length + ' edges') + '</div>' +
    '</div>' +
    '<div class="comp-props-section">' +
    '<div class="comp-props-label">Description</div>' +
    '<textarea class="comp-props-input" id="comp-props-composition-description" rows="4" placeholder="Describe what this pipeline is for and what it produces.">' + compEscHtml(compData.description || '') + '</textarea>' +
    '<button class="comp-tb-btn comp-tb-btn-generate" id="comp-props-generate-documentation" style="width:100%;margin-top:0.5rem;">Generate Documentation</button>' +
    '<div id="comp-props-generate-documentation-status" style="display:none;font-size:0.7rem;color:#94a3b8;margin-top:0.35rem;">Building pipeline documentation from the current graph...</div>' +
    '</div>' +
    '<div class="comp-props-section">' +
    '<div class="comp-props-label">Script Generation Metrics</div>' +
    '<div id="comp-props-script-generation-metrics"></div>' +
    '</div>' +
    renderGeneratedPipelineDocsSection(docs, 'Generated Documentation', 'Generate a pipeline segment to attach durable documentation here.');

  var descriptionInput = body.querySelector('#comp-props-composition-description');
  if (descriptionInput) {
    descriptionInput.addEventListener('change', function() {
      pushUndoSnapshot();
      compData.description = this.value.trim() || undefined;
      renderGraphEditor();
      immediateSave();
    });
  }

  var generateDocsBtn = body.querySelector('#comp-props-generate-documentation');
  var generateDocsStatus = body.querySelector('#comp-props-generate-documentation-status');
  if (generateDocsBtn) {
    generateDocsBtn.addEventListener('click', async function() {
      if (!compData) return;
      generateDocsBtn.disabled = true;
      if (generateDocsStatus) generateDocsStatus.style.display = '';
      try {
        var res = await fetch('/api/compositions/generate-documentation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            composition: compData,
            request: compData.description || '',
          }),
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to generate documentation');

        pushUndoSnapshot();
        storeGeneratedPipelineDocumentation(data.documentation, compData.nodes || [], compData.edges || []);
        immediateSave();
        renderCompositionOverviewProperties(panel, body);
        toast('Pipeline documentation generated', 'success');
      } catch (err) {
        toast('Documentation generation failed: ' + (err && err.message ? err.message : err), 'error');
      } finally {
        if (generateDocsStatus) generateDocsStatus.style.display = 'none';
        if (generateDocsBtn) generateDocsBtn.disabled = false;
      }
    });
  }

  loadScriptGenerationOverviewMetrics(body);
}