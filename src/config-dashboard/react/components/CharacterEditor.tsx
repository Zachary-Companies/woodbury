/**
 * CharacterEditor — modal for editing a character's full details.
 */
import React, { useState, useCallback } from 'react';
import { saveProjectData, usePipelineStore, type Character } from '../stores/pipeline-store';

export function CharacterEditor({ character, onClose }: { character: Character; onClose: () => void }) {
  const { projectData } = usePipelineStore();
  const [form, setForm] = useState<Character>({ ...character });
  const [saving, setSaving] = useState(false);

  const update = (field: keyof Character, value: any) => {
    setForm(prev => ({ ...prev, [field]: value }));
  };

  const handleSave = useCallback(async () => {
    if (!projectData) return;
    setSaving(true);
    const updated = projectData.characters.map(c => c.id === form.id ? form : c);
    await saveProjectData({ characters: updated });
    setSaving(false);
    onClose();
  }, [form, projectData, onClose]);

  return (
    <div className="fixed inset-0 bg-black/60 z-[10001] flex items-center justify-center backdrop-blur-sm" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-[#1a1f2e] border border-white/8 rounded-xl w-[600px] max-w-[90vw] max-h-[85vh] shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
          <h3 className="text-sm font-semibold text-white">Edit Character: {character.name}</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-white text-lg">&times;</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 min-h-0">
          <div className="flex gap-4">
            {/* Image */}
            <div className="flex-shrink-0">
              {form.imagePath ? (
                <img src={`/api/file?path=${encodeURIComponent(form.imagePath)}`} className="w-24 h-32 rounded-lg object-cover border border-white/10" alt="" />
              ) : (
                <div className="w-24 h-32 rounded-lg bg-white/[0.03] border border-white/5 flex items-center justify-center text-3xl">👤</div>
              )}
            </div>

            {/* Basic fields */}
            <div className="flex-1 space-y-2">
              <Field label="Name" value={form.name} onChange={v => update('name', v)} />
              <Field label="Display Name" value={form.displayName || ''} onChange={v => update('displayName', v)} />
              <div className="flex gap-2">
                <Field label="Age Range" value={form.ageRange || ''} onChange={v => update('ageRange', v)} className="flex-1" />
                <SelectField label="Gender" value={form.gender || ''} options={['', 'Male', 'Female', 'Non-binary']} onChange={v => update('gender', v)} className="flex-1" />
                <SelectField label="Role" value={form.role || ''} options={['', 'main', 'supporting', 'minor']} onChange={v => update('role', v)} className="flex-1" />
              </div>
            </div>
          </div>

          <TextArea label="Description" value={form.description || ''} onChange={v => update('description', v)} rows={3} />
          <TextArea label="Character Arc" value={form.arc || ''} onChange={v => update('arc', v)} rows={2} />
          <Field label="Voice Description" value={form.voiceDescription || ''} onChange={v => update('voiceDescription', v)} />
          <Field label="Wardrobe Notes" value={form.wardrobeNotes || ''} onChange={v => update('wardrobeNotes', v)} />

          <div>
            <label className="text-[10px] text-slate-500 block mb-1">Traits (comma separated)</label>
            <input
              value={(form.traits || []).join(', ')}
              onChange={e => update('traits', e.target.value.split(',').map(t => t.trim()).filter(Boolean))}
              className="w-full bg-[#0f1219] border border-white/8 rounded px-3 py-1.5 text-xs text-slate-300 outline-none focus:border-indigo-500/30"
            />
          </div>

          <div>
            <label className="text-[10px] text-slate-500 block mb-1">Aliases (comma separated)</label>
            <input
              value={(form.aliases || []).join(', ')}
              onChange={e => update('aliases', e.target.value.split(',').map(t => t.trim()).filter(Boolean))}
              className="w-full bg-[#0f1219] border border-white/8 rounded px-3 py-1.5 text-xs text-slate-300 outline-none focus:border-indigo-500/30"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 flex justify-end gap-2 px-5 py-3 border-t border-white/5">
          <button onClick={onClose} className="px-4 py-2 rounded-md text-xs text-slate-400 border border-white/8 hover:bg-white/[0.03]">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="px-5 py-2 rounded-md text-xs font-semibold bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 hover:bg-indigo-500/30 disabled:opacity-50">
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, className = '' }: { label: string; value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <div className={className}>
      <label className="text-[10px] text-slate-500 block mb-0.5">{label}</label>
      <input value={value} onChange={e => onChange(e.target.value)} className="w-full bg-[#0f1219] border border-white/8 rounded px-3 py-1.5 text-xs text-slate-300 outline-none focus:border-indigo-500/30" />
    </div>
  );
}

function SelectField({ label, value, options, onChange, className = '' }: { label: string; value: string; options: string[]; onChange: (v: string) => void; className?: string }) {
  return (
    <div className={className}>
      <label className="text-[10px] text-slate-500 block mb-0.5">{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)} className="w-full bg-[#0f1219] border border-white/8 rounded px-3 py-1.5 text-xs text-slate-300 outline-none focus:border-indigo-500/30">
        {options.map(o => <option key={o} value={o}>{o || '—'}</option>)}
      </select>
    </div>
  );
}

function TextArea({ label, value, onChange, rows = 3 }: { label: string; value: string; onChange: (v: string) => void; rows?: number }) {
  return (
    <div>
      <label className="text-[10px] text-slate-500 block mb-0.5">{label}</label>
      <textarea value={value} onChange={e => onChange(e.target.value)} rows={rows} className="w-full bg-[#0f1219] border border-white/8 rounded px-3 py-1.5 text-xs text-slate-300 outline-none focus:border-indigo-500/30 resize-y" />
    </div>
  );
}
