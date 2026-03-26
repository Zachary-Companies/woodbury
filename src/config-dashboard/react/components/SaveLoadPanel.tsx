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

  const s = {
    overlay: { position: 'fixed' as const, inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' },
    panel: { width: 520, maxHeight: '70vh', background: '#0f172a', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, boxShadow: '0 25px 60px rgba(0,0,0,0.5)', overflow: 'hidden' as const, display: 'flex', flexDirection: 'column' as const, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', colorScheme: 'dark' as any },
    tabRow: { display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.06)' },
    tab: (active: boolean) => ({ flex: 1, padding: '12px 16px', fontSize: 13, fontWeight: 500, background: 'none', border: 'none', borderBottom: active ? '2px solid #818cf8' : '2px solid transparent', color: active ? '#a5b4fc' : '#64748b', cursor: 'pointer', transition: 'color 0.15s' }),
    closeBtn: { padding: '8px 14px', background: 'none', border: 'none', color: '#475569', fontSize: 18, cursor: 'pointer', lineHeight: 1 },
    content: { flex: 1, overflowY: 'auto' as const, padding: 20 },
    input: { width: '100%', padding: '10px 14px', borderRadius: 8, fontSize: 13, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#e2e8f0', outline: 'none', marginBottom: 10, boxSizing: 'border-box' as const },
    btnPrimary: { padding: '10px 20px', borderRadius: 8, fontSize: 12, fontWeight: 600, background: 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.3)', color: '#a5b4fc', cursor: 'pointer', transition: 'background 0.15s' },
    btnSecondary: { padding: '10px 20px', borderRadius: 8, fontSize: 12, fontWeight: 500, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#94a3b8', cursor: 'pointer', transition: 'background 0.15s' },
    btnLoad: { padding: '6px 12px', borderRadius: 6, fontSize: 11, fontWeight: 500, background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.25)', color: '#a5b4fc', cursor: 'pointer' },
    btnDelete: { padding: '6px 12px', borderRadius: 6, fontSize: 11, fontWeight: 500, background: 'none', border: '1px solid rgba(239,68,68,0.15)', color: 'rgba(248,113,113,0.6)', cursor: 'pointer' },
    saveItem: { borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.02)', padding: 14, marginBottom: 8 },
    statusBar: (ok: boolean) => ({ padding: '10px 20px', fontSize: 12, borderTop: '1px solid rgba(255,255,255,0.06)', color: ok ? '#34d399' : '#f87171' }),
    empty: { fontSize: 12, color: '#475569', padding: '32px 0', textAlign: 'center' as const },
  };

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.panel} onClick={e => e.stopPropagation()}>
        {/* Tabs */}
        <div style={s.tabRow}>
          <button style={s.tab(mode === 'save')} onClick={() => setMode('save')}>💾 Save</button>
          <button style={s.tab(mode === 'load')} onClick={() => setMode('load')}>📂 Load</button>
          <button style={s.closeBtn} onClick={onClose}>&times;</button>
        </div>

        {/* Content */}
        <div style={s.content}>
          {mode === 'save' && (
            <div>
              <input
                type="text"
                placeholder="Save name (e.g. 'Final draft')"
                value={saveName}
                onChange={e => setSaveName(e.target.value)}
                style={s.input}
              />
              <input
                type="text"
                placeholder="Description (optional)"
                value={saveDesc}
                onChange={e => setSaveDesc(e.target.value)}
                style={s.input}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <button
                  onClick={() => handleSave()}
                  disabled={busy}
                  style={{ ...s.btnPrimary, opacity: busy ? 0.5 : 1 }}
                >
                  {busy ? '⏳ Saving...' : '💾 Save Here'}
                </button>
                <button
                  onClick={handleSaveToFolder}
                  disabled={busy}
                  style={{ ...s.btnSecondary, opacity: busy ? 0.5 : 1 }}
                >
                  📁 Save to Folder...
                </button>
              </div>
            </div>
          )}

          {mode === 'load' && (
            <div>
              {loadingSaves ? (
                <div style={s.empty}>Loading saves...</div>
              ) : saves.length === 0 ? (
                <div style={s.empty}>No saves yet. Click Save to create one.</div>
              ) : (
                saves.map(item => (
                  <div key={item.id} style={s.saveItem}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ fontSize: 13, fontWeight: 500, color: '#e2e8f0' }}>{item.name || item.id}</span>
                      <span style={{ fontSize: 10, color: '#475569' }}>
                        {new Date(item.createdAt).toLocaleString()}
                      </span>
                    </div>
                    {item.description && (
                      <p style={{ fontSize: 11, color: '#64748b', margin: '0 0 6px' }}>{item.description}</p>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 10, color: '#475569' }}>
                        {item.nodeCount} nodes &middot; {item.size > 1048576 ? `${(item.size / 1048576).toFixed(1)} MB` : `${Math.round(item.size / 1024)} KB`}
                      </span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          onClick={() => handleLoad(item.id)}
                          disabled={busy}
                          style={{ ...s.btnLoad, opacity: busy ? 0.5 : 1 }}
                        >
                          Load
                        </button>
                        <button
                          onClick={() => handleDelete(item.id)}
                          style={s.btnDelete}
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
          <div style={s.statusBar(status.type === 'ok')}>
            {status.type === 'ok' ? '✓' : '✗'} {status.text}
          </div>
        )}
      </div>
    </div>
  );
}
