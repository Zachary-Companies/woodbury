'use client'

import { useState, useEffect } from 'react'
import type { Extension } from '@/types/extension'

interface ExtensionFormProps {
  extension?: Extension | null
  onSave: (data: Partial<Extension>) => Promise<void>
  onClose: () => void
}

const defaultFormData: Partial<Extension> = {
  name: '',
  displayName: '',
  description: '',
  version: '1.0.0',
  author: '',
  category: 'media',
  provides: [],
  gitUrl: '',
  repoUrl: '',
  icon: 'image',
  tags: [],
  platforms: ['macos'],
  featured: false,
  visible: true,
  order: 99,
}

const iconOptions = ['image', 'audio', 'share', 'video', 'calendar', 'music']
const provideOptions = ['tools', 'commands', 'prompts', 'webui']
const platformOptions = ['macos', 'windows', 'linux']

export default function ExtensionForm({ extension, onSave, onClose }: ExtensionFormProps) {
  const [form, setForm] = useState<Partial<Extension>>(defaultFormData)
  const [saving, setSaving] = useState(false)
  const [tagsInput, setTagsInput] = useState('')

  useEffect(() => {
    if (extension) {
      setForm(extension)
      setTagsInput((extension.tags || []).join(', '))
    }
  }, [extension])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const tags = tagsInput.split(',').map((t) => t.trim()).filter(Boolean)
      await onSave({ ...form, tags })
      onClose()
    } catch (err) {
      console.error('Save failed:', err)
    } finally {
      setSaving(false)
    }
  }

  const toggleArrayItem = (field: 'provides' | 'platforms', value: string) => {
    const current = (form[field] as string[]) || []
    setForm({
      ...form,
      [field]: current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value],
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-white/10 bg-slate-800 p-6 shadow-2xl">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">
            {extension ? 'Edit Extension' : 'Add Extension'}
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-white/5 hover:text-white"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Name (slug) */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">Name (slug)</label>
              <input
                type="text"
                required
                disabled={!!extension}
                value={form.name || ''}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="my-extension"
                className="w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-purple-500/50 disabled:opacity-50"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">Display Name</label>
              <input
                type="text"
                required
                value={form.displayName || ''}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                placeholder="My Extension"
                className="w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-purple-500/50"
              />
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Description</label>
            <textarea
              required
              value={form.description || ''}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={3}
              className="w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-purple-500/50"
            />
          </div>

          {/* Version + Author + Category */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">Version</label>
              <input
                type="text"
                value={form.version || ''}
                onChange={(e) => setForm({ ...form, version: e.target.value })}
                className="w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-white outline-none focus:border-purple-500/50"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">Author</label>
              <input
                type="text"
                value={form.author || ''}
                onChange={(e) => setForm({ ...form, author: e.target.value })}
                className="w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-white outline-none focus:border-purple-500/50"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">Category</label>
              <select
                value={form.category || ''}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                className="w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-white outline-none focus:border-purple-500/50"
              >
                <option value="media">Media</option>
                <option value="social">Social</option>
                <option value="productivity">Productivity</option>
                <option value="automation">Automation</option>
              </select>
            </div>
          </div>

          {/* Icon */}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Icon</label>
            <div className="flex flex-wrap gap-2">
              {iconOptions.map((icon) => (
                <button
                  key={icon}
                  type="button"
                  onClick={() => setForm({ ...form, icon })}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                    form.icon === icon
                      ? 'bg-purple-600 text-white'
                      : 'border border-white/10 text-slate-400 hover:border-white/20'
                  }`}
                >
                  {icon}
                </button>
              ))}
            </div>
          </div>

          {/* Git URL + Repo URL */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">Git URL</label>
              <input
                type="text"
                value={form.gitUrl || ''}
                onChange={(e) => setForm({ ...form, gitUrl: e.target.value })}
                placeholder="https://github.com/..."
                className="w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-purple-500/50"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">Repo URL</label>
              <input
                type="text"
                value={form.repoUrl || ''}
                onChange={(e) => setForm({ ...form, repoUrl: e.target.value })}
                placeholder="https://github.com/..."
                className="w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-purple-500/50"
              />
            </div>
          </div>

          {/* Provides */}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Provides</label>
            <div className="flex flex-wrap gap-2">
              {provideOptions.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => toggleArrayItem('provides', p)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                    (form.provides || []).includes(p)
                      ? 'bg-purple-600 text-white'
                      : 'border border-white/10 text-slate-400 hover:border-white/20'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* Platforms */}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Platforms</label>
            <div className="flex flex-wrap gap-2">
              {platformOptions.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => toggleArrayItem('platforms', p)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                    (form.platforms || []).includes(p)
                      ? 'bg-purple-600 text-white'
                      : 'border border-white/10 text-slate-400 hover:border-white/20'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* Tags */}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Tags (comma-separated)</label>
            <input
              type="text"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="ai, image, generation"
              className="w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-purple-500/50"
            />
          </div>

          {/* Order */}
          <div className="w-24">
            <label className="mb-1 block text-xs font-medium text-slate-400">Order</label>
            <input
              type="number"
              value={form.order ?? 99}
              onChange={(e) => setForm({ ...form, order: parseInt(e.target.value) || 0 })}
              className="w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-white outline-none focus:border-purple-500/50"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-400 transition-colors hover:border-white/20 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-gradient-to-r from-purple-600 to-violet-600 px-6 py-2 text-sm font-semibold text-white transition-all hover:from-purple-500 hover:to-violet-500 disabled:opacity-50"
            >
              {saving ? 'Saving...' : extension ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
