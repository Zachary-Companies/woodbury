'use client';

import { useState, useEffect } from 'react';

interface Config {
  defaultTimezone: string;
  defaultPlatforms: string[];
  llm: {
    textProvider: string;
    textModel: string;
  };
  posting: {
    delayBetweenPlatforms: number;
    retryLimit: number;
    retryDelay: number;
  };
}

export default function SettingsPage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(setConfig)
      .catch(() => setConfig({
        defaultTimezone: 'America/New_York',
        defaultPlatforms: [],
        llm: { textProvider: 'anthropic', textModel: 'claude-opus-4-5-20251101' },
        posting: { delayBetweenPlatforms: 5000, retryLimit: 2, retryDelay: 10000 },
      }));
  }, []);

  if (!config) return <div className="text-muted">Loading...</div>;

  const handleSave = async () => {
    setSaving(true);
    setMessage('');
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (res.ok) {
        setMessage('Settings saved!');
        setTimeout(() => setMessage(''), 3000);
      }
    } catch {
      setMessage('Failed to save');
    }
    setSaving(false);
  };

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-6">⚙️ Settings</h1>

      {message && (
        <div className="bg-success/10 border border-success/30 text-success rounded-lg p-3 text-sm mb-6">
          {message}
        </div>
      )}

      {/* Timezone */}
      <section className="mb-6">
        <label className="block text-sm font-medium text-muted mb-2">
          Default Timezone
        </label>
        <select
          value={config.defaultTimezone}
          onChange={e => setConfig({ ...config, defaultTimezone: e.target.value })}
          className="bg-surface border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
        >
          <option value="America/New_York">Eastern (New York)</option>
          <option value="America/Chicago">Central (Chicago)</option>
          <option value="America/Denver">Mountain (Denver)</option>
          <option value="America/Los_Angeles">Pacific (Los Angeles)</option>
          <option value="UTC">UTC</option>
          <option value="Europe/London">London</option>
          <option value="Europe/Paris">Paris</option>
          <option value="Asia/Tokyo">Tokyo</option>
        </select>
      </section>

      {/* LLM Settings */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-3">LLM Configuration</h2>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-muted mb-1">Provider</label>
            <select
              value={config.llm.textProvider}
              onChange={e => setConfig({
                ...config,
                llm: { ...config.llm, textProvider: e.target.value }
              })}
              className="bg-surface border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
            >
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI (GPT)</option>
              <option value="groq">Groq (Llama)</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-muted mb-1">Model</label>
            <input
              type="text"
              value={config.llm.textModel}
              onChange={e => setConfig({
                ...config,
                llm: { ...config.llm, textModel: e.target.value }
              })}
              className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
            />
          </div>
        </div>
      </section>

      {/* Posting Settings */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-3">Posting</h2>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-muted mb-1">
              Delay between platforms (ms)
            </label>
            <input
              type="number"
              value={config.posting.delayBetweenPlatforms}
              onChange={e => setConfig({
                ...config,
                posting: { ...config.posting, delayBetweenPlatforms: parseInt(e.target.value) || 5000 }
              })}
              className="bg-surface border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none w-40"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-muted mb-1">
              Retry limit
            </label>
            <input
              type="number"
              value={config.posting.retryLimit}
              onChange={e => setConfig({
                ...config,
                posting: { ...config.posting, retryLimit: parseInt(e.target.value) || 2 }
              })}
              className="bg-surface border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none w-40"
            />
          </div>
        </div>
      </section>

      <button
        onClick={handleSave}
        disabled={saving}
        className="bg-primary hover:bg-primary-hover disabled:opacity-50 text-white px-6 py-2 rounded-lg text-sm font-medium transition-colors"
      >
        {saving ? 'Saving...' : '💾 Save Settings'}
      </button>
    </div>
  );
}
