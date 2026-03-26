/**
 * SettingsView — pipeline input variables editor.
 *
 * Loads pipeline-inputs.json (if present) for friendly labels, descriptions,
 * field types (select, textarea), grouping, and conditional sections.
 * Falls back to raw port names from the pipeline schema when no friendly
 * inputs file exists.
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  type FriendlyInput,
  type ConditionalGroup,
  type FieldGroup,
  parseFriendlyInputs,
  buildFieldGroups,
  humanizeFieldName,
} from '../utils/settingsUtils';

interface SettingsViewProps {
  schema: any;
  appState: any;
  pipelineId: string;
}

export function SettingsView({ schema, appState, pipelineId }: SettingsViewProps) {
  const settingsSection = schema?.sections?.find((s: any) => s.type === 'settings');
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [friendlyInputs, setFriendlyInputs] = useState<FriendlyInput[] | null>(null);
  const [conditionalInputs, setConditionalInputs] = useState<Record<string, ConditionalGroup> | null>(null);
  const [loaded, setLoaded] = useState(false);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Load pipeline-inputs.json for friendly field definitions
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/app/${encodeURIComponent(pipelineId)}/pipeline-inputs`);
        if (res.ok) {
          const data = await res.json();
          const parsed = parseFriendlyInputs(data);
          setFriendlyInputs(parsed.inputs);
          setConditionalInputs(parsed.conditional);
        }
      } catch {
        // No friendly inputs — will fall back to port names
      }
      setLoaded(true);
    })();
  }, [pipelineId]);

  // Load current variable values
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/app/${encodeURIComponent(pipelineId)}/state`);
        if (res.ok) {
          const state = await res.json();
          // Extract variable values from app state
          const vars: Record<string, string> = {};
          if (state?.variables) {
            for (const [k, v] of Object.entries(state.variables)) {
              vars[k] = typeof v === 'string' ? v : String(v || '');
            }
          }
          setValues(prev => ({ ...prev, ...vars }));
        }
      } catch {}
    })();
  }, [pipelineId]);

  if (!settingsSection) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-500 gap-3">
        <span className="text-4xl">⚙️</span>
        <h3 className="text-sm font-semibold">No settings section</h3>
        <p className="text-xs text-slate-600">This pipeline has no configurable input variables.</p>
      </div>
    );
  }

  const ports = settingsSection.outputPorts || [];

  const saveField = useCallback(async (name: string, value: string) => {
    setSaving(name);
    try {
      await fetch(`/api/app/${encodeURIComponent(pipelineId)}/variables/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
    } catch {}
    setSaving(null);
  }, [pipelineId]);

  const handleChange = useCallback((name: string, value: string) => {
    setValues(prev => ({ ...prev, [name]: value }));
    // Debounced auto-save
    if (timers.current[name]) clearTimeout(timers.current[name]);
    timers.current[name] = setTimeout(() => saveField(name, value), 800);
  }, [saveField]);

  // Build grouped layout if we have friendly inputs, otherwise flat list
  const groups = buildFieldGroups(friendlyInputs, conditionalInputs, ports, values);

  const renderField = (field: FriendlyInput) => {
    const val = values[field.id] || '';
    const isSaving = saving === field.id;

    return (
      <div key={field.id}>
        <label className="block text-xs font-medium text-slate-300 mb-1">
          {field.label}
          {field.required && <span className="text-violet-400 ml-1">*</span>}
        </label>
        {field.description && (
          <p className="text-[10px] text-slate-600 mb-1.5 leading-relaxed">{field.description}</p>
        )}
        {field.type === 'select' ? (
          <select
            value={val}
            onChange={e => handleChange(field.id, e.target.value)}
            className="w-full px-3 py-2 rounded-md text-xs bg-white/[0.03] border border-white/5 text-slate-300 outline-none focus:border-indigo-500/30"
            style={{ appearance: 'none' as any }}
          >
            <option value="">{field.placeholder || 'Select...'}</option>
            {field.options?.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        ) : field.type === 'textarea' ? (
          <textarea
            value={val}
            onChange={e => handleChange(field.id, e.target.value)}
            placeholder={field.placeholder}
            rows={field.rows || 3}
            className="w-full px-3 py-2 rounded-md text-xs bg-white/[0.03] border border-white/5 text-slate-300 placeholder-slate-600 outline-none focus:border-indigo-500/30"
            style={{ resize: 'vertical', lineHeight: 1.6 }}
          />
        ) : (
          <input
            type="text"
            value={val}
            onChange={e => handleChange(field.id, e.target.value)}
            placeholder={field.placeholder}
            className="w-full px-3 py-2 rounded-md text-xs bg-white/[0.03] border border-white/5 text-slate-300 placeholder-slate-600 outline-none focus:border-indigo-500/30"
          />
        )}
        {isSaving && <span className="text-[9px] text-violet-400 mt-1 block">Saving...</span>}
      </div>
    );
  };

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <div className="max-w-2xl mx-auto">
      <h2 className="text-base font-bold text-white mb-1">Project Settings</h2>
      <p className="text-xs text-slate-500 mb-6">
        Configure your project. Changes save automatically.
      </p>
      </div>

      <div className="max-w-2xl mx-auto space-y-8">
        {groups.map(group => {
          if (!group.visible) return null;
          return (
            <div key={group.id}>
              {group.label && (
                <div className="border-b border-white/[0.06] pb-2 mb-4">
                  <h3 className="text-xs font-semibold text-slate-300">{group.label}</h3>
                  {group.description && (
                    <p className="text-[10px] text-slate-600 mt-1">{group.description}</p>
                  )}
                </div>
              )}
              <div
                className="space-y-4"
                style={group.columns === 2 ? { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 } : undefined}
              >
                {group.fields.map(f => renderField(f))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
