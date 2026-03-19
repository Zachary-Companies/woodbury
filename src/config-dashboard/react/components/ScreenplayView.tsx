/**
 * ScreenplayView — React component replacing the 2000-line vanilla JS screenplay renderer.
 * Displays scenes with dialogue, action, characters, and locations.
 */
import React, { useState, useMemo, useRef, useCallback } from 'react';
import { usePipelineStore, enrichEntity, generateAssets, type Character, type Location, type Section, type Element } from '../stores/pipeline-store';

// ── Character color hash ─────────────────────────────────────

function charColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const colors = ['#f472b6','#a78bfa','#60a5fa','#34d399','#fbbf24','#f87171','#38bdf8','#a3e635','#e879f9','#fb923c'];
  return colors[Math.abs(hash) % colors.length];
}

// ── Scene Strip ──────────────────────────────────────────────

function SceneStrip({ scenes, activeScene, onSelect }: {
  scenes: { id: string; title: string; actTitle?: string }[];
  activeScene: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex overflow-x-auto gap-1 py-2 px-1 bg-[#0c0e14] border-b border-[#1e2130]" style={{ scrollbarWidth: 'thin' }}>
      {scenes.map(s => (
        <button
          key={s.id}
          onClick={() => onSelect(s.id)}
          className={`px-3 py-1 rounded text-[11px] whitespace-nowrap flex-shrink-0 transition-all ${
            activeScene === s.id
              ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/30'
              : 'bg-white/[0.02] text-slate-500 border border-transparent hover:bg-white/[0.04] hover:text-slate-300'
          }`}
        >
          {s.title.length > 20 ? s.title.substring(0, 20) + '...' : s.title}
        </button>
      ))}
    </div>
  );
}

// ── Dialogue Block ───────────────────────────────────────────

function DialogueBlock({ element, character, onEdit }: { element: Element; character?: Character; onEdit?: (id: string, field: string, value: string) => void }) {
  const name = element.characterName || 'UNKNOWN';
  const color = charColor(name);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');

  const handleDoubleClick = () => {
    setEditText(element.lines?.join('\n') || element.content || '');
    setEditing(true);
  };

  const handleSave = () => {
    if (onEdit) onEdit(element.id, 'content', editText);
    setEditing(false);
  };

  return (
    <div className="my-3 ml-16 group">
      <div className="flex items-center gap-2 mb-0.5" style={{ borderLeft: `3px solid ${color}`, paddingLeft: 10 }}>
        {character?.imagePath && (
          <img
            src={`/api/file?path=${encodeURIComponent(character.imagePath)}`}
            className="w-6 h-6 rounded-full object-cover border border-white/10 flex-shrink-0"
            alt=""
          />
        )}
        <span className="text-xs font-bold uppercase tracking-wider" style={{ color }}>
          {name}
        </span>
        {element.modifiers && element.modifiers.length > 0 && (
          <span className="text-[10px] text-slate-500 italic">
            ({element.modifiers.join(', ')})
          </span>
        )}
      </div>
      {editing ? (
        <div className="ml-[13px] pl-3 mt-1">
          <textarea
            value={editText}
            onChange={e => setEditText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) handleSave(); if (e.key === 'Escape') setEditing(false); }}
            className="w-full bg-[#0f1219] border border-indigo-500/30 rounded px-2 py-1 text-[13px] text-slate-300 outline-none resize-y min-h-[40px]"
            autoFocus
          />
          <div className="flex gap-1 mt-1">
            <button onClick={handleSave} className="px-2 py-0.5 rounded text-[10px] bg-indigo-500/15 text-indigo-300 border border-indigo-500/25">Save (⌘↵)</button>
            <button onClick={() => setEditing(false)} className="px-2 py-0.5 rounded text-[10px] text-slate-500 border border-white/5">Cancel</button>
          </div>
        </div>
      ) : (
        <div className="ml-[13px] pl-3 text-[13px] text-slate-300 leading-relaxed cursor-text" onDoubleClick={handleDoubleClick} title="Double-click to edit">
          {element.lines ? element.lines.map((line, i) => (
            <p key={i} className="mb-0.5">{line}</p>
          )) : <p>{element.content}</p>}
        </div>
      )}
    </div>
  );
}

// ── Action Block ─────────────────────────────────────────────

function ActionBlock({ element }: { element: Element }) {
  return (
    <p className="text-sm text-slate-400 leading-relaxed my-2 px-4">
      {element.content}
    </p>
  );
}

// ── Transition Block ─────────────────────────────────────────

function TransitionBlock({ element }: { element: Element }) {
  return (
    <p className="text-xs text-purple-400/60 italic text-right my-3 px-4">
      {element.content}
    </p>
  );
}

// ── Scene Card ───────────────────────────────────────────────

