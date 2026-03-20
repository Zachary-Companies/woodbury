/**
 * SettingsView — pipeline input variables editor.
 * Shows the pipeline's input ports as an editable form.
 */
import React, { useState, useCallback } from 'react';

interface SettingsViewProps {
  schema: any;
  appState: any;
  pipelineId: string;
}

export function SettingsView({ schema, appState, pipelineId }: SettingsViewProps) {
  const settingsSection = schema?.sections?.find((s: any) => s.type === 'settings');
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

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

  const handleChange = useCallback((name: string, value: string) => {
    setValues(prev => ({ ...prev, [name]: value }));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      // Save each changed variable to its node
      for (const [name, value] of Object.entries(values)) {
        if (!value) continue;
        await fetch(`/api/app/${encodeURIComponent(pipelineId)}/variables/${encodeURIComponent(name)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        });
      }
    } catch {}
    setSaving(false);
  }, [values, pipelineId]);

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <h2 className="text-base font-bold text-white mb-1">Pipeline Settings</h2>
      <p className="text-xs text-slate-500 mb-6">
        These are the pipeline inputs. Change them and click "Run Pipeline" to regenerate all outputs.
      </p>

      <div className="max-w-lg space-y-4">
        {ports.map((port: any) => (
          <div key={port.name}>
            <label className="block text-xs font-medium text-slate-300 mb-1">{port.name}</label>
            {port.description && (
              <p className="text-[10px] text-slate-600 mb-1">{port.description}</p>
            )}
            <input
              type="text"
              value={values[port.name] || ''}
              onChange={e => handleChange(port.name, e.target.value)}
              placeholder={port.type || 'Enter value...'}
              className="w-full px-3 py-2 rounded-md text-xs bg-white/[0.03] border border-white/5 text-slate-300 placeholder-slate-600 outline-none focus:border-indigo-500/30"
            />
          </div>
        ))}
      </div>

      {Object.keys(values).length > 0 && (
        <div className="mt-6">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 rounded-md text-xs font-medium bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 disabled:opacity-50"
          >
            {saving ? '⏳ Saving...' : '💾 Save Settings'}
          </button>
        </div>
      )}
    </div>
  );
}
