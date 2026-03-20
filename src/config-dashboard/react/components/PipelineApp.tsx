/**
 * PipelineApp — the main React shell for pipeline app mode.
 * Replaces the vanilla JS app shell entirely when React is available.
 * Layout: Sidebar (left) + Content area (right).
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { PipelineProvider, usePipeline } from '../stores/PipelineProvider';
import { Sidebar, type ViewMode } from './Sidebar';
import { ScreenplayView } from './ScreenplayView';
import { DataView } from './DataView';
import { VoicesView } from './VoicesView';
import { OverviewView } from './OverviewView';
import { NodeSection } from './NodeSection';
import { SettingsView } from './SettingsView';
import { ImportModal } from './ImportModal';
import { ImportScriptModal } from './ImportScriptModal';

interface PipelineAppProps {
  pipelineId: string;
  /** Pre-fetched schema from compositions-app.js (optional — will fetch if missing) */
  schema?: any;
  /** Pre-fetched appState from compositions-app.js (optional — will fetch if missing) */
  appState?: any;
}

export function PipelineApp({ pipelineId, schema: initialSchema, appState: initialAppState }: PipelineAppProps) {
  return (
    <PipelineProvider pipelineId={pipelineId}>
      <PipelineAppInner pipelineId={pipelineId} initialSchema={initialSchema} initialAppState={initialAppState} />
    </PipelineProvider>
  );
}

