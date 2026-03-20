/**
 * RulesModal — editor for connection detection rules.
 * Rules auto-detect connections between entities (e.g. character names in shots).
 */
import React, { useState, useCallback, useEffect } from 'react';

interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  type: string;
  source: { entityType: string; field: string };
  target: { entityType: string; matchField: string };
  relationship: string;
  matchOptions: { caseSensitive: boolean; wholeWord: boolean };
}

interface RulesModalProps {
  pipelineId: string;
  onClose: () => void;
}

const ENTITY_TYPES = ['shot', 'character', 'location', 'scene', 'dialogue'];
const ENTITY_FIELDS: Record<string, string[]> = {
  shot: ['shotText', 'content', 'description', 'text', 'action'],
  character: ['name', 'displayName', 'aliases'],
  location: ['name', 'description'],
  scene: ['heading', 'sceneHeading', 'title', 'content'],
  dialogue: ['text', 'content', 'characterName'],
};
const RELATIONSHIPS = ['depicts', 'set-in', 'voice', 'related-to', 'references'];

const PRESETS: Record<string, Partial<Rule>> = {
  'character-in-shot': {
    name: 'Character names in shot descriptions',
    source: { entityType: 'shot', field: 'shotText' },
    target: { entityType: 'character', matchField: 'name' },
    relationship: 'depicts',
  },
  'location-in-shot': {
    name: 'Location names in shot descriptions',
    source: { entityType: 'shot', field: 'shotText' },
    target: { entityType: 'location', matchField: 'name' },
    relationship: 'set-in',
  },
  'character-in-dialogue': {
    name: 'Character name in dialogue text',
    source: { entityType: 'dialogue', field: 'characterName' },
    target: { entityType: 'character', matchField: 'name' },
    relationship: 'voice',
  },
};

function createDefaultRule(): Rule {
  return {
    id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    enabled: true,
    type: 'text-match',
    source: { entityType: 'shot', field: 'shotText' },
    target: { entityType: 'character', matchField: 'name' },
    relationship: 'depicts',
    matchOptions: { caseSensitive: false, wholeWord: true },
  };
}

