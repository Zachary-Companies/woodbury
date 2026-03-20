/**
 * SaveLoadPanel — full-featured save snapshots, load previous saves, save to folder.
 */
import React, { useState, useCallback, useEffect } from 'react';
import { usePipeline } from '../stores/PipelineProvider';

interface SaveLoadPanelProps {
  pipelineId: string;
  onClose: () => void;
}

interface SaveItem {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  nodeCount: number;
  size: number;
}

export function SaveLoadPanel({ pipelineId, onClose }: SaveLoadPanelProps) {
  const pipeline = usePipeline();
  const [mode, setMode] = useState<'save' | 'load'>('save');
  const [saves, setSaves] = useState<SaveItem[]>([]);
  const [loadingSaves, setLoadingSaves] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveDesc, setSaveDesc] = useState('');
  const [status, setStatus] = useState<{ text: string; type: 'ok' | 'error' } | null>(null);
  const [busy, setBusy] = useState(false);

  // Fetch saves list
  const fetchSaves = useCallback(async () => {
    setLoadingSaves(true);
    try {
      const res = await fetch(`/api/app/${encodeURIComponent(pipelineId)}/saves`);
      const data = await res.json();
      setSaves(data.saves || []);
    } catch {}
    setLoadingSaves(false);
  }, [pipelineId]);

  useEffect(() => { fetchSaves(); }, [fetchSaves]);

  const handleSave = useCallback(async (customPath?: string) => {
    setBusy(true);
    setStatus(null);
    try {
      const body: any = {};
      if (saveName.trim()) body.name = saveName.trim();
      if (saveDesc.trim()) body.description = saveDesc.trim();
      if (customPath) body.path = customPath;

      const res = await fetch(`/api/app/${encodeURIComponent(pipelineId)}/saves`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setStatus({ text: `Saved${data.path ? ` to ${data.path}` : ''}`, type: 'ok' });
      setSaveName('');
      setSaveDesc('');
      fetchSaves();
    } catch (err: any) {
      setStatus({ text: err.message, type: 'error' });
    }
    setBusy(false);
  }, [pipelineId, saveName, saveDesc, fetchSaves]);

  const handleLoad = useCallback(async (saveId: string) => {
    if (!confirm('Load this save? Your current state will be replaced.')) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/app/${encodeURIComponent(pipelineId)}/saves/${encodeURIComponent(saveId)}/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Load failed');
      setStatus({ text: 'Loaded successfully', type: 'ok' });
      await pipeline.reload();
    } catch (err: any) {
      setStatus({ text: err.message, type: 'error' });
    }
    setBusy(false);
  }, [pipelineId, pipeline]);

  const handleDelete = useCallback(async (saveId: string) => {
    if (!confirm('Delete this save? This cannot be undone.')) return;
    try {
      await fetch(`/api/app/${encodeURIComponent(pipelineId)}/saves/${encodeURIComponent(saveId)}`, {
        method: 'DELETE',
      });
      fetchSaves();
    } catch {}
  }, [pipelineId, fetchSaves]);

  const handleSaveToFolder = useCallback(() => {
    // Use the vanilla JS folder picker if available
    if (typeof (window as any).openFolderPicker === 'function') {
      (window as any).openFolderPicker((path: string) => {
        handleSave(path);
      });
    } else {
      handleSave();
    }
  }, [handleSave]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-[500px] max-h-[70vh] bg-[#111827] border border-white/10 rounded-xl shadow-2xl overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Tabs */}
        <div className="flex border-b border-white/5">
          <button
            onClick={() => setMode('save')}
            className={`flex-1 px-4 py-2.5 text-xs font-medium transition-colors ${
              mode === 'save' ? 'text-indigo-300 border-b-2 border-indigo-500' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            💾 Save
          </button>
          <button
            onClick={() => setMode('load')}
            className={`flex-1 px-4 py-2.5 text-xs font-medium transition-colors ${
              mode === 'load' ? 'text-indigo-300 border-b-2 border-indigo-500' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            📂 Load
          </button>
          <button onClick={onClose} className="px-3 text-slate-600 hover:text-slate-400 text-lg">&times;</button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {mode === 'save' && (
            <div className="space-y-3">
              <input
                type="text"
                placeholder="Save name (e.g. 'Final draft')"
                value={saveName}
                onChange={e => setSaveName(e.target.value)}
                className="w-full px-3 py-2 rounded-md text-xs bg-white/[0.03] border border-white/5 text-slate-300 placeholder-slate-600 outline-none focus:border-indigo-500/30"
              />
              <input
                type="text"
                placeholder="Description (optional)"
                value={saveDesc}
                onChange={e => setSaveDesc(e.target.value)}
                className="w-full px-3 py-2 rounded-md text-xs bg-white/[0.03] border border-white/5 text-slate-300 placeholder-slate-600 outline-none focus:border-indigo-500/30"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => handleSave()}
                  disabled={busy}
                  className="px-4 py-2 rounded-md text-xs font-medium bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 disabled:opacity-50"
                >
                  {busy ? '⏳ Saving...' : '💾 Save Here'}
                </button>
                <button
                  onClick={handleSaveToFolder}
                  disabled={busy}
                  className="px-4 py-2 rounded-md text-xs font-medium bg-white/[0.03] text-slate-400 hover:text-white hover:bg-white/[0.06] border border-white/5 disabled:opacity-50"
                >
                  📁 Save to Folder...
                </button>
              </div>
            </div>
          )}

          {mode === 'load' && (
            <div className="space-y-2">
              {loadingSaves ? (
                <div className="text-xs text-slate-500 py-4 text-center">Loading saves...</div>
              ) : saves.length === 0 ? (
                <div className="text-xs text-slate-600 py-4 text-center">No saves yet. Click Save to create one.</div>
              ) : (
                saves.map(s => (
                  <div key={s.id} className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-slate-300">{s.name || s.id}</span>
                      <span className="text-[10px] text-slate-600">
                        {new Date(s.createdAt).toLocaleString()}
                      </span>
                    </div>
                    {s.description && (
                      <p className="text-[10px] text-slate-500 mb-1.5">{s.description}</p>
                    )}
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-slate-600">
                        {s.nodeCount} nodes &middot; {s.size > 1048576 ? `${(s.size / 1048576).toFixed(1)} MB` : `${Math.round(s.size / 1024)} KB`}
                      </span>
                      <div className="flex gap-1">
                        <button
                          onClick={() => handleLoad(s.id)}
                          disabled={busy}
                          className="px-2 py-0.5 rounded text-[10px] bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 disabled:opacity-50"
                        >
                          Load
                        </button>
                        <button
                          onClick={() => handleDelete(s.id)}
                          className="px-2 py-0.5 rounded text-[10px] text-red-400/60 hover:text-red-400 hover:bg-red-500/10"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Status */}
        {status && (
          <div className={`px-4 py-2 text-xs border-t border-white/5 ${
            status.type === 'ok' ? 'text-emerald-400' : 'text-red-400'
          }`}>
            {status.type === 'ok' ? '✓' : '✗'} {status.text}
          </div>
        )}
      </div>
    </div>
  );
}
