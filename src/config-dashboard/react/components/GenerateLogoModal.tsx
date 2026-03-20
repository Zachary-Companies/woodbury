/**
 * GenerateLogoModal — AI-powered pipeline logo generation.
 */
import React, { useState, useCallback } from 'react';

interface GenerateLogoModalProps {
  pipelineId: string;
  pipelineName: string;
  pipelineDescription?: string;
  currentLogo?: string;
  onClose: () => void;
  onSaved: () => void;
}

export function GenerateLogoModal({ pipelineId, pipelineName, pipelineDescription, currentLogo, onClose, onSaved }: GenerateLogoModalProps) {
  const defaultPrompt = `A modern, minimal logo icon for "${pipelineName}". ${
    pipelineDescription ? pipelineDescription.slice(0, 100) + '. ' : ''
  }Clean vector style, dark background, vibrant gradient colors, suitable as a small app icon.`;

  const [prompt, setPrompt] = useState(defaultPrompt);
  const [generating, setGenerating] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [logoPath, setLogoPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingLogo, setSavingLogo] = useState(false);

  const logoSrc = currentLogo
    ? (currentLogo.startsWith('data:') || currentLogo.startsWith('http')
        ? currentLogo
        : `/api/file?path=${encodeURIComponent(currentLogo)}`)
    : null;

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim()) return;
    setGenerating(true);
    setError(null);
    setPreview(null);
    try {
      const res = await fetch(`/api/app/${encodeURIComponent(pipelineId)}/generate-logo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Generation failed');
      setLogoPath(data.filePath);
      setPreview(`/api/file?path=${encodeURIComponent(data.filePath)}`);
    } catch (err: any) {
      setError(err.message);
    }
    setGenerating(false);
  }, [prompt, pipelineId]);

  const handleSaveLogo = useCallback(async () => {
    if (!logoPath) return;
    setSavingLogo(true);
    try {
      // Update pipeline metadata with logo path
      const compRes = await fetch(`/api/compositions/${encodeURIComponent(pipelineId)}`);
      const comp = await compRes.json();
      const metadata = comp?.composition?.metadata || {};
      metadata.logo = logoPath;
      metadata.updatedAt = new Date().toISOString();
      await fetch(`/api/compositions/${encodeURIComponent(pipelineId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ composition: { ...comp.composition, metadata } }),
      });
      onSaved();
      onClose();
    } catch {}
    setSavingLogo(false);
  }, [logoPath, pipelineId, onClose, onSaved]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-[420px] bg-[#1a1f2e] border border-white/10 rounded-xl shadow-2xl" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
          <h3 className="text-sm font-semibold text-white">Generate Pipeline Logo</h3>
          <button onClick={onClose} className="text-slate-600 hover:text-slate-400 text-lg">&times;</button>
        </div>

        <div className="px-5 py-4 space-y-3">
          {/* Current logo */}
          {logoSrc && !preview && (
            <div className="text-center">
              <img src={logoSrc} alt="" className="inline-block w-16 h-16 rounded-xl border border-indigo-500/20" />
            </div>
          )}

          {/* Preview */}
          {preview && (
            <div className="text-center">
              <img
                src={preview}
                alt="Generated logo"
                className="inline-block w-20 h-20 rounded-xl border border-indigo-500/30 shadow-lg shadow-indigo-500/10"
              />
            </div>
          )}

          {/* Prompt */}
          <div>
            <label className="block text-[10px] text-slate-500 mb-1">Prompt</label>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              rows={4}
              className="w-full px-3 py-2 rounded-md text-xs bg-[#0f172a] border border-white/10 text-slate-300 resize-y outline-none focus:border-indigo-500/30"
            />
          </div>

          {/* Error */}
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-white/5">
          <button onClick={onClose} className="px-4 py-1.5 rounded-md text-xs text-slate-400 hover:text-white">Cancel</button>
          {preview && logoPath ? (
            <button
              onClick={handleSaveLogo}
              disabled={savingLogo}
              className="px-4 py-1.5 rounded-md text-xs font-medium bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-50"
            >
              {savingLogo ? 'Saving...' : '✓ Save as Logo'}
            </button>
          ) : (
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="px-4 py-1.5 rounded-md text-xs font-medium bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 disabled:opacity-50"
            >
              {generating ? 'Generating...' : '✨ Generate'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
