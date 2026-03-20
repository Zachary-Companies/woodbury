/**
 * React Dashboard Entry Point
 *
 * Mounts React components into the existing vanilla JS dashboard.
 * Exposes a global API that the vanilla JS can call to mount/unmount.
 * Also provides renderCompositionAppPage() to replace compositions-app.js.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PipelineApp } from './components/PipelineApp';
import { ScreenplayView } from './components/ScreenplayView';
import { DataView } from './components/DataView';
import { ImportModal } from './components/ImportModal';
import { ImportScriptModal } from './components/ImportScriptModal';
import { loadPipeline, setState, getState } from './stores/pipeline-store';
import { fetchAppSchema, fetchAppState, fetchAppBindings, loadPipelineCustomViews } from './api/appApi';

let root: Root | null = null;
let mountEl: HTMLElement | null = null;

// ── Custom view state (migrated from compositions-app.js) ──
let customViewsLoaded = false;
let customViewsPipelineId: string | null = null;

/**
 * Mount the full React pipeline app into a container element.
 */
function mountPipelineApp(container: HTMLElement, pipelineId: string, schema?: any, appState?: any) {
  unmount();
  mountEl = container;
  container.innerHTML = '';
  container.style.height = '100%';
  root = createRoot(container);
  root.render(<PipelineApp pipelineId={pipelineId} schema={schema} appState={appState} />);
}

/**
 * Mount just the React screenplay view into a container element.
 */
function mountScreenplay(container: HTMLElement, pipelineId: string) {
  unmount();
  mountEl = container;
  container.innerHTML = '';
  root = createRoot(container);
  root.render(<ScreenplayView />);
  loadPipeline(pipelineId);
}

/**
 * Mount the data view.
 */
function mountDataView(container: HTMLElement, pipelineId: string) {
  unmount();
  mountEl = container;
  container.innerHTML = '';
  root = createRoot(container);
  root.render(<DataView />);
  loadPipeline(pipelineId);
}

/**
 * Show the import modal (appended to document.body).
 */
function showImportModal(pipelineId: string) {
  const overlay = document.createElement('div');
  overlay.id = 'react-import-overlay';
  document.body.appendChild(overlay);
  const importRoot = createRoot(overlay);

  const handleClose = () => {
    importRoot.unmount();
    overlay.remove();
  };

  if (getState().pipelineId !== pipelineId) {
    loadPipeline(pipelineId);
  }

  importRoot.render(<ImportModal onClose={handleClose} />);
}

/**
 * Show the full import script modal (Fountain parser).
 * Called from compositions-execution.js import button.
 */