export function RulesModal({ pipelineId, onClose }: RulesModalProps) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Load rules
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/app/${encodeURIComponent(pipelineId)}/rules`);
        if (res.ok) {
          const data = await res.json();
          setRules(data.rules || []);
        }
      } catch {}
      setLoading(false);
    })();
  }, [pipelineId]);

  const addRule = useCallback(() => {
    setRules(prev => [...prev, createDefaultRule()]);
  }, []);

  const addPreset = useCallback((key: string) => {
    const preset = PRESETS[key];
    if (!preset) return;
    if (rules.some(r => r.name === preset.name)) return; // Already exists
    setRules(prev => [...prev, { ...createDefaultRule(), ...preset } as Rule]);
  }, [rules]);

  const deleteRule = useCallback((index: number) => {
    setRules(prev => prev.filter((_, i) => i !== index));
  }, []);

  const updateRule = useCallback((index: number, partial: Partial<Rule>) => {
    setRules(prev => prev.map((r, i) => i === index ? { ...r, ...partial } : r));
  }, []);

  const updateRuleSource = useCallback((index: number, partial: Partial<Rule['source']>) => {
    setRules(prev => prev.map((r, i) => i === index ? { ...r, source: { ...r.source, ...partial } } : r));
  }, []);

  const updateRuleTarget = useCallback((index: number, partial: Partial<Rule['target']>) => {
    setRules(prev => prev.map((r, i) => i === index ? { ...r, target: { ...r.target, ...partial } } : r));
  }, []);

  const updateMatchOptions = useCallback((index: number, partial: Partial<Rule['matchOptions']>) => {
    setRules(prev => prev.map((r, i) => i === index ? { ...r, matchOptions: { ...r.matchOptions, ...partial } } : r));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/app/${encodeURIComponent(pipelineId)}/rules`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules }),
      });
      if (res.ok) onClose();
    } catch {}
    setSaving(false);
  }, [rules, pipelineId, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-[600px] max-h-[80vh] bg-[#1a1f2e] border border-white/10 rounded-xl shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-3 border-b border-white/5 flex-shrink-0">
          <h3 className="text-sm font-semibold text-white">Connection Rules</h3>
          <p className="text-[10px] text-slate-500 mt-0.5">
            Rules automatically detect connections between entities in your pipeline.
          </p>
        </div>

        {/* Rules list */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-3 min-h-0">
          {loading ? (
            <p className="text-xs text-slate-500 text-center py-4">Loading rules...</p>
          ) : rules.length === 0 ? (
            <p className="text-xs text-slate-600 text-center py-4">No rules yet. Add a rule to automatically detect connections.</p>
          ) : (
            rules.map((rule, i) => (
              <RuleCard
                key={rule.id}
                rule={rule}
                index={i}
                onUpdate={(partial) => updateRule(i, partial)}
                onUpdateSource={(partial) => updateRuleSource(i, partial)}
                onUpdateTarget={(partial) => updateRuleTarget(i, partial)}
                onUpdateOptions={(partial) => updateMatchOptions(i, partial)}
                onDelete={() => deleteRule(i)}
              />
            ))
          )}
        </div>

        {/* Add / Presets */}
        <div className="px-5 py-2 border-t border-white/5 flex-shrink-0">
          <button onClick={addRule} className="text-xs text-indigo-400 hover:text-indigo-300 mr-4">+ Add Rule</button>
          <span className="text-[10px] text-slate-600 mr-2">Presets:</span>
          {Object.entries(PRESETS).map(([key, preset]) => (
            <button
              key={key}
              onClick={() => addPreset(key)}
              className="text-[10px] text-slate-500 hover:text-slate-300 mr-2"
            >
              {preset.name?.split(' ').slice(0, 3).join(' ')}
            </button>
          ))}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-white/5 flex-shrink-0">
          <button onClick={onClose} className="px-4 py-1.5 rounded-md text-xs text-slate-400 hover:text-white">Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 rounded-md text-xs font-medium bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Rules'}
          </button>
        </div>
      </div>
    </div>
  );
}

function RuleCard({ rule, index, onUpdate, onUpdateSource, onUpdateTarget, onUpdateOptions, onDelete }: {
  rule: Rule;
  index: number;
  onUpdate: (partial: Partial<Rule>) => void;
  onUpdateSource: (partial: Partial<Rule['source']>) => void;
  onUpdateTarget: (partial: Partial<Rule['target']>) => void;
  onUpdateOptions: (partial: Partial<Rule['matchOptions']>) => void;
  onDelete: () => void;
}) {
  const srcFields = ENTITY_FIELDS[rule.source.entityType] || ['name', 'text'];
  const tgtFields = ENTITY_FIELDS[rule.target.entityType] || ['name', 'text'];

  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3 space-y-2">
      {/* Header */}
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={rule.enabled}
          onChange={e => onUpdate({ enabled: e.target.checked })}
          className="accent-indigo-500"
        />
        <input
          type="text"
          value={rule.name}
          onChange={e => onUpdate({ name: e.target.value })}
          placeholder="Rule name..."
          className="flex-1 bg-transparent text-xs text-slate-300 outline-none placeholder-slate-600"
        />
        <button onClick={onDelete} className="text-slate-600 hover:text-red-400 text-sm">&times;</button>
      </div>

      {/* Rule builder */}
      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className="text-indigo-400 font-medium">When</span>
        <Select value={rule.source.entityType} options={ENTITY_TYPES} onChange={v => onUpdateSource({ entityType: v })} />
        <span className="text-slate-600">'s</span>
        <Select value={rule.source.field} options={srcFields} onChange={v => onUpdateSource({ field: v })} />
        <span className="text-indigo-400 font-medium">contains</span>
        <Select value={rule.target.entityType} options={ENTITY_TYPES} onChange={v => onUpdateTarget({ entityType: v })} />
        <span className="text-slate-600">'s</span>
        <Select value={rule.target.matchField} options={tgtFields} onChange={v => onUpdateTarget({ matchField: v })} />
        <span className="text-indigo-400 font-medium">create</span>
        <Select value={rule.relationship} options={RELATIONSHIPS} onChange={v => onUpdate({ relationship: v })} />
      </div>

      {/* Options */}
      <div className="flex gap-3 text-[10px] text-slate-500">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={rule.matchOptions.wholeWord}
            onChange={e => onUpdateOptions({ wholeWord: e.target.checked })}
            className="accent-indigo-500"
          />
          Whole word
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={rule.matchOptions.caseSensitive}
            onChange={e => onUpdateOptions({ caseSensitive: e.target.checked })}
            className="accent-indigo-500"
          />
          Case sensitive
        </label>
      </div>
    </div>
  );
}

function Select({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="bg-[#0f172a] border border-white/10 rounded px-1.5 py-0.5 text-[10px] text-slate-300 outline-none"
    >
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}