function SceneCard({ scene, elements, charMap, locMap }: {
  scene: Section;
  elements: Element[];
  charMap: Record<string, Character>;
  locMap: Record<string, Location>;
}) {
  const location = scene.location ? (locMap[scene.location] || locMap[scene.location.toUpperCase()]) : null;
  const heading = scene.title || '';

  return (
    <div className="mb-6 rounded-lg border border-white/5 bg-[#111827]/60 overflow-hidden" id={`scene-${scene.id}`}>
      {/* Location banner */}
      {location?.imagePath && (
        <div className="w-full h-[120px] overflow-hidden">
          <img
            src={`/api/file?path=${encodeURIComponent(location.imagePath)}`}
            className="w-full h-full object-cover opacity-70 hover:opacity-100 transition-opacity"
            alt={scene.location || ''}
          />
        </div>
      )}

      {/* Scene heading */}
      <div className="bg-[#1a1d2e] px-4 py-2.5 border-b border-white/5">
        <h3 className="text-sm font-bold text-white tracking-wide">
          {heading}
        </h3>
      </div>

      {/* Elements */}
      <div className="py-2">
        {elements.map(elem => {
          switch (elem.type) {
            case 'dialogue': {
              const char = charMap[elem.characterName || ''] || charMap[elem.characterId || ''];
              return <DialogueBlock key={elem.id} element={elem} character={char} />;
            }
            case 'action':
              return <ActionBlock key={elem.id} element={elem} />;
            case 'transition':
              return <TransitionBlock key={elem.id} element={elem} />;
            default:
              return <ActionBlock key={elem.id} element={elem} />;
          }
        })}
      </div>
    </div>
  );
}

// ── Toolbar ──────────────────────────────────────────────────

function Toolbar({ projectData, onAction }: {
  projectData: any;
  onAction: (action: string) => void;
}) {
  const charCount = projectData?.characters?.length || 0;
  const locCount = projectData?.locations?.length || 0;

  return (
    <div className="flex items-center gap-2 flex-wrap py-2">
      <button onClick={() => onAction('show-characters')} className="px-3 py-1.5 rounded-md text-xs font-medium bg-white/[0.04] border border-white/8 text-slate-300 hover:bg-white/[0.08] transition-colors">
        👥 Characters ({charCount})
      </button>
      <button onClick={() => onAction('show-locations')} className="px-3 py-1.5 rounded-md text-xs font-medium bg-white/[0.04] border border-white/8 text-slate-300 hover:bg-white/[0.08] transition-colors">
        📍 Locations ({locCount})
      </button>
      <button onClick={() => onAction('enrich-characters')} className="px-3 py-1.5 rounded-md text-xs font-medium bg-purple-500/10 border border-purple-500/20 text-purple-300 hover:bg-purple-500/20 transition-colors">
        ✨ Enrich Characters
      </button>
      <button onClick={() => onAction('enrich-locations')} className="px-3 py-1.5 rounded-md text-xs font-medium bg-purple-500/10 border border-purple-500/20 text-purple-300 hover:bg-purple-500/20 transition-colors">
        ✨ Enrich Locations
      </button>
      <button onClick={() => onAction('generate-headshots')} className="px-3 py-1.5 rounded-md text-xs font-medium bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 hover:bg-emerald-500/20 transition-colors">
        🖼 Generate Headshots
      </button>
      <button onClick={() => onAction('generate-locations')} className="px-3 py-1.5 rounded-md text-xs font-medium bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 hover:bg-emerald-500/20 transition-colors">
        🌍 Location Shots
      </button>
      <button onClick={() => onAction('render-dialogue')} className="px-3 py-1.5 rounded-md text-xs font-medium bg-amber-500/10 border border-amber-500/20 text-amber-300 hover:bg-amber-500/20 transition-colors">
        🔊 Render All Dialogue
      </button>
    </div>
  );
}

// ── Main ScreenplayView ──────────────────────────────────────

