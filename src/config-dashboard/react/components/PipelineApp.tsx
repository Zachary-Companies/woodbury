/**
 * PipelineApp — the main React shell for pipeline app mode.
 * Manages view switching between Screenplay, Data, Editor, Script, Voices.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { usePipelineStore, loadPipeline, clearProject, setState } from '../stores/pipeline-store';
import { ScreenplayView } from './ScreenplayView';
import { DataView } from './DataView';
import { ImportModal } from './ImportModal';

type ViewMode = 'screenplay' | 'data' | 'editor' | 'script' | 'voices';

const VIEW_TABS: Array<{ id: ViewMode; label: string; icon: string }> = [
  { id: 'data', label: 'Data', icon: '📊' },
  { id: 'screenplay', label: 'Screenplay', icon: '📜' },
  { id: 'editor', label: 'Editor', icon: '🎬' },
  { id: 'script', label: 'Script', icon: '✏️' },
  { id: 'voices', label: 'Voices', icon: '🎙' },
];

export function PipelineApp({ pipelineId }: { pipelineId: string }) {
  const { projectData, pipelineName, loading, activeView, projectFolder } = usePipelineStore();
  const [showImport, setShowImport] = useState(false);
  const [currentView, setCurrentView] = useState<ViewMode>('screenplay');

  useEffect(() => {
    loadPipeline(pipelineId);
  }, [pipelineId]);

  const handleViewChange = useCallback((view: ViewMode) => {
    setCurrentView(view);
    setState({ activeView: view });
  }, []);

  const handleNewProject = useCallback(async () => {
    if (projectData && projectData.elements?.length > 0) {
      if (!confirm('This will clear all current project data. Continue?')) return;
    }
    await clearProject();
    await loadPipeline(pipelineId);
  }, [pipelineId, projectData]);

  const title = projectData?.metadata?.title || pipelineName || 'Pipeline';
  const charCount = projectData?.characters?.length || 0;
  const sceneCount = usePipelineStore(s => {
    let count = 0;
    function countScenes(secs: any[]) {
      for (const s of secs) {
        if (s.type === 'scene') count++;
        if (s.children) countScenes(s.children);
      }
    }
    countScenes(s.projectData?.sections || []);
    return count;
  });
  const elementCount = projectData?.elements?.length || 0;

  return (
    <div className="flex flex-col h-full bg-[#0f172a] overflow-hidden">
      {/* Top bar */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-2 border-b border-white/5 bg-[#111827]/80">
        <div>
          <h1 className="text-base font-bold text-white">{title}</h1>
          <div className="flex gap-3 text-[10px] text-slate-500 mt-0.5">
            {sceneCount > 0 && <span>{sceneCount} scenes</span>}
            {elementCount > 0 && <span>{elementCount} elements</span>}
            {charCount > 0 && <span>{charCount} characters</span>}
            {projectFolder && <span className="text-indigo-400/50">📁 {projectFolder.split('/').pop()}</span>}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowImport(true)}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-teal-500/10 border border-teal-500/20 text-teal-300 hover:bg-teal-500/20 transition-colors"
          >
            📄 Import Script
          </button>
          <button
            onClick={handleNewProject}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-white/[0.03] border border-white/8 text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors"
          >
            ✨ New Project
          </button>
        </div>
      </div>

      {/* View tabs */}
      <div className="flex-shrink-0 flex items-center gap-1 px-4 py-1.5 bg-[#0c1222] border-b border-white/5">
        {VIEW_TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => handleViewChange(tab.id)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              currentView === tab.id
                ? 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/25'
                : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.03]'
            }`}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      {/* View content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-sm gap-2">
            <span className="animate-pulse">●</span> Loading...
          </div>
        ) : (
          <>
            {currentView === 'screenplay' && <ScreenplayView />}
            {currentView === 'data' && <DataView />}
            {currentView === 'editor' && <PlaceholderView label="Editor" description="The NLE timeline editor will be converted to React in a future update." />}
            {currentView === 'script' && <PlaceholderView label="Script Editor" description="The Monaco-based Fountain editor will be converted to React in a future update." />}
            {currentView === 'voices' && <PlaceholderView label="Voices" description="Voice assignment and TTS settings will be converted to React in a future update." />}
          </>
        )}
      </div>

      {/* Import modal */}
      {showImport && <ImportModal onClose={() => setShowImport(false)} />}
    </div>
  );
}

function PlaceholderView({ label, description }: { label: string; description: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-slate-500 gap-3">
      <h2 className="text-lg font-semibold text-slate-400">{label}</h2>
      <p className="text-sm max-w-md text-center">{description}</p>
      <p className="text-xs text-slate-600">Use the vanilla JS version from the sidebar views in the meantime.</p>
    </div>
  );
}
