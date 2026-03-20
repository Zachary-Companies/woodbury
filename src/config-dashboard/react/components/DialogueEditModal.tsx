/**
 * DialogueEditModal — edit a dialogue element's character, modifiers, and lines.
 */
import React, { useState, useCallback } from 'react';

interface DialogueElement {
  id: string;
  characterName: string;
  characterId?: string;
  modifiers: string[];
  lines: string[];
}

interface DialogueEditModalProps {
  element: DialogueElement;
  pipelineId: string;
  onClose: () => void;
  onSaved: () => void;
}

const COMMON_MODIFIERS = ['V.O.', 'O.S.', 'O.C.', "CONT'D", 'PRE-LAP', 'FILTERED', 'INTO PHONE'];

function charColor(name: string): string {
  const colors = ['#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#d19a66'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return colors[Math.abs(hash) % colors.length];
}

export function DialogueEditModal({ element, pipelineId, onClose, onSaved }: DialogueEditModalProps) {
  const [characterName, setCharacterName] = useState(element.characterName || '');
  const [modifiers, setModifiers] = useState<string[]>(element.modifiers || []);
  const [lines, setLines] = useState<string[]>(element.lines?.length ? [...element.lines] : ['']);
  const [saving, setSaving] = useState(false);

  const color = charColor(element.characterName || 'UNKNOWN');

  const toggleModifier = useCallback((mod: string) => {
    setModifiers(prev =>
      prev.includes(mod) ? prev.filter(m => m !== mod) : [...prev, mod]
    );
  }, []);

  const updateLine = useCallback((index: number, value: string) => {
    setLines(prev => prev.map((l, i) => i === index ? value : l));
  }, []);

  const addLine = useCallback(() => {
    setLines(prev => [...prev, '']);
  }, []);

  const removeLine = useCallback((index: number) => {
    setLines(prev => prev.filter((_, i) => i !== index));
  }, []);

  const handleSave = useCallback(async () => {
    const newName = characterName.trim().toUpperCase();
    const newLines = lines.map(l => l.trim()).filter(Boolean);
    if (newLines.length === 0) newLines.push('');

    // Collect changes
    const updates: { field: string; value: any }[] = [];
    if (newName !== element.characterName) updates.push({ field: 'characterName', value: newName });
    if (JSON.stringify(modifiers) !== JSON.stringify(element.modifiers || [])) updates.push({ field: 'modifiers', value: modifiers });
    if (JSON.stringify(newLines) !== JSON.stringify(element.lines || [])) updates.push({ field: 'lines', value: newLines });

    if (updates.length === 0) {
      onClose();
      return;
    }

    setSaving(true);
    try {
      for (const update of updates) {
        const res = await fetch(`/api/app/${encodeURIComponent(pipelineId)}/element/${encodeURIComponent(element.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field: update.field, value: update.value, elementType: 'dialogue' }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || `Failed to save ${update.field}`);
        }
      }
      onSaved();
      onClose();
    } catch {}
    setSaving(false);
  }, [characterName, modifiers, lines, element, pipelineId, onClose, onSaved]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-[520px] max-h-[80vh] bg-[#1a1f2e] border border-white/10 rounded-xl shadow-2xl overflow-y-auto" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-3 border-b border-white/5">
          <h3 className="text-sm font-semibold text-white" style={{ borderLeft: `4px solid ${color}`, paddingLeft: 12 }}>
            Edit Dialogue
          </h3>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Character name */}
          <div>
            <label className="block text-[10px] text-slate-500 mb-1">Character Name</label>
            <input
              type="text"
              value={characterName}
              onChange={e => setCharacterName(e.target.value)}
              placeholder="CHARACTER NAME"
              className="w-full px-3 py-2 rounded-md text-xs bg-[#0f172a] border border-white/10 text-slate-300 uppercase outline-none focus:border-indigo-500/30"
            />
          </div>

          {/* Modifiers */}
          <div>
            <label className="block text-[10px] text-slate-500 mb-1">
              Modifiers <span className="text-slate-600">(V.O., O.S., etc.)</span>
            </label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {COMMON_MODIFIERS.map(mod => (
                <button
                  key={mod}
                  onClick={() => toggleModifier(mod)}
                  className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                    modifiers.includes(mod)
                      ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
                      : 'bg-white/5 text-slate-500 border border-white/5 hover:text-slate-300'
                  }`}
                >
                  {mod}
                </button>
              ))}
            </div>
          </div>

          {/* Lines */}
          <div>
            <label className="block text-[10px] text-slate-500 mb-1">Dialogue Lines</label>
            <div className="space-y-1.5">
              {lines.map((line, i) => (
                <div key={i} className="flex gap-1.5">
                  <textarea
                    value={line}
                    onChange={e => updateLine(i, e.target.value)}
                    rows={2}
                    placeholder="Enter dialogue..."
                    className="flex-1 px-3 py-2 rounded-md text-xs bg-[#0f172a] border border-white/10 text-slate-300 resize-none outline-none focus:border-indigo-500/30"
                  />
                  {lines.length > 1 && (
                    <button
                      onClick={() => removeLine(i)}
                      className="text-slate-600 hover:text-red-400 text-sm px-1"
                    >
                      &times;
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button onClick={addLine} className="mt-1.5 text-[10px] text-indigo-400 hover:text-indigo-300">
              + Add Line
            </button>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-white/5">
          <button onClick={onClose} className="px-4 py-1.5 rounded-md text-xs text-slate-400 hover:text-white">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 rounded-md text-xs font-medium bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