function showImportScriptModal(pipelineId: string) {
  const existing = document.getElementById('react-import-script-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'react-import-script-overlay';
  document.body.appendChild(overlay);
  const importRoot = createRoot(overlay);

  const handleClose = () => {
    importRoot.unmount();
    overlay.remove();
  };

  importRoot.render(<ImportScriptModal pipelineId={pipelineId} onClose={handleClose} />);
}

/**
 * Unmount the React root and clean up.
 */
function unmount() {
  if (root) {
    root.unmount();
    root = null;
  }
  if (mountEl) {
    mountEl.innerHTML = '';
    mountEl = null;
  }
}

/**
 * renderCompositionAppPage — replaces the function from compositions-app.js.
 * Called by selectComposition() in compositions-core.js when compView === 'app'.
 *
 * Fetches schema/state/bindings, loads custom views, then mounts React.
 */
async function renderCompositionAppPage() {
  const compData = (window as any).compData;
  if (!compData) return;

  const main = document.querySelector('#main') as HTMLElement;
  if (!main) return;

  // Restore .app-content styles if a previous view overrode them
  const appContent = main.closest('.app-content') || document.querySelector('.app-content');
  if (appContent && appContent.getAttribute('data-ed-override') === 'true') {
    (appContent as HTMLElement).style.padding = '';
    (appContent as HTMLElement).style.overflow = '';
    appContent.removeAttribute('data-ed-override');
  }

  // Show loading state
  main.innerHTML = '<div class="app-loading"><div class="spinner"></div> Loading app...</div>';

  // Fetch schema, state, and bindings in parallel
  const [schema, appState, bindings] = await Promise.all([
    fetchAppSchema(compData.id),
    fetchAppState(compData.id),
    fetchAppBindings(compData.id),
  ]);

  // Load pipeline-local custom views (once per pipeline)
  if (!customViewsLoaded || customViewsPipelineId !== compData.id) {
    customViewsLoaded = true;
    customViewsPipelineId = compData.id;
    document.querySelectorAll('[id^="pipeline-view-js-"], [id^="pipeline-view-css-"]').forEach(el => el.remove());
    try { await loadPipelineCustomViews(compData.id); } catch {}
  }

  if (!schema) {
    main.innerHTML = '<div class="app-error">Failed to load pipeline schema.</div>';
    return;
  }

  const state = appState || {
    pipelineId: compData.id,
    pipelineName: compData.name || 'Untitled',
    sourceRunId: null,
    nodeData: {},
    staleNodes: [],
    lastRunAt: null,
  };

  // Mount React
  main.innerHTML = '<div id="react-pipeline-root" style="height:100%;"></div>';
  const reactRoot = document.getElementById('react-pipeline-root');
  if (reactRoot) {
    mountPipelineApp(reactRoot, compData.id, schema, state);
  }
}

// ── Custom view registration API (migrated from compositions-app.js) ──
// Pipeline-local views call window.registerPipelineView() from their view.js
(window as any).registerPipelineView = function(viewDef: any) {
  if (!viewDef || !viewDef.name) return;
  // Store in a global array that React's VanillaViewBridge can access
  const views = (window as any)._pipelineCustomViews || [];
  const existing = views.findIndex((v: any) => v.name === viewDef.name);
  const entry = {
    name: viewDef.name,
    label: viewDef.label || viewDef.name,
    icon: viewDef.icon || '',
    loaded: true,
    detect: viewDef.detect || (() => true),
    stitch: viewDef.stitch || ((s: any) => s),
    render: viewDef.render || (() => '<div>Custom view</div>'),
    wireEvents: viewDef.wireEvents || (() => {}),
  };
  if (existing !== -1) {
    views[existing] = entry;
  } else {
    views.push(entry);
  }
  (window as any)._pipelineCustomViews = views;
};

// Expose to vanilla JS
(window as any).WoodburyReact = {
  mountPipelineApp,
  mountScreenplay,
  mountDataView,
  showImportModal,
  showImportScriptModal,
  unmount,
  loadPipeline,
  getState,
  setState,
};

// Replace the global renderCompositionAppPage
(window as any).renderCompositionAppPage = renderCompositionAppPage;

// Also expose showImportScriptModal globally for compositions-execution.js
(window as any).showImportScriptModal = function() {
  const compData = (window as any).compData;
  if (compData?.id) showImportScriptModal(compData.id);
};

// Expose API helpers as globals for pipeline-local views (screenplay-crud.js, etc.)
// These were previously in compositions-app.js
(window as any).saveAppNodeState = async function(pipelineId: string, nodeId: string, outputs: any) {
  const res = await fetch(`/api/app/${encodeURIComponent(pipelineId)}/state/${encodeURIComponent(nodeId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outputs }),
  });
  if (!res.ok) throw new Error('Failed to save');
  return res.json();
};
(window as any).fetchAppNodeData = async function(pipelineId: string, nodeId: string) {
  const res = await fetch(`/api/app/${encodeURIComponent(pipelineId)}/node/${encodeURIComponent(nodeId)}`);
  if (!res.ok) return null;
  return res.json();
};
(window as any).fetchAppState = async function(pipelineId: string) {
  const res = await fetch(`/api/app/${encodeURIComponent(pipelineId)}/state`);
  if (!res.ok) return null;
  return res.json();
};
(window as any).fetchAppSchema = async function(pipelineId: string) {
  const res = await fetch(`/api/app/${encodeURIComponent(pipelineId)}/schema`);
  if (!res.ok) return null;
  return res.json();
};
(window as any).fetchAppBindings = async function(pipelineId: string) {
  try {
    const res = await fetch(`/api/app/${encodeURIComponent(pipelineId)}/bindings`);
    if (!res.ok) return { version: '1.0', pipelineId, bindings: [] };
    return res.json();
  } catch { return { version: '1.0', pipelineId, bindings: [] }; }
};
(window as any).createAppBinding = async function(pipelineId: string, binding: any) {
  const res = await fetch(`/api/compositions/${encodeURIComponent(pipelineId)}/bindings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(binding),
  });
  if (!res.ok) throw new Error('Failed to create binding');
  return res.json();
};
(window as any).deleteAppBinding = async function(pipelineId: string, bindingId: string) {
  const res = await fetch(`/api/compositions/${encodeURIComponent(pipelineId)}/bindings/${encodeURIComponent(bindingId)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete binding');
  return res.json();
};
(window as any).openFolderPicker = function(onSelect: any) {
  if ((window as any).woodburyElectron?.selectFolder) {
    (window as any).woodburyElectron.selectFolder().then((folder: string) => { if (folder) onSelect(folder); });
  }
};

// Expose appState/appSchema as globals for pipeline-local views that read them
// Updated whenever renderCompositionAppPage runs
(window as any).appState = null;
(window as any).appSchema = null;
const _origRender = renderCompositionAppPage;
async function renderCompositionAppPageWithGlobals() {
  await _origRender();
  // After mounting React, update the global vars for pipeline-local views
  const compData = (window as any).compData;
  if (compData?.id) {
    try {
      (window as any).appState = await (await fetch(`/api/app/${encodeURIComponent(compData.id)}/state`)).json();
      (window as any).appSchema = await (await fetch(`/api/app/${encodeURIComponent(compData.id)}/schema`)).json();
    } catch {}
  }
}
(window as any).renderCompositionAppPage = renderCompositionAppPageWithGlobals;
