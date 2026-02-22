'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Post, ConnectorManifest } from '@/types';
import { getPlatformIcon } from '@/lib/utils';

interface PostFormProps {
  post?: Post;
  connectors: ConnectorManifest[];
}

export default function PostForm({ post, connectors }: PostFormProps) {
  const router = useRouter();
  const [text, setText] = useState(post?.content.text || '');
  const [platforms, setPlatforms] = useState<string[]>(
    post?.platforms.filter(p => p.enabled).map(p => p.platform) || []
  );
  const [scheduledDate, setScheduledDate] = useState(
    post?.scheduledAt ? new Date(post.scheduledAt).toISOString().slice(0, 16) : ''
  );
  const [timezone, setTimezone] = useState(post?.timezone || 'America/New_York');
  const [tags, setTags] = useState(post?.tags.join(', ') || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [genPrompt, setGenPrompt] = useState('');

  const togglePlatform = (platform: string) => {
    setPlatforms(prev =>
      prev.includes(platform)
        ? prev.filter(p => p !== platform)
        : [...prev, platform]
    );
  };

  const charCount = text.length;
  const minLimit = platforms.reduce((min, p) => {
    const connector = connectors.find(c => c.platform === p);
    return connector ? Math.min(min, connector.maxTextLength) : min;
  }, Infinity);
  const isOverLimit = minLimit !== Infinity && charCount > minLimit;

  const handleSave = async (asDraft: boolean) => {
    if (platforms.length === 0) {
      setError('Select at least one platform');
      return;
    }
    if (!text.trim()) {
      setError('Post text is required');
      return;
    }

    setSaving(true);
    setError('');

    try {
      const body: any = {
        text: text.trim(),
        platforms,
        tags: tags.split(',').map(t => t.trim()).filter(Boolean),
        timezone,
      };

      if (!asDraft && scheduledDate) {
        body.scheduledAt = new Date(scheduledDate).toISOString();
      }

      const url = post ? `/api/posts/${post.id}` : '/api/posts';
      const method = post ? 'PUT' : 'POST';

      if (post) {
        body.content = { text: body.text };
        delete body.text;
      }

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save post');
      }

      const saved = await res.json();
      router.push(`/posts/${saved.id}`);
      router.refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleGenerate = async () => {
    if (!genPrompt.trim()) return;
    setGenerating(true);
    setError('');

    try {
      const res = await fetch('/api/generate/text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: genPrompt,
          platforms,
          tone: 'casual',
          includeHashtags: true,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Generation failed');
      }

      const data = await res.json();
      setText(data.text || data.content || genPrompt);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      {error && (
        <div className="bg-danger/10 border border-danger/30 text-danger rounded-lg p-3 text-sm">
          {error}
        </div>
      )}

      {/* Platform Selection */}
      <section>
        <label className="block text-sm font-medium text-muted mb-2">
          Platforms
        </label>
        <div className="flex flex-wrap gap-2">
          {connectors.map(c => (
            <button
              key={c.platform}
              onClick={() => togglePlatform(c.platform)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm border transition-colors ${
                platforms.includes(c.platform)
                  ? 'border-primary bg-primary/20 text-primary'
                  : 'border-border bg-surface text-muted hover:border-primary/50'
              }`}
            >
              <span>{getPlatformIcon(c.platform)}</span>
              <span>{c.displayName}</span>
              <span className="text-xs opacity-60">{c.maxTextLength}</span>
            </button>
          ))}
        </div>
      </section>

      {/* Content Editor */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-muted">Content</label>
          <span className={`text-xs ${isOverLimit ? 'text-danger' : 'text-muted'}`}>
            {charCount}{minLimit !== Infinity ? ` / ${minLimit}` : ''}
          </span>
        </div>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Write your post content..."
          rows={6}
          className="w-full bg-surface border border-border rounded-lg p-3 text-foreground placeholder-muted/50 focus:border-primary focus:outline-none resize-y"
        />
      </section>

      {/* AI Generation */}
      <section className="bg-surface border border-border rounded-lg p-4">
        <label className="block text-sm font-medium text-muted mb-2">
          🤖 AI Generate
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={genPrompt}
            onChange={e => setGenPrompt(e.target.value)}
            placeholder="Describe what you want to post about..."
            className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-muted/50 focus:border-primary focus:outline-none"
            onKeyDown={e => e.key === 'Enter' && handleGenerate()}
          />
          <button
            onClick={handleGenerate}
            disabled={generating || !genPrompt.trim()}
            className="bg-secondary hover:bg-secondary/80 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            {generating ? '⏳' : '✨'} Generate
          </button>
        </div>
      </section>

      {/* Schedule */}
      <section>
        <label className="block text-sm font-medium text-muted mb-2">
          Schedule
        </label>
        <div className="flex gap-4">
          <input
            type="datetime-local"
            value={scheduledDate}
            onChange={e => setScheduledDate(e.target.value)}
            className="bg-surface border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
          />
          <select
            value={timezone}
            onChange={e => setTimezone(e.target.value)}
            className="bg-surface border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
          >
            <option value="America/New_York">Eastern</option>
            <option value="America/Chicago">Central</option>
            <option value="America/Denver">Mountain</option>
            <option value="America/Los_Angeles">Pacific</option>
            <option value="UTC">UTC</option>
          </select>
        </div>
      </section>

      {/* Tags */}
      <section>
        <label className="block text-sm font-medium text-muted mb-2">
          Tags (comma-separated)
        </label>
        <input
          type="text"
          value={tags}
          onChange={e => setTags(e.target.value)}
          placeholder="marketing, product-launch, weekly"
          className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-muted/50 focus:border-primary focus:outline-none"
        />
      </section>

      {/* Actions */}
      <div className="flex gap-3 pt-4 border-t border-border">
        <button
          onClick={() => handleSave(false)}
          disabled={saving}
          className="bg-primary hover:bg-primary-hover disabled:opacity-50 text-white px-6 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          {saving ? 'Saving...' : scheduledDate ? '📅 Schedule Post' : '💾 Save Draft'}
        </button>
        <button
          onClick={() => handleSave(true)}
          disabled={saving}
          className="bg-surface hover:bg-surface-hover border border-border text-foreground px-6 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          Save as Draft
        </button>
        <button
          onClick={() => router.back()}
          className="text-muted hover:text-foreground px-4 py-2 text-sm transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
