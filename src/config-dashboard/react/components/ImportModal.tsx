/**
 * ImportModal — upload/paste screenplay, preview parse results, set project folder, import.
 */
import React, { useState, useRef, useCallback } from 'react';
import { usePipeline } from '../stores/PipelineProvider';

interface ParseResult {
  metadata: Record<string, string>;
  characters: Record<string, { name: string; dialogueCount: number }>;
  locations: string[];
  sections: any[];
  elements: any[];
  _rawText: string;
}

// ── Fountain Parser (inline) ─────────────────────────────────

const NON_CHAR = /^(INT|EXT|EST|FADE|CUT|DISSOLVE|THE END|FLASHBACK|CONTINUED|MORE|DING|CLICK|BANG|SLAM|CRASH|BOOM|SMASH|TITLE|SUPER|INTERCUT|MONTAGE|LATER|BACK TO|END OF|SERIES OF|BEGIN|CLOSE ON|ANGLE ON|INSERT|WIDER|REVERSE|POV|TRACKING|ESTABLISHING|AERIAL|TIME CUT|MATCH CUT|JUMP CUT|SPLIT SCREEN)/;

function parseFountain(text: string): ParseResult {
  const lines = text.split('\n');
  const metadata: Record<string, string> = {};
  const characters: Record<string, { name: string; dialogueCount: number }> = {};
  const locations: string[] = [];
  const sections: any[] = [];
  const elements: any[] = [];
  let i = 0;

  // Title page
  while (i < lines.length) {
    const m = lines[i].match(/^(Title|Author|Credit|Source|Draft date|Contact|Copyright)\s*:\s*(.*)/i);
    if (m) { metadata[m[1].toLowerCase().replace(/\s+/g, '')] = m[2].trim(); i++; }
    else if (!lines[i].trim()) { i++; if (Object.keys(metadata).length > 0) break; }
    else break;
  }

  // Body
  for (; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    // Scene heading
    if (/^(INT|EXT|EST|INT\.?\/?EXT|I\/E)[.\s]/i.test(trimmed) || /^\.[A-Z]/.test(trimmed)) {
      const heading = trimmed.replace(/^\./, '');
      const locMatch = heading.match(/^(?:INT|EXT|EST|INT\.?\/?EXT|I\/E)[.\s]+([^-–]+)/i);
      if (locMatch) {
        const locName = locMatch[1].trim().replace(/\s*[-–].*$/, '');
        if (locName && !locations.includes(locName)) locations.push(locName);
      }
      const timeMatch = heading.match(/[-–]\s*(DAY|NIGHT|MORNING|EVENING|AFTERNOON|DAWN|DUSK|LATER|CONTINUOUS|SAME)/i);
      sections.push({ type: 'scene', title: heading, location: locMatch?.[1]?.trim()?.replace(/\s*[-–].*$/, '') || heading, timeOfDay: timeMatch?.[1]?.toUpperCase() || '' });
      continue;
    }

    // Secondary scene heading
    const prevBlank = (i === 0) || !lines[i - 1].trim();
    const nextIsAction = (i + 1 < lines.length) && lines[i + 1].trim() && !/^[A-Z][A-Z0-9\s.\-']+$/.test(lines[i + 1].trim());
    if (prevBlank && /^[A-Z][A-Z0-9\s'\-.,]+$/.test(trimmed) && trimmed.length >= 3 && trimmed.length <= 60 && nextIsAction && !/^(FADE|CUT|DISSOLVE|THE END|CONTINUED)/.test(trimmed) && trimmed.split(/\s+/).length <= 8) {
      const next = lines[i + 1]?.trim() || '';
      if (next.split(/\s+/).length >= 4 || /^[A-Z][a-z]/.test(next)) {
        sections.push({ type: 'scene', title: trimmed, location: trimmed, timeOfDay: '' });
        continue;
      }
    }

    // Transition
    if (/^(FADE IN|FADE OUT|FADE TO|CUT TO|DISSOLVE TO|SMASH CUT|MATCH CUT).*:?\s*$/i.test(trimmed) || /^>\s/.test(trimmed)) {
      elements.push({ type: 'transition', content: trimmed.replace(/^>\s*/, '') });
      continue;
    }

    // Character + dialogue
    const isAllCaps = /^[A-Z][A-Z0-9\s.\-']+(\s*\(.*\))?\s*$/.test(trimmed);
    let hasDialogueNext = false;
    if (isAllCaps && i + 1 < lines.length) {
      const next = lines[i + 1].trim();
      hasDialogueNext = next.length > 0 && (/^\(/.test(next) || !/^[A-Z][A-Z0-9\s.\-']+$/.test(next));
    }
    if (prevBlank && isAllCaps && hasDialogueNext && trimmed.length > 1 && trimmed.length < 40 && !NON_CHAR.test(trimmed)) {
      const charName = trimmed.replace(/\s*\(.*\)$/, '').trim();
      if (!characters[charName]) characters[charName] = { name: charName, dialogueCount: 0 };

      const dialogueLines: string[] = [];
      let paren = '';
      let j = i + 1;
      while (j < lines.length && lines[j].trim()) {
        const d = lines[j].trim();
        if (/^\(.*\)$/.test(d)) paren = d.replace(/^\(|\)$/g, '');
        else dialogueLines.push(d);
        j++;
      }
      if (dialogueLines.length > 0) {
        characters[charName].dialogueCount++;
        elements.push({ type: 'dialogue', characterName: charName, content: dialogueLines.join(' '), lines: dialogueLines, modifiers: paren ? [paren] : [] });
        i = j - 1;
        continue;
      }
    }

    // Section header
    if (/^#{1,6}\s+/.test(trimmed)) {
      sections.push({ type: 'act', title: trimmed.replace(/^#+\s+/, '') });
      continue;
    }

    elements.push({ type: 'action', content: trimmed });
  }

  return { metadata, characters, locations, sections, elements, _rawText: text };
}

// ── Component ────────────────────────────────────────────────

export function ImportModal({ onClose }: { onClose: () => void }) {
  const pipeline = usePipeline();
  const [tab, setTab] = useState<'paste' | 'file'>('paste');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [projectFolder, setProjectFolder] = useState('');
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [genre, setGenre] = useState('');
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setFileName(`${file.name} (${Math.round(file.size / 1024)} KB)`);
    const ext = file.name.split('.').pop()?.toLowerCase();

    if (ext === 'pdf') {
      // Send to server for extraction
      try {
        const buffer = await file.arrayBuffer();
        const res = await fetch(`/api/app/${encodeURIComponent(pipeline.pipelineId)}/extract-pdf-text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/pdf' },
          body: buffer,
        });
        const data = await res.json();
        if (data.error) { setError(data.error); return; }
        setText(data.text);
        setTab('paste');
      } catch (err: any) {
        setError('PDF extraction failed: ' + err.message);
      }
    } else {
      const reader = new FileReader();
      reader.onload = () => {
        setText(reader.result as string);
        setTab('paste');
      };
      reader.readAsText(file);
    }
  }, []);

  const handlePreview = useCallback(() => {
    if (!text.trim()) { setError('No text to parse'); return; }
    setError('');
    const result = parseFountain(text);
    result._rawText = text;
    setParseResult(result);
    setTitle(result.metadata.title || '');
    setAuthor(result.metadata.author || '');
  }, [text]);

  const handleBrowse = useCallback(async () => {
    if ((window as any).woodburyElectron?.selectFolder) {
      const folder = await (window as any).woodburyElectron.selectFolder();
      if (folder) setProjectFolder(folder);
    }
  }, []);

  const handleImport = useCallback(async () => {
    if (!parseResult) return;
    if (!projectFolder) { setError('Please select a project folder'); return; }

    setImporting(true);
    setError('');

    try {
      const pipelineId = pipeline.pipelineId;

      // Save project folder to composition metadata
      await fetch(`/api/compositions/${encodeURIComponent(pipelineId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: { projectFolder } }),
      });

      // Clear old state
      await pipeline.clearProject();

      // Build character array
      const charArray = Object.values(parseResult.characters).map((c, i) => ({
        id: `char-${i + 1}`,
        name: c.name,
        role: c.dialogueCount > 10 ? 'main' : c.dialogueCount > 3 ? 'supporting' : 'minor',
        description: '', traits: [], arc: '', relationships: [],
      }));

      // Build location array
      const locArray = parseResult.locations.map((loc, i) => ({
        id: `loc-${i + 1}`, name: loc, description: '', type: 'exterior', mood: '',
      }));

      // Build sections
      const sceneList = parseResult.sections.filter(s => s.type === 'scene');
      const scenesPerAct = Math.max(5, Math.ceil(sceneList.length / 3));
      const actNames = ['Act I', 'Act II', 'Act III', 'Act IV', 'Act V'];
      const sectionChildren = [];
      for (let ai = 0; ai * scenesPerAct < sceneList.length; ai++) {
        const actScenes = sceneList.slice(ai * scenesPerAct, (ai + 1) * scenesPerAct);
        sectionChildren.push({
          type: 'act', id: `act-${ai + 1}`, title: actNames[ai] || `Act ${ai + 1}`, order: ai + 1,
          children: actScenes.map((s: any, idx: number) => ({
            type: 'scene', id: `scene-${ai * scenesPerAct + idx + 1}`, title: s.title, location: s.location || '', timeOfDay: s.timeOfDay || '', order: ai * scenesPerAct + idx + 1, children: [],
          })),
        });
      }

      // Build elements
      const elementsArray = parseResult.elements.map((el, i) => {
        const base: any = { id: `elem-${i + 1}`, type: el.type, content: el.content || '' };
        if (el.type === 'dialogue') {
          base.characterName = el.characterName;
          base.characterId = charArray.find(c => c.name === el.characterName)?.id || '';
          base.lines = el.lines;
          base.modifiers = el.modifiers;
        }
        return base;
      });

      // Save project data
      const projectData = {
        version: '1.0',
        pipelineId,
        createdAt: new Date().toISOString(),
        metadata: {
          title: title || 'Untitled',
          author: [{ name: author || 'Unknown', role: 'Writer' }],
          genre: genre ? genre.split(',').map(g => g.trim()) : [],
          runtimeMinutes: Math.max(1, Math.round(text.split('\n').length / 55)),
          estimatedPages: Math.max(1, Math.round(text.split('\n').length / 55)),
          draftDate: parseResult.metadata.draftdate || new Date().toISOString().split('T')[0],
          version: '1.0',
          language: 'en-US',
        },
        characters: charArray,
        locations: locArray,
        sections: sectionChildren,
        elements: elementsArray,
        previsualizations: { shots: [] },
        assets: [],
        _fountainSource: parseResult._rawText,
      };

      // Write to project folder
      await fetch(`/api/app/${encodeURIComponent(pipelineId)}/project`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: projectData }),
      });

      // Reload pipeline
      await pipeline.reload();
      onClose();
    } catch (err: any) {
      setError('Import failed: ' + err.message);
      setImporting(false);
    }
  }, [parseResult, projectFolder, title, author, genre, text, onClose]);

  const charCount = parseResult ? Object.keys(parseResult.characters).length : 0;
  const sceneCount = parseResult ? parseResult.sections.filter(s => s.type === 'scene').length : 0;

  return (
    <div className="fixed inset-0 bg-black/60 z-[10000] flex items-center justify-center backdrop-blur-sm" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-[#1a1f2e] border border-white/8 rounded-xl w-[700px] max-w-[90vw] max-h-[85vh] shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
          <h3 className="text-sm font-semibold text-white">Import Screenplay</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-white text-lg leading-none">&times;</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0">
          {/* Tabs */}
          <div className="flex gap-2 mb-3">
            <button onClick={() => setTab('paste')} className={`px-4 py-1.5 rounded-md text-xs font-medium transition-colors ${tab === 'paste' ? 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/25' : 'text-slate-500 border border-white/5'}`}>
              Paste Text
            </button>
            <button onClick={() => setTab('file')} className={`px-4 py-1.5 rounded-md text-xs font-medium transition-colors ${tab === 'file' ? 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/25' : 'text-slate-500 border border-white/5'}`}>
              Upload File
            </button>
          </div>

          {/* File indicator */}
          {fileName && (
            <div className="mb-3 px-3 py-2 rounded-md bg-teal-500/10 border border-teal-500/15 text-xs text-teal-300">
              📄 {fileName}
            </div>
          )}

          {/* Paste tab */}
          {tab === 'paste' && (
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder="Paste Fountain-formatted screenplay text here..."
              className="w-full h-48 bg-[#0f1219] border border-white/8 rounded-lg text-xs text-slate-300 p-3 font-mono resize-y outline-none focus:border-indigo-500/30"
            />
          )}

          {/* File tab */}
          {tab === 'file' && (
            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('border-indigo-500/50'); }}
              onDragLeave={e => e.currentTarget.classList.remove('border-indigo-500/50')}
              onDrop={e => { e.preventDefault(); e.currentTarget.classList.remove('border-indigo-500/50'); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); }}
              className="border-2 border-dashed border-indigo-500/20 rounded-lg p-8 text-center cursor-pointer hover:border-indigo-500/40 transition-colors"
            >
              <p className="text-sm text-slate-400">Drop a .fountain, .txt, or .pdf file here</p>
              <p className="text-xs text-slate-600 mt-1">or click to browse</p>
              <input ref={fileInputRef} type="file" accept=".fountain,.txt,.pdf,.fdx" className="hidden" onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])} />
            </div>
          )}

          {/* Error */}
          {error && <div className="mt-3 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/15 text-xs text-red-300">❌ {error}</div>}

          {/* Preview */}
          {parseResult && (
            <div className="mt-4 bg-black/20 rounded-lg p-3">
              <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-2">Preview</p>
              <p className="text-sm font-bold text-white">{parseResult.metadata.title || 'Untitled'}</p>
              {parseResult.metadata.author && <p className="text-xs text-slate-400">by {parseResult.metadata.author}</p>}
              <div className="flex gap-4 mt-2 text-xs text-slate-400">
                <span>👥 <b className="text-indigo-300">{charCount}</b> characters</span>
                <span>📍 <b className="text-indigo-300">{parseResult.locations.length}</b> locations</span>
                <span>🎬 <b className="text-indigo-300">{sceneCount}</b> scenes</span>
                <span>📝 <b className="text-indigo-300">{parseResult.elements.length}</b> elements</span>
              </div>
              {charCount > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {Object.values(parseResult.characters).sort((a, b) => b.dialogueCount - a.dialogueCount).slice(0, 20).map(c => (
                    <span key={c.name} className="px-2 py-0.5 rounded-full text-[10px] bg-teal-500/10 border border-teal-500/15 text-teal-300">
                      {c.name} ({c.dialogueCount})
                    </span>
                  ))}
                </div>
              )}

              {/* Metadata fields */}
              <div className="grid grid-cols-[80px_1fr] gap-x-2 gap-y-1.5 mt-3">
                <span className="text-[10px] text-slate-500">Title</span>
                <input value={title} onChange={e => setTitle(e.target.value)} className="bg-[#0f1219] border border-white/8 rounded px-2 py-1 text-xs text-slate-300 outline-none" />
                <span className="text-[10px] text-slate-500">Author</span>
                <input value={author} onChange={e => setAuthor(e.target.value)} className="bg-[#0f1219] border border-white/8 rounded px-2 py-1 text-xs text-slate-300 outline-none" />
                <span className="text-[10px] text-slate-500">Genre</span>
                <input value={genre} onChange={e => setGenre(e.target.value)} placeholder="Drama, Thriller" className="bg-[#0f1219] border border-white/8 rounded px-2 py-1 text-xs text-slate-300 outline-none" />
              </div>
            </div>
          )}
        </div>

        {/* Folder bar — always visible */}
        <div className="flex-shrink-0 px-5 py-3 bg-indigo-500/5 border-t border-indigo-500/10">
          <div className="flex items-center gap-2">
            <span className="text-xs text-indigo-300 font-semibold whitespace-nowrap">📁 Save To:</span>
            <input
              value={projectFolder}
              onChange={e => setProjectFolder(e.target.value)}
              placeholder="Click Browse to choose project folder..."
              className="flex-1 bg-[#0f1219] border border-indigo-500/25 rounded px-3 py-1.5 text-xs text-slate-300 outline-none focus:border-indigo-500/50"
            />
            <button onClick={handleBrowse} className="px-4 py-1.5 rounded-md text-xs font-medium bg-indigo-500/15 border border-indigo-500/25 text-indigo-300 hover:bg-indigo-500/25 transition-colors whitespace-nowrap">
              Browse...
            </button>
          </div>
          <p className="text-[9px] text-indigo-400/40 mt-1">All project files will be saved here</p>
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-white/5">
          <button onClick={onClose} className="px-4 py-2 rounded-md text-xs text-slate-400 hover:text-white border border-white/8 hover:bg-white/[0.03] transition-colors">
            Cancel
          </button>
          <button onClick={handlePreview} className="px-4 py-2 rounded-md text-xs font-medium bg-white/[0.04] border border-white/8 text-slate-300 hover:bg-white/[0.08] transition-colors">
            Preview Import
          </button>
          <button
            onClick={handleImport}
            disabled={!parseResult || importing}
            className="px-5 py-2 rounded-md text-xs font-semibold bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {importing ? '⏳ Importing...' : 'Import & Create Project'}
          </button>
        </div>
      </div>
    </div>
  );
}
