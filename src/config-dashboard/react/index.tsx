/**
 * React Dashboard Entry Point
 *
 * Mounts React components into the existing vanilla JS dashboard.
 * Exposes a global API that the vanilla JS can call to mount/unmount.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PipelineApp } from './components/PipelineApp';
import { ScreenplayView } from './components/ScreenplayView';
import { DataView } from './components/DataView';
import { ImportModal } from './components/ImportModal';
import { loadPipeline, setState, getState } from './stores/pipeline-store';

let root: Root | null = null;
let mountEl: HTMLElement | null = null;

/**
 * Mount the full React pipeline app into a container element.
 */
function mountPipelineApp(container: HTMLElement, pipelineId: string) {
  unmount();
  mountEl = container;
  container.innerHTML = '';
  container.style.height = '100%';
  root = createRoot(container);
  root.render(<PipelineApp pipelineId={pipelineId} />);
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

// Expose to vanilla JS
(window as any).WoodburyReact = {
  mountPipelineApp,
  mountScreenplay,
  mountDataView,
  showImportModal,
  unmount,
  loadPipeline,
  getState,
  setState,
};

console.log('[woodbury-react] React dashboard loaded ✓');
