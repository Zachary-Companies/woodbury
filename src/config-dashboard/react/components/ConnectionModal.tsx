/**
 * ConnectionModal — create bindings between selected entities.
 */
import React, { useState, useCallback, useMemo } from 'react';

interface EntitySelection {
  entityType: string;
  entityId: string;
  label: string;
}

interface ConnectionModalProps {
  selections: EntitySelection[];
  pipelineId: string;
  onClose: () => void;
  onCreated: () => void;
}

const CONNECTION_TYPES = [
  { value: 'depicts', label: 'Depicts (character in shot)' },
  { value: 'set-in', label: 'Set In (shot in location)' },
  { value: 'voice', label: 'Voice (dialogue by character)' },
  { value: 'references', label: 'References (generic)' },
  { value: 'related-to', label: 'Related To' },
];

export function ConnectionModal({ selections: initialSelections, pipelineId, onClose, onCreated }: ConnectionModalProps) {
  const [selections, setSelections] = useState(initialSelections);
  const [connectionType, setConnectionType] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);

  // Auto-detect best connection types
  const detectedTypes = useMemo(() => {
    const types: { value: string; label: string }[] = [];
    const entityTypes = new Set(selections.map(s => s.entityType));
    if (entityTypes.has('shot') && entityTypes.has('character')) types.push({ value: 'depicts', label: 'Depicts' });
    if (entityTypes.has('shot') && entityTypes.has('location')) types.push({ value: 'set-in', label: 'Set In' });
    if (entityTypes.has('character') && selections.filter(s => s.entityType === 'character').length >= 2) {
      types.push({ value: 'related-to', label: 'Related' });
    }
    if (types.length === 0) types.push({ value: 'references', label: 'References' });
    return types;
  }, [selections]);

  // Default to first detected
  const activeType = connectionType || detectedTypes[0]?.value || 'references';

  const handleSwap = useCallback(() => {
    setSelections(prev => [...prev].reverse());
  }, []);

  const handleCreate = useCallback(async () => {
    if (selections.length < 2) return;
    setCreating(true);
    try {
      const source = selections[0];
      for (let i = 1; i < selections.length; i++) {
        const target = selections[i];
        await fetch(`/api/app/${encodeURIComponent(pipelineId)}/bindings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            binding: {
              type: activeType,
              source: { entityType: source.entityType, entityId: source.entityId },
              target: { entityType: target.entityType, entityId: target.entityId },
              confidence: 1.0,
              origin: 'manual',
              metadata: description ? { description } : undefined,
            },
          }),
        });
      }
      onCreated();
      onClose();
    } catch {}
    setCreating(false);
  }, [selections, activeType, description, pipelineId, onClose, onCreated]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-[460px] bg-[#1a1f2e] border border-white/10 rounded-xl shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
          <h3 className="text-sm font-semibold text-white">Create Connection</h3>
          <button onClick={onClose} className="text-slate-600 hover:text-slate-400 text-lg">&times;</button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Selected entities */}
          <div className="flex items-center gap-2 flex-wrap">
            {selections.map((sel, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span className="text-slate-600">&rarr;</span>}
                <div className="px-2.5 py-1 rounded-md bg-white/5 border border-white/5">
                  <div className="text-[9px] text-slate-600 uppercase">{sel.entityType}</div>
                  <div className="text-xs text-slate-300">{sel.label}</div>
                </div>
              </React.Fragment>
            ))}
          </div>

          {/* Connection type */}
          <div>
            <label className="block text-[10px] text-slate-500 mb-1">Connection Type</label>
            <select
              value={activeType}
              onChange={e => setConnectionType(e.target.value)}
              className="w-full px-3 py-2 rounded-md text-xs bg-[#0f172a] border border-white/10 text-slate-300 outline-none"
            >
              {detectedTypes.map(t => (
                <option key={t.value} value={t.value}>{t.label} (detected)</option>
              ))}
              {CONNECTION_TYPES.filter(t => !detectedTypes.some(d => d.value === t.value)).map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          {/* Description */}
          <div>
            <label className="block text-[10px] text-slate-500 mb-1">Description (optional)</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={2}
              placeholder="Describe the connection..."
              className="w-full px-3 py-2 rounded-md text-xs bg-[#0f172a] border border-white/10 text-slate-300 resize-none outline-none focus:border-indigo-500/30"
            />
          </div>

          {/* Direction */}
          {selections.length === 2 && (
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span>Direction: <strong className="text-slate-300">{selections[0].label}</strong> &rarr; <strong className="text-slate-300">{selections[1].label}</strong></span>
              <button onClick={handleSwap} className="text-indigo-400 hover:text-indigo-300 text-[10px]">⇄ Swap</button>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-white/5">
          <button onClick={onClose} className="px-4 py-1.5 rounded-md text-xs text-slate-400 hover:text-white">Cancel</button>
          <button
            onClick={handleCreate}
            disabled={creating || selections.length < 2}
            className="px-4 py-1.5 rounded-md text-xs font-medium bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 disabled:opacity-50"
          >
            {creating ? 'Creating...' : 'Create Connections'}
          </button>
        </div>
      </div>
    </div>
  );
}