export function ScreenplayView() {
  const { projectData, loading, error, pipelineId } = usePipelineStore();
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Build character/location lookup maps
  const charMap = useMemo(() => {
    const map: Record<string, Character> = {};
    for (const c of projectData?.characters || []) {
      map[c.id] = c;
      if (c.name) { map[c.name] = c; map[c.name.toUpperCase()] = c; }
      if (c.displayName) map[c.displayName] = c;
    }
    return map;
  }, [projectData?.characters]);

  const locMap = useMemo(() => {
    const map: Record<string, Location> = {};
    for (const l of projectData?.locations || []) {
      map[l.id] = l;
      if (l.name) { map[l.name] = l; map[l.name.toUpperCase()] = l; }
    }
    return map;
  }, [projectData?.locations]);

  // Flatten sections into scenes
  const scenes = useMemo(() => {
    const result: Array<Section & { actTitle?: string }> = [];
    function flatten(secs: Section[], actTitle?: string) {
      for (const s of secs) {
        if (s.type === 'scene') result.push({ ...s, actTitle });
        if (s.children) flatten(s.children, s.type === 'act' ? s.title : actTitle);
      }
    }
    flatten(projectData?.sections || []);
    return result;
  }, [projectData?.sections]);

  // Group elements by scene using scene heading matching
  const sceneElements = useMemo(() => {
    const all = projectData?.elements || [];
    if (scenes.length === 0) return new Map<string, Element[]>();

    const map = new Map<string, Element[]>();
    // Initialize empty arrays for all scenes
    scenes.forEach((scene, i) => map.set(scene.id || `scene-${i}`, []));

    // Strategy: walk through elements and assign to scenes based on
    // finding action elements that match scene headings
    let currentSceneIdx = 0;
    const sceneHeadings = scenes.map(s => (s.title || '').toUpperCase().trim());

    for (const elem of all) {
      // Check if this element is a scene heading (matches a scene title)
      if (elem.type === 'action' && elem.content) {
        const upper = elem.content.toUpperCase().trim();
        const matchIdx = sceneHeadings.findIndex((h, i) => i >= currentSceneIdx && (h === upper || upper.startsWith(h.substring(0, 20))));
        if (matchIdx >= 0 && matchIdx >= currentSceneIdx) {
          currentSceneIdx = matchIdx;
          // Don't add the heading itself as an element (it's the scene card title)
          continue;
        }
      }

      const sceneId = scenes[currentSceneIdx]?.id || `scene-${currentSceneIdx}`;
      const arr = map.get(sceneId);
      if (arr) arr.push(elem);
    }

    return map;
  }, [scenes, projectData?.elements]);

  // Handle toolbar actions
  const handleAction = useCallback(async (action: string) => {
    setActionStatus(`Running: ${action}...`);
    try {
      switch (action) {
        case 'enrich-characters':
          for (const c of projectData?.characters || []) {
            if (!c.description || c.description.length < 20) {
              setActionStatus(`Enriching ${c.name}...`);
              await enrichEntity('characters', c.id);
            }
          }
          break;
        case 'enrich-locations':
          for (const l of projectData?.locations || []) {
            if (!l.description || l.description.length < 20) {
              setActionStatus(`Enriching ${l.name}...`);
              await enrichEntity('locations', l.id);
            }
          }
          break;
        case 'generate-headshots':
          await generateAssets('characters');
          break;
        case 'generate-locations':
          await generateAssets('locations');
          break;
      }
      setActionStatus(null);
    } catch (err: any) {
      setActionStatus(`Error: ${err.message}`);
      setTimeout(() => setActionStatus(null), 3000);
    }
  }, [projectData]);

  // Scroll to scene
  const scrollToScene = useCallback((id: string) => {
    setActiveSceneId(id);
    const el = document.getElementById(`scene-${id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  if (loading) {
    return <div className="flex items-center justify-center h-full text-slate-500 text-sm">Loading screenplay...</div>;
  }

  if (error) {
    return <div className="flex items-center justify-center h-full text-red-400 text-sm">{error}</div>;
  }

  if (!projectData || !projectData.elements?.length) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-500 gap-4">
        <p className="text-sm">No screenplay data. Import a script or run the pipeline.</p>
      </div>
    );
  }

  const title = projectData.metadata?.title || 'Untitled';
  const subtitle = projectData.metadata?.logline || '';
  const sceneCount = scenes.length;
  const elementCount = projectData.elements.length;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 px-4 pt-4 pb-2">
        <h1 className="text-xl font-bold text-white">{title}</h1>
        {subtitle && <p className="text-xs text-slate-400 mt-1 italic">{subtitle}</p>}
        <div className="flex gap-3 mt-2 text-[11px] text-slate-500">
          <span>{scenes.length > 0 ? `${new Set(scenes.map(s => s.actTitle).filter(Boolean)).size} Acts` : ''}</span>
          <span>{sceneCount} Scenes</span>
          <span>{elementCount} Elements</span>
          <span>{projectData.characters.length} Characters</span>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex-shrink-0 px-4">
        <Toolbar projectData={projectData} onAction={handleAction} />
      </div>

      {/* Status bar */}
      {actionStatus && (
        <div className="flex-shrink-0 px-4 py-1.5 bg-amber-500/10 border-y border-amber-500/15 text-xs text-amber-300">
          ⏳ {actionStatus}
        </div>
      )}

      {/* Scene strip */}
      <div className="flex-shrink-0">
        <SceneStrip
          scenes={scenes.map((s, i) => ({ id: s.id || `scene-${i}`, title: s.title, actTitle: s.actTitle }))}
          activeScene={activeSceneId}
          onSelect={scrollToScene}
        />
      </div>

      {/* Content */}
      <div ref={contentRef} className="flex-1 overflow-y-auto px-4 py-4">
        {/* Group by acts */}
        {(() => {
          let currentAct = '';
          return scenes.map((scene, i) => {
            const id = scene.id || `scene-${i}`;
            const elements = sceneElements.get(id) || [];
            const showActHeader = scene.actTitle && scene.actTitle !== currentAct;
            if (scene.actTitle) currentAct = scene.actTitle;

            return (
              <React.Fragment key={id}>
                {showActHeader && (
                  <h2 className="text-sm font-bold text-indigo-400 uppercase tracking-wider mt-6 mb-3">
                    {scene.actTitle}
                  </h2>
                )}
                <SceneCard scene={scene} elements={elements} charMap={charMap} locMap={locMap} />
              </React.Fragment>
            );
          });
        })()}
      </div>
    </div>
  );
}
