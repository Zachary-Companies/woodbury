/**
 * PipelineApp — the main React shell for pipeline app mode.
 * Replaces the vanilla JS app shell entirely when React is available.
 * Layout: Sidebar (left) + Content area (right).
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { PipelineProvider, usePipeline } from '../stores/PipelineProvider';
import { Sidebar, type ViewMode, type ViewDefinition } from './Sidebar';
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
  const [currentView, setCurrentView] = useState<ViewMode>('');
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [schema, setSchema] = useState<any>(initialSchema || null);
  const [appState, setAppState] = useState<any>(initialAppState || null);
  const [discoveredViews, setDiscoveredViews] = useState<ViewDefinition[]>([]);
  const viewsLoaded = useRef(false);

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

  // Discover views from the server and merge with reactViewRegistry
  useEffect(() => {
    if (viewsLoaded.current) return;
    viewsLoaded.current = true;

    (async () => {
      const views: ViewDefinition[] = [];
      try {
        const res = await fetch(`/api/app/${encodeURIComponent(pipelineId)}/views`);
        if (res.ok) {
          const data = await res.json();
          for (const v of (data.views || [])) {
            views.push({
              id: v.name,
              label: v.label || v.name,
              icon: v.icon || '',
              type: v.type === 'react' ? 'react' : 'vanilla',
              order: v.order ?? 50,
            });
          }
        }
      } catch {}

      // Also include any views already registered in the React view registry
      const registry = (window as any).__woodburyReactViewRegistry as Map<string, any> | undefined;
      if (registry) {
        for (const [name, def] of registry) {
          if (!views.find(v => v.id === name)) {
            views.push({
              id: name,
              label: def.label || name,
              icon: def.icon || '',
              type: 'react',
              order: def.order ?? 50,
            });
          }
        }
      }

      setDiscoveredViews(views);
    })();
  }, [pipelineId]);

  // Build the full availableViews list
  const settingsSection = schema?.sections?.find((s: any) => s.type === 'settings') || null;
  const availableViews: ViewDefinition[] = [
    ...discoveredViews,
    ...(settingsSection ? [{ id: 'settings', label: 'Settings', icon: '⚙️', type: 'builtin' as const, order: 999 }] : []),
  ];

  // Set default view to the first available view (by order) once views are loaded
  useEffect(() => {
    if (currentView === '' && availableViews.length > 0) {
      const sorted = [...availableViews].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      setCurrentView(sorted[0].id);
    }
  }, [availableViews, currentView]);

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
        availableViews={availableViews}
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
              ) : currentView === 'settings' ? (
                <SettingsView schema={schema} appState={appState} pipelineId={pipelineId} />
              ) : currentView !== '' ? (
                <DynamicViewBridge viewName={currentView} pipelineId={pipelineId} appState={appState} discoveredViews={discoveredViews} />
              ) : null}
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
 * ReactViewBridge — renders a React component from the __woodburyReactViewRegistry.
 * If the component isn't registered yet, tries loading its bundle from the server.
 */
function ReactViewBridge({ viewName, pipelineId }: {
  viewName: string;
  pipelineId: string;
}) {
  const [Component, setComponent] = useState<React.ComponentType | null>(null);
  const [loadingBundle, setLoadingBundle] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const registry = (window as any).__woodburyReactViewRegistry as Map<string, any> | undefined;
    if (registry && registry.has(viewName)) {
      setComponent(() => registry.get(viewName)!.component);
      return;
    }

    // Not in registry yet — try loading the bundle from the server
    setLoadingBundle(true);
    setError(null);

    const enc = encodeURIComponent;
    const scriptId = `react-view-bundle-${viewName}`;
    if (document.getElementById(scriptId)) {
      // Script already in DOM, check registry again after a tick
      setTimeout(() => {
        const reg = (window as any).__woodburyReactViewRegistry as Map<string, any> | undefined;
        if (reg && reg.has(viewName)) {
          setComponent(() => reg.get(viewName)!.component);
        } else {
          setError(`React view "${viewName}" did not register after bundle loaded.`);
        }
        setLoadingBundle(false);
      }, 100);
      return;
    }

    const script = document.createElement('script');
    script.id = scriptId;
    script.src = `/api/app/${enc(pipelineId)}/view-file/${enc(viewName)}/view.bundle.js`;
    script.onload = () => {
      // Give the bundle a tick to call registerReactView()
      setTimeout(() => {
        const reg = (window as any).__woodburyReactViewRegistry as Map<string, any> | undefined;
        if (reg && reg.has(viewName)) {
          setComponent(() => reg.get(viewName)!.component);
        } else {
          setError(`React view "${viewName}" did not register after bundle loaded.`);
        }
        setLoadingBundle(false);
      }, 100);
    };
    script.onerror = () => {
      setError(`Failed to load bundle for React view "${viewName}".`);
      setLoadingBundle(false);
    };
    document.body.appendChild(script);

    return () => {
      // Don't remove script — it may have registered the view
    };
  }, [viewName, pipelineId]);

  if (loadingBundle) {
    return (
      <div style={{ padding: 20, color: '#94a3b8', fontSize: 13 }}>
        Loading view "{viewName}"...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 20, color: '#f87171', fontSize: 13 }}>
        {error}
      </div>
    );
  }

  if (Component) {
    return <Component />;
  }

  return null;
}

/**
 * DynamicViewBridge — routes to the right bridge based on view type.
 * Checks if a view is a React view (in registry) or a vanilla view.
 */
function DynamicViewBridge({ viewName, pipelineId, appState, discoveredViews }: {
  viewName: string;
  pipelineId: string;
  appState?: any;
  discoveredViews?: ViewDefinition[];
}) {
  // Check if this is a React view — either already in registry, or discovered as type 'react'
  const registry = (window as any).__woodburyReactViewRegistry as Map<string, any> | undefined;
  const isReact = (registry && registry.has(viewName))
    || discoveredViews?.find(v => v.id === viewName)?.type === 'react';

  if (isReact) {
    return <ReactViewBridge viewName={viewName} pipelineId={pipelineId} />;
  }

  // Fall back to vanilla view bridge
  return <VanillaViewBridge viewName={viewName} pipelineId={pipelineId} appState={appState} />;
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
