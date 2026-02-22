'use client';

import { useState } from 'react';
import { getPlatformIcon } from '@/lib/utils';

const PLATFORMS = ['instagram', 'twitter', 'facebook', 'linkedin', 'tiktok'];
const TONES = ['casual', 'professional', 'humorous', 'inspirational'];

export default function GeneratePage() {
  const [prompt, setPrompt] = useState('');
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);
  const [tone, setTone] = useState('casual');
  const [includeHashtags, setIncludeHashtags] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');

  const togglePlatform = (p: string) => {
    setSelectedPlatforms(prev =>
      prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]
    );
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    setGenerating(true);
    setError('');
    setResult('');

    try {
      const res = await fetch('/api/generate/text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          platforms: selectedPlatforms,
          tone,
          includeHashtags,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Generation failed');
      }

      const data = await res.json();
      setResult(data.text || data.content || 'Generated content will appear here when LLM API keys are configured.');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  };

  const handleCreatePost = async () => {
    if (!result) return;
    try {
      const res = await fetch('/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: result,
          platforms: selectedPlatforms.length > 0 ? selectedPlatforms : ['instagram'],
        }),
      });
      if (res.ok) {
        const post = await res.json();
        window.location.href = `/posts/${post.id}`;
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold mb-6">🤖 AI Content Generator</h1>

      {/* Prompt */}
      <section className="mb-6">
        <label className="block text-sm font-medium text-muted mb-2">
          What should the post be about?
        </label>
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder="Describe the topic, product, event, or idea you want to post about..."
          rows={4}
          className="w-full bg-surface border border-border rounded-lg p-3 text-foreground placeholder-muted/50 focus:border-primary focus:outline-none resize-y"
        />
      </section>

      {/* Options */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        {/* Platforms */}
        <section>
          <label className="block text-sm font-medium text-muted mb-2">
            Target Platforms
          </label>
          <div className="flex flex-wrap gap-2">
            {PLATFORMS.map(p => (
              <button
                key={p}
                onClick={() => togglePlatform(p)}
                className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                  selectedPlatforms.includes(p)
                    ? 'border-primary bg-primary/20 text-primary'
                    : 'border-border bg-surface text-muted hover:border-primary/50'
                }`}
              >
                {getPlatformIcon(p)} {p}
              </button>
            ))}
          </div>
        </section>

        {/* Tone */}
        <section>
          <label className="block text-sm font-medium text-muted mb-2">
            Tone
          </label>
          <div className="flex flex-wrap gap-2">
            {TONES.map(t => (
              <button
                key={t}
                onClick={() => setTone(t)}
                className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                  tone === t
                    ? 'border-primary bg-primary/20 text-primary'
                    : 'border-border bg-surface text-muted hover:border-primary/50'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </section>
      </div>

      {/* Hashtags toggle */}
      <label className="flex items-center gap-2 mb-6 cursor-pointer">
        <input
          type="checkbox"
          checked={includeHashtags}
          onChange={e => setIncludeHashtags(e.target.checked)}
          className="rounded border-border bg-surface"
        />
        <span className="text-sm text-muted">Include hashtags</span>
      </label>

      {/* Generate button */}
      <button
        onClick={handleGenerate}
        disabled={generating || !prompt.trim()}
        className="bg-primary hover:bg-primary-hover disabled:opacity-50 text-white px-6 py-3 rounded-lg font-medium transition-colors w-full mb-6"
      >
        {generating ? '⏳ Generating...' : '✨ Generate Post Content'}
      </button>

      {error && (
        <div className="bg-danger/10 border border-danger/30 text-danger rounded-lg p-3 text-sm mb-6">
          {error}
        </div>
      )}

      {/* Result */}
      {result && (
        <section className="bg-surface border border-border rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-muted">Generated Content</h3>
            <button
              onClick={handleCreatePost}
              className="bg-secondary hover:bg-secondary/80 text-white px-3 py-1 rounded text-xs font-medium transition-colors"
            >
              → Create Post
            </button>
          </div>
          <div className="bg-background rounded-lg p-3 whitespace-pre-wrap text-sm">
            {result}
          </div>
        </section>
      )}
    </div>
  );
}
