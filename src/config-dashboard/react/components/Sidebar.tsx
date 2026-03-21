/**
 * Sidebar — left sidebar for the pipeline app.
 * Uses the existing .app-sidebar CSS classes from styles.css for styling.
 */
import React, { useState, useCallback } from 'react';
import { usePipeline } from '../stores/PipelineProvider';
import { GitStatus } from './GitStatus';
import { SaveLoadPanel } from './SaveLoadPanel';
import { CommandBar } from './CommandBar';

export type ViewMode = string;

export interface ViewDefinition {
  id: string;
  label: string;
  icon: string;
  type?: 'builtin' | 'react' | 'vanilla';
  order?: number;
}

interface SidebarProps {
  currentView: ViewMode;
  onViewChange: (view: ViewMode) => void;
  activeSection: string | null;
  onSectionChange: (sectionId: string) => void;
  pipelineId: string;
  schema: any | null;
  appState: any | null;
  availableViews: ViewDefinition[];
}

export function Sidebar({ currentView, onViewChange, activeSection, onSectionChange, pipelineId, schema, appState, availableViews }: SidebarProps) {
  const pipeline = usePipeline();
  const { pipelineName, projectFolder, project: projectData } = pipeline;

  // Derive sections from schema (must be before useState that references nodeSections)
  const overviewSection = schema?.sections?.find((s: any) => s.type === 'overview') || null;
  const settingsSection = schema?.sections?.find((s: any) => s.type === 'settings') || null;
  const nodeSections = schema?.sections?.filter((s: any) => s.type !== 'overview' && s.type !== 'settings') || [];

  const [nodesCollapsed, setNodesCollapsed] = useState(nodeSections.length > 6);
  const [showSaveLoad, setShowSaveLoad] = useState(false);
  const staleSet = new Set<string>(appState?.staleNodes || []);
  const staleCount = staleSet.size;

  const handleNewProject = useCallback(async () => {
    if (projectData && projectData.elements?.length > 0) {
      if (!confirm('This will clear all current project data. Continue?')) return;
    }
    // Delete all state on server (this deletes project.json + node files)
    await fetch(`/api/app/${encodeURIComponent(pipelineId)}/state`, { method: 'DELETE' });
    // Clear projectFolder so it doesn't point to old data on next load
    await fetch(`/api/compositions/${encodeURIComponent(pipelineId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata: { projectFolder: null } }),
    });
    // Navigate to form view (same behavior as old resetAndShowForm)
    if (typeof (window as any).updateHash === 'function') {
      (window as any).updateHash('compositions', pipelineId, 'form');
    }
    if (typeof (window as any).selectComposition === 'function') {
      (window as any).selectComposition(pipelineId, 'form');
    }
  }, [pipelineId, projectData]);

  const handleImportScript = useCallback(() => {
    window.dispatchEvent(new Event('woodbury:show-import'));
  }, []);

  const handleRunPipeline = useCallback(() => {
    if (typeof (window as any).showCompositionRunForm === 'function') {
      (window as any).showCompositionRunForm();
    }
  }, []);

  const handleOpenEditor = useCallback(() => {
    if (typeof (window as any).selectComposition === 'function') {
      (window as any).selectComposition(pipelineId, null);
    }
  }, [pipelineId]);

  const handleOpenForm = useCallback(() => {
    if (typeof (window as any).selectComposition === 'function') {
      (window as any).selectComposition(pipelineId, 'form');
    }
  }, [pipelineId]);

  const handleRefreshStale = useCallback(async () => {
    try {
      await fetch(`/api/app/${encodeURIComponent(pipelineId)}/refresh-from-run`, { method: 'POST' });
      await pipeline.reload();
    } catch {}
  }, [pipelineId, pipeline]);

  const title = projectData?.metadata?.title || pipelineName || 'Pipeline';
  const logoSrc = schema?.logo
    ? (schema.logo.startsWith('data:') || schema.logo.startsWith('http')
        ? schema.logo
        : `/api/file?path=${encodeURIComponent(schema.logo)}`)
    : null;

  return (
    <div className="app-sidebar">
      {/* Header */}
      <div className="app-sidebar-header">
        {logoSrc && (
          <div className="app-sidebar-logo">
            <img src={logoSrc} alt="" className="app-sidebar-logo-img" />
          </div>
        )}
        <h2 className="app-sidebar-title">{title}</h2>
        {schema?.description && (
          <p className="app-sidebar-desc">{schema.description}</p>
        )}
        {projectFolder && (
          <p className="app-sidebar-desc" style={{ color: '#7c3aed', marginTop: 4, cursor: 'pointer' }} title={projectFolder} onClick={() => {
            // Copy full path to clipboard
            navigator.clipboard.writeText(projectFolder);
          }}>
            📁 {projectFolder}
          </p>
        )}
      </div>

      {/* Navigation */}
      <nav className="app-nav" aria-label="App sections">
        {/* View tabs (sorted by order) */}
        {[...availableViews].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(tab => (
          <button
            key={tab.id}
            onClick={() => onViewChange(tab.id)}
            className={`app-nav-item${currentView === tab.id && !activeSection ? ' active' : ''}`}
          >
            <span className="app-nav-label">
              {tab.icon && tab.icon.startsWith('<svg') ? (
                <span className="app-nav-icon" dangerouslySetInnerHTML={{ __html: tab.icon }} />
              ) : tab.icon ? (
                <span className="app-nav-icon">{tab.icon}</span>
              ) : null}
              {' '}{tab.label}
            </span>
          </button>
        ))}

        {/* Node sections — collapsible panel */}
        {nodeSections.length > 0 && (
          <div className={`app-nav-panel${nodesCollapsed ? ' collapsed' : ''}`} data-panel="nodes">
            <button className="app-nav-panel-header" onClick={() => setNodesCollapsed(!nodesCollapsed)}>
              <span className="app-nav-panel-icon">{nodesCollapsed ? '▶' : '▼'}</span>
              <span className="app-nav-panel-title">Nodes</span>
              <span className="app-nav-panel-count">{nodeSections.length}</span>
            </button>
            {!nodesCollapsed && (
              <div className="app-nav-panel-body">
                {nodeSections.map((section: any) => {
                  const isActive = activeSection === section.id;
                  const isStale = section.nodeId ? staleSet.has(section.nodeId) : false;
                  const hasData = !!(section.nodeId && appState?.nodeData?.[section.nodeId]);
                  const nodeData = section.nodeId ? appState?.nodeData?.[section.nodeId] : null;

                  let itemCount = '';
                  if (hasData && nodeData?.outputs) {
                    const firstKey = Object.keys(nodeData.outputs)[0];
                    const firstVal = firstKey ? nodeData.outputs[firstKey] : null;
                    if (Array.isArray(firstVal)) itemCount = ` (${firstVal.length})`;
                    else if (firstVal && typeof firstVal === 'object') itemCount = ` (${Object.keys(firstVal).length})`;
                  }

                  return (
                    <button
                      key={section.id}
                      onClick={() => onSectionChange(section.id)}
                      className={`app-nav-item${isActive ? ' active' : ''}${isStale ? ' stale' : ''}`}
                    >
                      <span className="app-nav-label">{section.label}{itemCount}</span>
                      {isStale && <span className="app-nav-stale">⚠</span>}
                      {nodeData?.manuallyEdited && <span className="app-nav-edited">✎</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </nav>

      {/* Actions */}
      <div className="app-sidebar-actions">
        <button onClick={handleRunPipeline} className="app-action-btn">▶ Run Pipeline</button>
        <button onClick={handleNewProject} className="app-action-btn app-action-new-project">✨ New Project</button>
        <button onClick={handleImportScript} className="app-action-btn app-action-import">📄 Import Script</button>
        {staleCount > 0 && (
          <button onClick={handleRefreshStale} className="app-action-btn app-action-refresh">
            🔄 Refresh {staleCount} stale
          </button>
        )}
        <button onClick={handleOpenEditor} className="app-action-btn app-action-secondary">Open Editor</button>
        <button onClick={handleOpenForm} className="app-action-btn app-action-secondary">Open Form</button>

        {/* Save / Load */}
        <div className="app-save-section">
          <div className="app-save-row">
            <button onClick={() => setShowSaveLoad(true)} className="app-action-btn app-action-save">💾 Save / Load</button>
          </div>
        </div>

        {/* Git */}
        <div style={{ marginTop: 4 }}>
          <GitStatus pipelineId={pipelineId} />
        </div>
      </div>

      {/* Command bar */}
      <CommandBar pipelineId={pipelineId} />

      {/* Save/Load modal */}
      {showSaveLoad && (
        <SaveLoadPanel pipelineId={pipelineId} onClose={() => setShowSaveLoad(false)} />
      )}
    </div>
  );
}
