/**
 * NewProjectDialog — confirmation dialog when starting a new project with existing data.
 */
import React, { useState, useCallback } from 'react';
import { usePipeline } from '../stores/PipelineProvider';

interface NewProjectDialogProps {
  pipelineId: string;
  onClose: () => void;
}

export function NewProjectDialog({ pipelineId, onClose }: NewProjectDialogProps) {
  const pipeline = usePipeline();
  const [busy, setBusy] = useState(false);

  const handleDiscard = useCallback(async () => {
    setBusy(true);
    try {
      await fetch(`/api/app/${encodeURIComponent(pipelineId)}/state`, { method: 'DELETE' });
      await pipeline.clearProject();
      // Navigate to form
      if (typeof (window as any).updateHash === 'function') {
        (window as any).updateHash('compositions', pipelineId, 'form');
      }
      if (typeof (window as any).selectComposition === 'function') {
        (window as any).selectComposition(pipelineId, 'form');
      }
      onClose();
    } catch {}
    setBusy(false);
  }, [pipelineId, pipeline, onClose]);

  const handleSaveAndNew = useCallback(async () => {
    setBusy(true);
    try {
      const saveName = 'auto-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      await fetch(`/api/app/${encodeURIComponent(pipelineId)}/saves`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: saveName, description: 'Auto-save before New Project' }),
      });
      await fetch(`/api/app/${encodeURIComponent(pipelineId)}/state`, { method: 'DELETE' });
      await pipeline.clearProject();
      if (typeof (window as any).updateHash === 'function') {
        (window as any).updateHash('compositions', pipelineId, 'form');
      }
      if (typeof (window as any).selectComposition === 'function') {
        (window as any).selectComposition(pipelineId, 'form');
      }
      onClose();
    } catch {}
    setBusy(false);
  }, [pipelineId, pipeline, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-[400px] bg-[#1a1f2e] border border-white/10 rounded-xl shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
          <h3 className="text-sm font-semibold text-white">Start New Project</h3>
          <button onClick={onClose} className="text-slate-600 hover:text-slate-400 text-lg">&times;</button>
        </div>
        <div className="px-5 py-4">
          <p className="text-xs text-slate-400">You have existing project data. What would you like to do?</p>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-white/5">
          <button onClick={onClose} disabled={busy} className="px-4 py-1.5 rounded-md text-xs text-slate-400 hover:text-white disabled:opacity-50">
            Cancel
          </button>
          <button
            onClick={handleDiscard}
            disabled={busy}
            className="px-4 py-1.5 rounded-md text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 disabled:opacity-50"
          >
            {busy ? '...' : 'Discard & Start New'}
          </button>
          <button
            onClick={handleSaveAndNew}
            disabled={busy}
            className="px-4 py-1.5 rounded-md text-xs font-medium bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 disabled:opacity-50"
          >
            {busy ? '...' : 'Save & Start New'}
          </button>
        </div>
      </div>
    </div>
  );
}
