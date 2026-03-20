/**
 * ImportScriptModal — import a Fountain screenplay into the pipeline.
 * Handles paste, file upload (txt/fountain/pdf), preview, metadata editing, and import.
 */
import React, { useState, useCallback, useRef } from 'react';
import { usePipeline } from '../stores/PipelineProvider';
import { parseFountainText, type ParsedScreenplay } from '../parsers/fountainParser';

interface ImportScriptModalProps {
  pipelineId: string;
  onClose: () => void;
}

type Tab = 'paste' | 'file';

const NODE_MAP = {
  metadata: 'node-4',
  characters: 'node-5',
  locations: 'node-6',
  sections: 'node-7',
  elements: 'node-10',
  assembly: 'node-15',
};

export function ImportScriptModal({ pipelineId, onClose }: ImportScriptModalProps) {
  const pipeline = usePipeline();
  const [tab, setTab] = useState<Tab>('paste');
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<ParsedScreenplay & { _rawText?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [fileStatus, setFileStatus] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Metadata overrides
  const [metaTitle, setMetaTitle] = useState('');
  const [metaAuthor, setMetaAuthor] = useState('');
  const [metaDate, setMetaDate] = useState('');
  const [metaGenre, setMetaGenre] = useState('');
  const [projectFolder, setProjectFolder] = useState('');

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    const ext = file.name.split('.').pop()?.toLowerCase();

    if (ext === 'pdf') {
      setFileStatus(`Extracting text from ${file.name}...`);
      try {
        const buffer = await file.arrayBuffer();
        const res = await fetch(`/api/app/${encodeURIComponent(pipelineId)}/extract-pdf-text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/pdf' },
          body: buffer,
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        setText(data.text);
        setTab('paste');
        setFileStatus(`Extracted ${data.pages} pages from ${file.name}`);
      } catch (err: any) {
        setError(`PDF extraction failed: ${err.message}`);
        setFileStatus(null);
      }
    } else {
      const reader = new FileReader();
      reader.onload = () => {
        setText(reader.result as string);
        setTab('paste');
        setFileStatus(`Loaded ${file.name}`);
      };
      reader.readAsText(file);
    }
  }, [pipelineId]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]);
  }, [handleFile]);

  const handlePreview = useCallback(() => {
    if (!text.trim()) {
      setError('No text to parse. Paste a screenplay or upload a file.');
      return;
    }
    setError(null);
    const result = parseFountainText(text);
    (result as any)._rawText = text;
    setParsed(result as any);

    // Fill metadata
    setMetaTitle(result.metadata.title || '');
    setMetaAuthor(result.metadata.author || '');
    setMetaDate(result.metadata.draftdate || new Date().toISOString().split('T')[0]);
  }, [text]);

  const handleBrowseFolder = useCallback(() => {
    if ((window as any).woodburyElectron?.selectFolder) {
      (window as any).woodburyElectron.selectFolder().then((folder: string) => {
        if (folder) setProjectFolder(folder);
      });
    } else if (typeof (window as any).openFolderPicker === 'function') {
      (window as any).openFolderPicker((folder: string) => {
        if (folder) setProjectFolder(folder);
      });
    }
  }, []);

  const handleImport = useCallback(async () => {
    if (!parsed) return;
    if (!projectFolder) {
      setError('Please set a project folder before importing.');
      return;
    }

    setImporting(true);
    setError(null);

    try {
      const rawText = (parsed as any)._rawText || text;
      const title = metaTitle || 'Untitled';
      const author = metaAuthor || 'Unknown';
      const draftDate = metaDate || new Date().toISOString().split('T')[0];
      const estPages = Math.max(1, Math.round(rawText.split('\n').length / 55));

      // Build character array
      const charArray = Object.values(parsed.characters).map((c, idx) => ({
        id: `char-${idx + 1}`,
        name: c.name,
        role: c.dialogueCount > 10 ? 'main' : c.dialogueCount > 3 ? 'supporting' : 'minor',
        description: '',
        traits: [] as string[],
        arc: '',
        relationships: [] as any[],
      }));

      // Build location array
      const locArray = parsed.locations.map((loc, idx) => ({
        id: `loc-${idx + 1}`,
        name: loc,
        description: '',
        type: /^(INT)/i.test(loc) ? 'interior' : 'exterior',
        mood: '',
        timeOfDay: '',
      }));

      // Build sections (group scenes into acts)
      const sceneList = parsed.sections.filter(s => s.type === 'scene');
      const actList = parsed.sections.filter(s => s.type === 'act');
      let sectionChildren: any[];

      if (actList.length > 0) {
        sectionChildren = actList.map((act, ai) => ({
          type: 'act', id: `act-${ai + 1}`, title: act.title, order: ai + 1, children: [],
        }));
        let currentAct = 0;
        const actIndices = actList.map(a => parsed.sections.indexOf(a));
        for (let si = 0; si < sceneList.length; si++) {
          const sceneIdx = parsed.sections.indexOf(sceneList[si]);
          while (currentAct + 1 < actIndices.length && sceneIdx >= actIndices[currentAct + 1]) currentAct++;
          sectionChildren[currentAct].children.push({
            type: 'scene', id: `scene-${si + 1}`, title: sceneList[si].title,
            location: sceneList[si].location || '', timeOfDay: sceneList[si].timeOfDay || '',
            order: si + 1, children: [],
            elementStart: sceneList[si].elementStart,
          });
        }
      } else {
        const scenesPerAct = Math.max(5, Math.ceil(sceneList.length / 3));
        const actNames = ['Act I', 'Act II', 'Act III', 'Act IV', 'Act V'];
        sectionChildren = [];
        for (let ai = 0; ai * scenesPerAct < sceneList.length; ai++) {
          const actScenes = sceneList.slice(ai * scenesPerAct, (ai + 1) * scenesPerAct);
          sectionChildren.push({
            type: 'act', id: `act-${ai + 1}`, title: actNames[ai] || `Act ${ai + 1}`, order: ai + 1,
            children: actScenes.map((s, idx) => ({
              type: 'scene', id: `scene-${ai * scenesPerAct + idx + 1}`, title: s.title,
              location: s.location || '', timeOfDay: s.timeOfDay || '',
              order: ai * scenesPerAct + idx + 1, children: [],
              elementStart: s.elementStart,
            })),
          });
        }
      }

      // Build elements
      const elementsArray = parsed.elements.map((el, idx) => {
        const base: any = { id: `elem-${idx + 1}`, type: el.type, content: el.content || '' };
        if (el.type === 'dialogue') {
          base.characterName = el.characterName || '';
          base.characterId = charArray.find(c => c.name === el.characterName)?.id || '';
          base.lines = el.lines || [el.content];
          base.modifiers = el.modifiers || [];
        }
        return base;
      });

      // Save project folder
      await fetch(`/api/compositions/${encodeURIComponent(pipelineId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: { projectFolder } }),
      });

      // Build project data
      const projectData = {
        version: '1.0',
        pipelineId,
        createdAt: new Date().toISOString(),
        metadata: {
          title, subtitle: null, logline: '',
          author: [{ name: author, role: 'Writer' }],
          language: 'en-US', runtimeMinutes: estPages, estimatedPages: estPages,
          genre: metaGenre ? metaGenre.split(',').map(g => g.trim()) : [],
          tone: [], audience: [], draftName: 'Imported',
          draftDate: `${draftDate}T00:00:00.000Z`, version: '1.0.0',
        },
        characters: charArray,
        locations: locArray,
        sections: sectionChildren,
        elements: elementsArray,
        previsualizations: { shots: [] },
        assets: [],
        _fountainSource: rawText,
      };

      // Clear old state then save
      await fetch(`/api/app/${encodeURIComponent(pipelineId)}/state`, { method: 'DELETE' });
      const saveRes = await fetch(`/api/app/${encodeURIComponent(pipelineId)}/project`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: projectData }),
      });
      if (!saveRes.ok) throw new Error('Failed to save project data');

      // Reload Provider data to pick up new project, then close
      await pipeline.reload();
      onClose();
    } catch (err: any) {
      setError(`Import failed: ${err.message}`);
    }
    setImporting(false);
  }, [parsed, text, projectFolder, metaTitle, metaAuthor, metaDate, metaGenre, pipelineId, pipeline, onClose]);

  const charCount = parsed ? Object.keys(parsed.characters).length : 0;
  const sceneCount = parsed ? parsed.sections.filter(s => s.type === 'scene').length : 0;
  const dialogueCount = parsed ? parsed.elements.filter(e => e.type === 'dialogue').length : 0;
  const actionCount = parsed ? parsed.elements.filter(e => e.type === 'action').length : 0;

  const S = {
    overlay: { position: 'fixed' as const, inset: 0, zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(2px)', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
    modal: { background: '#1a1f2e', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, width: 700, maxWidth: '90vw', maxHeight: '85vh', boxShadow: '0 20px 50px rgba(0,0,0,0.5)', overflow: 'hidden', display: 'flex', flexDirection: 'column' as const },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid rgba(255,255,255,0.06)' },
    headerTitle: { margin: 0, fontSize: '0.85rem', fontWeight: 600, color: '#f1f5f9' },
    closeBtn: { background: 'none', border: 'none', color: '#64748b', fontSize: '1.2rem', cursor: 'pointer', padding: '2px 6px', borderRadius: 4, lineHeight: 1 },
    body: { padding: '16px 18px', overflowY: 'auto' as const, flex: 1, minHeight: 0 },
    tab: (active: boolean) => ({ padding: '6px 14px', borderRadius: 6, fontSize: '0.72rem', fontWeight: 500, cursor: 'pointer', border: active ? '1px solid rgba(99,102,241,0.3)' : '1px solid rgba(255,255,255,0.08)', background: active ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.03)', color: active ? '#a5b4fc' : '#94a3b8', transition: 'all 0.15s' }),
    textarea: { width: '100%', height: 200, background: '#161822', border: '1px solid #1e2130', borderRadius: 6, color: '#e2e8f0', padding: 10, fontSize: '0.75rem', fontFamily: '"Courier New", monospace', resize: 'vertical' as const, outline: 'none' },
    dropzone: { border: '2px dashed rgba(99,102,241,0.25)', borderRadius: 8, padding: 30, textAlign: 'center' as const, color: '#64748b', fontSize: '0.8rem', cursor: 'pointer', transition: 'all 0.2s' },
    preview: { marginTop: 12, background: 'rgba(0,0,0,0.2)', borderRadius: 6, padding: 12 },
    previewTitle: { fontSize: '0.7rem', fontWeight: 600, color: '#94a3b8', marginBottom: 8, textTransform: 'uppercase' as const, letterSpacing: '0.05em' },
    stat: { display: 'inline-block', marginRight: 16, fontSize: '0.72rem', color: '#cbd5e1' },
    statBold: { color: '#a5b4fc' },
    charTag: { fontSize: '0.62rem', padding: '2px 6px', borderRadius: 3, background: 'rgba(94,234,212,0.1)', color: '#5eead4', border: '1px solid rgba(94,234,212,0.15)', display: 'inline-block', marginRight: 4, marginBottom: 4 },
    metaGrid: { display: 'grid', gridTemplateColumns: '100px 1fr', gap: '4px 8px', marginTop: 8 },
    metaLabel: { fontSize: '0.68rem', color: '#64748b' },
    metaInput: { width: '100%', background: '#161822', border: '1px solid #1e2130', borderRadius: 3, color: '#e2e8f0', padding: '3px 6px', fontSize: '0.68rem', outline: 'none' },
    folderBar: { flexShrink: 0, padding: '10px 18px', background: 'rgba(139,92,246,0.08)', borderTop: '1px solid rgba(139,92,246,0.15)' },
    folderRow: { display: 'flex', gap: 6, alignItems: 'center' },
    folderLabel: { fontSize: '0.72rem', color: '#c4b5fd', fontWeight: 600, whiteSpace: 'nowrap' as const },
    folderInput: { flex: 1, padding: '6px 10px', fontSize: '0.75rem', background: '#0f1219', border: '1px solid rgba(139,92,246,0.3)', borderRadius: 6, color: '#e2e8f0', outline: 'none' },
    folderHint: { fontSize: '0.6rem', color: '#7c3aed', marginTop: 3, opacity: 0.7 },
    footer: { display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 18px', borderTop: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 },
    btn: { padding: '8px 16px', borderRadius: 6, fontSize: '0.72rem', fontWeight: 500, cursor: 'pointer', border: '1px solid rgba(100,116,139,0.2)', background: 'rgba(100,116,139,0.12)', color: '#94a3b8', transition: 'all 0.15s' },
    btnPrimary: { padding: '8px 16px', borderRadius: 6, fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer', background: 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.3)', color: '#a5b4fc', transition: 'all 0.15s' },
    error: { marginTop: 8, padding: 8, background: 'rgba(248,113,113,0.08)', borderRadius: 4, color: '#f87171', fontSize: '0.72rem' },
  };

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={S.header}>
          <h3 style={S.headerTitle}>Import Screenplay</h3>
          <button onClick={onClose} style={S.closeBtn}>&times;</button>
        </div>

        {/* Body */}
        <div style={S.body}>
          {/* Tabs */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            <button onClick={() => setTab('paste')} style={S.tab(tab === 'paste')}>Paste Text</button>
            <button onClick={() => setTab('file')} style={S.tab(tab === 'file')}>Upload File</button>
          </div>

          {/* Paste tab */}
          {tab === 'paste' && (
            <textarea
              value={text}
              onChange={e => { setText(e.target.value); setParsed(null); }}
              placeholder={'Paste Fountain-formatted screenplay text here...\n\nTitle: My Screenplay\nAuthor: Your Name\n\nINT. KITCHEN - DAY\n\nAction description.\n\nCHARACTER\nDialogue here.'}
              style={S.textarea}
            />
          )}

          {/* File tab */}
          {tab === 'file' && (
            <div onDragOver={e => e.preventDefault()} onDrop={handleDrop} onClick={() => fileRef.current?.click()} style={S.dropzone}>
              {fileStatus ? (
                <p style={{ fontSize: '0.75rem', color: '#5eead4' }}>{fileStatus}</p>
              ) : (
                <>
                  <p style={{ fontSize: '0.8rem', color: '#64748b' }}>Drop a .fountain, .txt, or .pdf file here</p>
                  <p style={{ fontSize: '0.7rem', marginTop: 4, color: '#475569' }}>or click to browse</p>
                </>
              )}
              <input ref={fileRef} type="file" accept=".fountain,.txt,.pdf,.fdx" style={{ display: 'none' }} onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])} />
            </div>
          )}

          {/* Error */}
          {error && <div style={S.error}>{error}</div>}

          {/* Preview */}
          {parsed && (
            <div style={S.preview}>
              <div style={S.previewTitle}>Parse Results</div>
              <div>
                <span style={S.stat}><b style={S.statBold}>{sceneCount}</b> scenes</span>
                <span style={S.stat}><b style={S.statBold}>{charCount}</b> characters</span>
                <span style={S.stat}><b style={S.statBold}>{dialogueCount}</b> dialogue</span>
                <span style={S.stat}><b style={S.statBold}>{actionCount}</b> action</span>
                <span style={S.stat}><b style={S.statBold}>{parsed.locations.length}</b> locations</span>
              </div>
              {charCount > 0 && (
                <div style={{ marginTop: 8 }}>
                  {Object.values(parsed.characters)
                    .sort((a, b) => b.dialogueCount - a.dialogueCount)
                    .slice(0, 20)
                    .map(c => (
                      <span key={c.name} style={S.charTag}>{c.name} ({c.dialogueCount})</span>
                    ))}
                </div>
              )}
            </div>
          )}

          {/* Metadata */}
          {parsed && (
            <div style={{ marginTop: 12 }}>
              <div style={S.previewTitle}>Metadata</div>
              <div style={S.metaGrid}>
                <span style={S.metaLabel}>Title</span>
                <input value={metaTitle} onChange={e => setMetaTitle(e.target.value)} style={S.metaInput} />
                <span style={S.metaLabel}>Author</span>
                <input value={metaAuthor} onChange={e => setMetaAuthor(e.target.value)} style={S.metaInput} />
                <span style={S.metaLabel}>Draft Date</span>
                <input type="date" value={metaDate} onChange={e => setMetaDate(e.target.value)} style={S.metaInput} />
                <span style={S.metaLabel}>Genre</span>
                <input value={metaGenre} onChange={e => setMetaGenre(e.target.value)} placeholder="e.g. Drama, Thriller" style={S.metaInput} />
              </div>
            </div>
          )}
        </div>

        {/* Folder bar */}
        {parsed && (
          <div style={S.folderBar}>
            <div style={S.folderRow}>
              <span style={S.folderLabel}>📁 Save To:</span>
              <input value={projectFolder} onChange={e => setProjectFolder(e.target.value)} placeholder="Click Browse to choose project folder..." style={S.folderInput} />
              <button onClick={handleBrowseFolder} style={{ ...S.btnPrimary, padding: '6px 16px', whiteSpace: 'nowrap' as const }}>Browse...</button>
            </div>
            <div style={S.folderHint}>All project files (images, audio, renders) will be saved here</div>
          </div>
        )}

        {/* Footer */}
        <div style={S.footer}>
          <button onClick={onClose} style={S.btn}>Cancel</button>
          {!parsed && (
            <button onClick={handlePreview} style={S.btn}>Preview Import</button>
          )}
          <button
            onClick={handleImport}
            disabled={!parsed || importing}
            style={{ ...S.btnPrimary, opacity: (!parsed || importing) ? 0.5 : 1, cursor: (!parsed || importing) ? 'not-allowed' : 'pointer' }}
          >
            {importing ? 'Importing...' : 'Import & Create Project'}
          </button>
        </div>
      </div>
    </div>
  );
}
