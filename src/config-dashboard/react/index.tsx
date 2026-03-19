/**
 * React Dashboard Entry Point
 *
 * Mounts React components into the existing vanilla JS dashboard.
 * Exposes a global API that the vanilla JS can call to mount/unmount.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ScreenplayView } from './components/ScreenplayView';
import { loadPipeline, setState, getState } from './stores/pipeline-store';

let root: Root | null = null;
let mountEl: HTMLElement | null = null;

/**
 * Mount the React screenplay view into a container element.
 * Called from vanilla JS when the user switches to Screenplay view.
 */
function mountScreenplay(container: HTMLElement, pipelineId: string) {
  // Unmount any existing React root
  unmount();

  mountEl = container;
  container.innerHTML = '';
  root = createRoot(container);
  root.render(<ScreenplayView />);

  // Load pipeline data
  loadPipeline(pipelineId);
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
 * Update the active view without remounting.
 */
function setView(view: string) {
  setState({ activeView: view as any });
}

// Expose to vanilla JS via window
(window as any).WoodburyReact = {
  mountScreenplay,
  unmount,
  setView,
  loadPipeline,
  getState,
  setState,
};

console.log('[woodbury-react] React dashboard components loaded');