function PipelineAppInner({ pipelineId, initialSchema, initialAppState }: {
  pipelineId: string;
  initialSchema?: any;
  initialAppState?: any;
}) {
  const pipeline = usePipeline();
  const { loading, projectFolder, project: projectData } = pipeline;
  const [showImport, setShowImport] = useState(false);
  const [currentView, setCurrentView] = useState<ViewMode>('screenplay');
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [schema, setSchema] = useState<any>(initialSchema || null);
  const [appState, setAppState] = useState<any>(initialAppState || null);

  // Fetch schema/state if not passed as props
  useEffect(() => {
    if (schema && appState) return;
    (async () => {
      try {
        const promises: Promise<Response>[] = [];
        if (!schema) promises.push(fetch(`/api/app/${encodeURIComponent(pipelineId)}/schema`));
        if (!appState) promises.push(fetch(`/api/app/${encodeURIComponent(pipelineId)}/state`));
        const results = await Promise.all(promises);

        let idx = 0;
        if (!schema) { setSchema(await results[idx].json()); idx++; }
        if (!appState) { setAppState(await results[idx].json()); }
      } catch {}
    })();
  }, [pipelineId, schema, appState]);

  const handleViewChange = useCallback((view: ViewMode) => {
    setCurrentView(view);
    setActiveSection(null); // Clear section when switching to a named view
    // Update hash for deep linking
    if (typeof (window as any).updateHash === 'function') {
      (window as any).updateHash('compositions', pipelineId, 'app', view);
    }
  }, [pipelineId]);

  const handleSectionChange = useCallback((sectionId: string) => {
    setActiveSection(sectionId);
    setCurrentView('data'); // Section clicks use the node data view
  }, []);

  // Listen for import modal requests
  useEffect(() => {
    const handler = () => setShowImport(true);
    window.addEventListener('woodbury:show-import', handler);
    return () => window.removeEventListener('woodbury:show-import', handler);
  }, []);

  // Auto-show import modal when there's no project folder
  useEffect(() => {
    if (loading) return;
    if (!projectFolder) {
      setShowImport(true);
    }
  }, [loading, projectFolder]);

  // Listen for view switch requests from child components
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.view) handleViewChange(detail.view);
    };
    window.addEventListener('woodbury:switch-view', handler);
    return () => window.removeEventListener('woodbury:switch-view', handler);
  }, [handleViewChange]);

  // Find the active section's schema definition
  const activeSectionDef = activeSection
    ? schema?.sections?.find((s: any) => s.id === activeSection)
    : null;

  return (
    <div className="app-shell">
      {/* Sidebar */}
      <Sidebar
        currentView={currentView}
        onViewChange={handleViewChange}
        activeSection={activeSection}
        onSectionChange={handleSectionChange}
        pipelineId={pipelineId}
        schema={schema}
        appState={appState}
      />

      {/* Content */}
      <div className="app-content" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {loading ? (
            <div className="app-loading">
              <span className="spinner"></span> Loading...
            </div>
          ) : (
            <>
              {/* Node section view (when a specific node is selected in sidebar) */}
              {activeSection && activeSectionDef ? (
                <NodeSection section={activeSectionDef} appState={appState} pipelineId={pipelineId} />
              ) : (
                <>
                  {currentView === 'overview' && <OverviewView schema={schema} appState={appState} />}
                  {currentView === 'screenplay' && <ScreenplayView />}
                  {currentView === 'data' && <DataView />}
                  {currentView === 'voices' && <VoicesView />}
                  {currentView === 'settings' && <SettingsView schema={schema} appState={appState} pipelineId={pipelineId} />}
                  {currentView === 'editor' && <VanillaViewBridge viewName="editor" pipelineId={pipelineId} appState={appState} />}
                  {currentView === 'script' && <VanillaViewBridge viewName="script-editor" pipelineId={pipelineId} appState={appState} />}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* Import modal */}
      {showImport && <ImportScriptModal pipelineId={pipelineId} onClose={() => setShowImport(false)} />}
    </div>
  );
}

/**
 * VanillaViewBridge — loads a vanilla JS pipeline custom view (editor, script-editor)
 * by fetching its JS/CSS and executing it in a container div.
 */
function VanillaViewBridge({ viewName, pipelineId, appState: externalAppState }: {
  viewName: string;
  pipelineId: string;
  appState?: any;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { project: projectData } = usePipeline();
  const loadedRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Prevent double-loading
    if (loadedRef.current) return;
    loadedRef.current = true;

    const enc = encodeURIComponent;

    // Load the custom view's CSS
    const cssId = `pipeline-view-css-bridge-${viewName}`;
    if (!document.getElementById(cssId)) {
      const cssLink = document.createElement('link');
      cssLink.rel = 'stylesheet';
      cssLink.id = cssId;
      cssLink.href = `/api/app/${enc(pipelineId)}/view-file/${enc(viewName)}/view.css`;
      document.head.appendChild(cssLink);
    }

    // Create a scoped container
    const scope = document.createElement('div');
    scope.className = 'pipeline-view-scope';
    scope.setAttribute('data-pipeline-view', viewName);
    scope.style.height = '100%';
    scope.style.display = 'flex';
    scope.style.flexDirection = 'column';
    container.appendChild(scope);

    // Build the appState that the vanilla view expects
    // This must include nodeData from the actual pipeline state
    const viewAppState = externalAppState || {
      pipelineId,
      pipelineName: projectData?.metadata?.title || '',
      nodeData: {},
      staleNodes: [],
    };

    // Check if the view was already registered (loaded via loadPipelineCustomViews)
    const views = (window as any)._pipelineCustomViews || [];
    const existing = views.find((v: any) => v.name === viewName);
    if (existing && existing.render) {
      try {
        const data = existing.stitch ? existing.stitch(viewAppState) : viewAppState;
        scope.innerHTML = existing.render(data, viewAppState);
        if (existing.wireEvents) existing.wireEvents(scope, viewAppState);
      } catch (err) {
        scope.innerHTML = `<div style="padding:20px;color:#f87171;font-size:13px;">View "${viewName}" failed to render</div>`;
      }
      return;
    }

    // Load and execute the view JS (fallback if not pre-loaded)
    const scriptId = `pipeline-view-js-bridge-${viewName}`;
    if (!document.getElementById(scriptId)) {
      const script = document.createElement('script');
      script.id = scriptId;
      script.src = `/api/app/${enc(pipelineId)}/view-file/${enc(viewName)}/view.js`;
      script.onload = () => {
        const updatedViews = (window as any)._pipelineCustomViews || [];
        const view = updatedViews.find((v: any) => v.name === viewName);
        if (view && view.render) {
          try {
            const data = view.stitch ? view.stitch(viewAppState) : viewAppState;
            scope.innerHTML = view.render(data, viewAppState);
            if (view.wireEvents) view.wireEvents(scope, viewAppState);
          } catch (err) {
            scope.innerHTML = `<div style="padding:20px;color:#f87171;font-size:13px;">View "${viewName}" failed to render</div>`;
          }
        } else {
          scope.innerHTML = `<div style="padding:20px;color:#64748b;font-size:13px;">Custom view "${viewName}" not found. Run the pipeline to generate views.</div>`;
        }
      };
      script.onerror = () => {
        scope.innerHTML = `<div style="padding:20px;color:#64748b;font-size:13px;">Custom view "${viewName}" not available for this pipeline.</div>`;
      };
      document.body.appendChild(script);
    }

    return () => {
      loadedRef.current = false;
      container.innerHTML = '';
    };
  }, [viewName, pipelineId]);

  return (
    <div ref={containerRef} className="h-full overflow-hidden" style={{ padding: 0 }} />
  );
}
