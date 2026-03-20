/**
 * ScreenplayView — Renders screenplay data grouped by scene.
 * Each scene contains its own dialogue, actions, shots, and character list.
 * Uses project.scenes[] (computed by buildScenes) as the data source.
 */
import React, { useState, useMemo, useRef, useCallback } from 'react';
import { usePipeline, type Character, type Location, type SceneData, type SceneShot, type SceneDialogue } from '../stores/PipelineProvider';
import { ImageZoom } from './ImageZoom';

// Inject spinner keyframe once
if (typeof document !== 'undefined' && !document.getElementById('previs-spinner-css')) {
  const style = document.createElement('style');
  style.id = 'previs-spinner-css';
  style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(style);
}

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
  let lastAct = '';
  return (
    <div className="flex overflow-x-auto gap-1 py-2 px-1 bg-[#0c0e14] border-b border-[#1e2130]" style={{ scrollbarWidth: 'thin', alignItems: 'center' }}>
      {scenes.map((s, idx) => {
        const showActLabel = s.actTitle && s.actTitle !== lastAct;
        if (s.actTitle) lastAct = s.actTitle;
        return (
          <React.Fragment key={s.id}>
            {showActLabel && (
              <span style={{
                fontSize: 9, fontWeight: 700, color: '#7c3aed', textTransform: 'uppercase',
                letterSpacing: '0.05em', whiteSpace: 'nowrap', flexShrink: 0,
                padding: '2px 6px', marginLeft: idx > 0 ? 8 : 0,
                borderLeft: idx > 0 ? '1px solid rgba(139,92,246,0.2)' : 'none',
                paddingLeft: idx > 0 ? 12 : 6,
              }}>
                {s.actTitle}
              </span>
            )}
            <button
              onClick={() => onSelect(s.id)}
              className={`px-3 py-1 rounded text-[11px] whitespace-nowrap flex-shrink-0 transition-all ${
                activeScene === s.id
                  ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/30'
                  : 'bg-white/[0.02] text-slate-500 border border-transparent hover:bg-white/[0.04] hover:text-slate-300'
              }`}
            >
              {s.title.length > 20 ? s.title.substring(0, 20) + '...' : s.title}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ── Dialogue Block ───────────────────────────────────────────

function DialogueBlock({ dialogue, character }: { dialogue: SceneDialogue; character?: Character }) {
  const name = dialogue.characterName || 'UNKNOWN';
  const color = charColor(name);

  return (
    <div className="my-3 ml-16">
      <div className="flex items-center gap-2 mb-0.5" style={{ borderLeft: `3px solid ${color}`, paddingLeft: 10 }}>
        {character?.imagePath && (
          <ImageZoom
            src={`/api/file?path=${encodeURIComponent(character.imagePath)}`}
            className="w-6 h-6 rounded-full object-cover border border-white/10 flex-shrink-0"
            alt={character.name}
          />
        )}
        <span className="text-xs font-bold uppercase tracking-wider" style={{ color }}>
          {name}
        </span>
        {dialogue.modifiers && dialogue.modifiers.length > 0 && (
          <span className="text-[10px] text-slate-500 italic">
            ({dialogue.modifiers.join(', ')})
          </span>
        )}
      </div>
      <div className="ml-[13px] pl-3 text-[13px] text-slate-300 leading-relaxed">
        {dialogue.lines.map((line, i) => (
          <p key={i} className="mb-0.5">{line}</p>
        ))}
      </div>
    </div>
  );
}

// ── Shot Block ───────────────────────────────────────────────

function ShotBlock({ shot, onGenerate, isGenerating }: {
  shot: SceneShot;
  onGenerate?: (shotId: string) => void;
  isGenerating?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const imgPath = shot.previsPath;

  return (
    <div
      className="my-2 px-4"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        {/* Previs thumbnail or loading */}
        {(imgPath || isGenerating) && (
          <div style={{ flexShrink: 0, position: 'relative' }}>
            {imgPath ? (
              <ImageZoom
                src={`/api/file?path=${encodeURIComponent(imgPath)}`}
                alt={shot.description || 'Shot'}
                style={{
                  width: 160, height: 90, objectFit: 'cover', borderRadius: 6,
                  border: '1px solid rgba(139,92,246,0.2)',
                  opacity: isGenerating ? 0.4 : 1, transition: 'opacity 0.3s',
                }}
              />
            ) : (
              <div style={{
                width: 160, height: 90, borderRadius: 6,
                background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.2)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <div style={{
                  width: 20, height: 20, borderRadius: '50%',
                  border: '2px solid rgba(139,92,246,0.3)', borderTopColor: '#a78bfa',
                  animation: 'spin 1s linear infinite',
                }} />
              </div>
            )}
            {isGenerating && (
              <div style={{
                position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(0,0,0,0.3)', borderRadius: 6,
              }}>
                <span style={{ fontSize: 10, color: '#c4b5fd', fontWeight: 500 }}>Generating...</span>
              </div>
            )}
          </div>
        )}
        {/* Shot description */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 13, color: isGenerating ? '#c4b5fd' : '#94a3b8', lineHeight: 1.6, fontStyle: 'italic', transition: 'color 0.3s' }}>
            <span style={{ color: '#a78bfa', fontWeight: 600, fontStyle: 'normal' }}>
              {shot.shotType}
            </span>
            <span> — {shot.description}</span>
          </p>
        </div>
        {/* Generate button */}
        {onGenerate && !isGenerating && (
          <button
            onClick={() => onGenerate(shot.id)}
            style={{
              flexShrink: 0, padding: '3px 10px', borderRadius: 4, fontSize: 10, fontWeight: 500,
              background: imgPath ? 'rgba(139,92,246,0.08)' : 'rgba(139,92,246,0.12)',
              border: `1px solid rgba(139,92,246,${imgPath ? '0.15' : '0.25'})`,
              color: '#a78bfa', cursor: 'pointer', whiteSpace: 'nowrap' as const,
              opacity: hovered || !imgPath ? 1 : 0, transition: 'opacity 0.15s',
            }}
            title={imgPath ? 'Regenerate previs image' : 'Generate previs image'}
          >
            {imgPath ? '🔄 Redo' : '🎬 Previs'}
          </button>
        )}
        {isGenerating && (
          <span style={{ flexShrink: 0, fontSize: 10, color: '#a78bfa', fontWeight: 500, padding: '3px 10px' }}>
            ⏳ Generating...
          </span>
        )}
      </div>
    </div>
  );
}

// ── Scene Card ───────────────────────────────────────────────

const SceneCard = React.memo(function SceneCard({ scene, charMap, locMap, pipelineId }: {
  scene: SceneData;
  charMap: Record<string, Character>;
  locMap: Record<string, Location>;
  pipelineId: string;
}) {
  const pipeline = usePipeline();
  const location = scene.locationId ? locMap[scene.locationId] : (scene.location ? (locMap[scene.location] || locMap[scene.location.toUpperCase()]) : null);
  const [generatingSet, setGeneratingSet] = useState<Set<string>>(new Set());
  const [genStatus, setGenStatus] = useState<string | null>(null);

  const handleGeneratePrevis = async (shotId: string) => {
    setGeneratingSet(prev => new Set(prev).add(shotId));
    try {
      // Send scene context along with the shot ID for better reference resolution
      await fetch(`/api/app/${encodeURIComponent(pipelineId)}/generate-previs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elementId: shotId,
          sceneId: scene.id,
          sceneLocation: scene.location,
          sceneLocationId: scene.locationId,
        }),
      });
      await pipeline.reload();
    } catch {}
    setGeneratingSet(prev => { const next = new Set(prev); next.delete(shotId); return next; });
  };

  // Generate shot descriptions for this scene using AI
  const handleGenerateShotDescriptions = async () => {
    setGenStatus('Generating shot descriptions...');
    try {
      const sceneText = [
        ...scene.actions,
        ...scene.dialogue.map(d => `${d.characterName}: ${d.lines.join(' ')}`),
      ].join('\n');

      const charNames = scene.characterIds
        .map(id => charMap[id]?.name)
        .filter(Boolean);

      const prompt = `You are a cinematographer breaking down a screenplay scene into camera shots for pre-visualization.

Scene: ${scene.title}
Location: ${scene.location}
Characters present: ${charNames.join(', ') || 'unknown'}

Scene content:
${sceneText.substring(0, 2000)}

Generate 3-6 camera shot descriptions as a JSON array. Each entry has:
- "shot": the shot type (WIDE SHOT, MEDIUM SHOT, CLOSE-UP, EXTREME CLOSE-UP, TWO SHOT, etc.)
- "description": vivid description of what the camera captures (lighting, depth, composition, character actions/emotions)
- "characters": array of character names visible in this shot (use EXACT names from the characters list above)

Rules:
- Cover the key dramatic beats of the scene
- Think cinematically — describe lighting, depth, composition
- Use ONLY character names from the list above

Return ONLY a JSON array, no markdown, no explanation.`;

      const res = await fetch('/api/chat/one-shot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: prompt }),
      });
      const data = await res.json();

      let shotEntries: Array<{ shot: string; description: string; characters?: string[] }> = [];
      try {
        const match = (data.response || '').match(/\[[\s\S]*\]/);
        if (match) shotEntries = JSON.parse(match[0]);
      } catch {}

      if (shotEntries.length === 0) {
        setGenStatus('No shot descriptions generated');
        setTimeout(() => setGenStatus(null), 2000);
        return;
      }

      // Build character name→id map
      const charNameToId: Record<string, string> = {};
      for (const c of pipeline.project?.characters || []) {
        if (c.name) charNameToId[c.name.toUpperCase()] = c.id;
        if (c.displayName) charNameToId[c.displayName.toUpperCase()] = c.id;
      }

      // Create SceneShot objects
      const newShots: SceneShot[] = shotEntries.map((entry, i) => ({
        id: `shot_${scene.id}_${Date.now()}_${i}`,
        shotType: entry.shot,
        description: entry.description,
        characterIds: (entry.characters || [])
          .map(name => charNameToId[(name || '').toUpperCase()])
          .filter(Boolean),
      }));

      // Update the scene's shots in project data
      const project = pipeline.project;
      if (project) {
        const updatedScenes = (project.scenes || []).map(s =>
          s.id === scene.id ? { ...s, shots: [...s.shots, ...newShots] } : s
        );
        const updatedProject = { ...project, scenes: updatedScenes };

        setGenStatus(`Added ${newShots.length} shots. Saving...`);
        await fetch(`/api/app/${encodeURIComponent(pipelineId)}/project`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: updatedProject }),
        });
        await pipeline.reload();
      }
      setGenStatus(null);
    } catch (err: any) {
      setGenStatus(`Error: ${err.message}`);
      setTimeout(() => setGenStatus(null), 3000);
    }
  };

  const hasShots = scene.shots.length > 0;

  return (
    <div className="mb-6 rounded-lg border border-white/5 bg-[#111827]/60 overflow-hidden" id={`scene-${scene.id}`}>
      {/* Location banner */}
      {location?.imagePath && (
        <div className="w-full h-[120px] overflow-hidden">
          <ImageZoom
            src={`/api/file?path=${encodeURIComponent(location.imagePath)}`}
            className="w-full h-full object-cover"
            style={{ opacity: 0.7 }}
            alt={scene.location || ''}
          />
        </div>
      )}

      {/* Previs strip — show generated previs images */}
      {scene.shots.some(s => s.previsPath) && (
        <div style={{ display: 'flex', gap: 4, padding: '6px 12px', overflowX: 'auto', background: 'rgba(0,0,0,0.2)' }}>
          {scene.shots.filter(s => s.previsPath).map((shot, i) => (
            <ImageZoom
              key={shot.id}
              src={`/api/file?path=${encodeURIComponent(shot.previsPath!)}`}
              alt={shot.description || `Shot ${i + 1}`}
              style={{ width: 120, height: 68, objectFit: 'cover', borderRadius: 4, flexShrink: 0, border: '1px solid rgba(139,92,246,0.2)' }}
            />
          ))}
        </div>
      )}

      {/* Scene heading */}
      <div className="bg-[#1a1d2e] px-4 py-2.5 border-b border-white/5" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h3 className="text-sm font-bold text-white tracking-wide">{scene.title}</h3>
          {scene.characterIds.length > 0 && (
            <div className="flex gap-1 mt-1">
              {scene.characterIds.slice(0, 6).map(cid => {
                const c = charMap[cid];
                return c ? (
                  <span key={cid} className="text-[9px] px-1.5 py-0.5 rounded bg-white/[0.04] text-slate-500">{c.name}</span>
                ) : null;
              })}
              {scene.characterIds.length > 6 && (
                <span className="text-[9px] px-1.5 py-0.5 text-slate-600">+{scene.characterIds.length - 6}</span>
              )}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {genStatus && <span style={{ fontSize: 10, color: '#a78bfa' }}>{genStatus}</span>}
          {!genStatus && generatingSet.size > 0 && <span style={{ fontSize: 10, color: '#a78bfa' }}>⏳ {generatingSet.size} generating...</span>}
          {!genStatus && (
            <>
              <button
                onClick={handleGenerateShotDescriptions}
                style={{
                  padding: '3px 10px', borderRadius: 4, fontSize: 10, fontWeight: 500,
                  background: 'rgba(139,92,246,0.12)', border: '1px solid rgba(139,92,246,0.25)',
                  color: '#c4b5fd', cursor: 'pointer', whiteSpace: 'nowrap',
                }}
              >
                🎬 {hasShots ? 'Regen Shots' : 'Generate Shots'}
              </button>
              {hasShots && (
                <button
                  onClick={async () => {
                    setGenStatus(`Rendering ${scene.shots.length} shots...`);
                    for (let i = 0; i < scene.shots.length; i++) {
                      setGenStatus(`Rendering ${i + 1}/${scene.shots.length}...`);
                      await handleGeneratePrevis(scene.shots[i].id);
                    }
                    setGenStatus(null);
                  }}
                  style={{
                    padding: '3px 10px', borderRadius: 4, fontSize: 10, fontWeight: 500,
                    background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.25)',
                    color: '#6ee7b7', cursor: 'pointer', whiteSpace: 'nowrap',
                  }}
                >
                  🖼 Render Previs
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Scene content: actions, dialogue, shots interleaved in natural order */}
      <div className="py-2">
        {/* Actions (scene description) */}
        {scene.actions.map((text, i) => (
          <div key={`action-${i}`} className="my-2 px-4">
            <p className="text-sm text-slate-400 leading-relaxed">{text}</p>
          </div>
        ))}

        {/* Dialogue */}
        {scene.dialogue.map((d, i) => (
          <DialogueBlock key={d.elementId || `dlg-${i}`} dialogue={d} character={charMap[d.characterId]} />
        ))}

        {/* Shots */}
        {scene.shots.length > 0 && (
          <div className="mt-3 pt-3 border-t border-white/5">
            <div className="px-4 mb-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-600">Camera Shots</span>
            </div>
            {scene.shots.map(shot => (
              <ShotBlock
                key={shot.id}
                shot={shot}
                onGenerate={handleGeneratePrevis}
                isGenerating={generatingSet.has(shot.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}, (prev, next) => {
  return prev.scene.id === next.scene.id
    && prev.scene.shots.length === next.scene.shots.length
    && prev.scene.dialogue.length === next.scene.dialogue.length
    && prev.pipelineId === next.pipelineId;
});

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
      <button onClick={() => onAction('generate-previs')} className="px-3 py-1.5 rounded-md text-xs font-medium bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 hover:bg-indigo-500/20 transition-colors">
        🎬 Generate Previs
      </button>
      <button onClick={() => onAction('render-dialogue')} className="px-3 py-1.5 rounded-md text-xs font-medium bg-amber-500/10 border border-amber-500/20 text-amber-300 hover:bg-amber-500/20 transition-colors">
        🔊 Render All Dialogue
      </button>
    </div>
  );
}

// ── Main ScreenplayView ──────────────────────────────────────

export function ScreenplayView() {
  const pipeline = usePipeline();
  const { project: projectData, loading, error, pipelineId } = pipeline;
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);

  // Character/location lookup maps
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

  // Use project.scenes directly
  const scenes = projectData?.scenes || [];

  // Handle toolbar actions
  const handleAction = useCallback(async (action: string) => {
    if (action === 'show-characters' || action === 'show-locations') {
      window.dispatchEvent(new CustomEvent('woodbury:switch-view', { detail: { view: 'data' } }));
      return;
    }

    setActionStatus(`Running: ${action}...`);
    try {
      switch (action) {
        case 'enrich-characters':
          for (const c of projectData?.characters || []) {
            if (!c.description || c.description.length < 20) {
              setActionStatus(`Enriching ${c.name}...`);
              await pipeline.enrichCharacter(c.id);
            }
          }
          break;
        case 'enrich-locations':
          for (const l of projectData?.locations || []) {
            if (!l.description || l.description.length < 20) {
              setActionStatus(`Enriching ${l.name}...`);
              await pipeline.enrichLocation(l.id);
            }
          }
          break;
        case 'generate-headshots':
          setActionStatus(`Generating headshots...`);
          await pipeline.generateCharacterImages();
          break;
        case 'generate-locations':
          setActionStatus(`Generating location shots...`);
          await pipeline.generateLocationImages();
          break;
        case 'generate-previs': {
          const allShots = scenes.flatMap(s => s.shots);
          setActionStatus(`Generating previs for ${allShots.length} shots...`);
          for (let i = 0; i < allShots.length; i++) {
            setActionStatus(`Previs ${i + 1}/${allShots.length}...`);
            try {
              await fetch(`/api/app/${encodeURIComponent(pipelineId)}/generate-previs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ elementId: allShots[i].id }),
              });
              await pipeline.reload();
            } catch {}
          }
          break;
        }
        case 'render-dialogue':
          setActionStatus('Rendering dialogue audio...');
          await fetch(`/api/app/${encodeURIComponent(pipelineId)}/render-dialogue`, { method: 'POST' });
          break;
      }
      setActionStatus(null);
    } catch (err: any) {
      setActionStatus(`Error: ${err.message}`);
      setTimeout(() => setActionStatus(null), 3000);
    }
  }, [projectData, pipelineId, pipeline, scenes]);

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
  if (!projectData || scenes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-500 gap-4">
        <p className="text-sm">No screenplay data. Import a script or run the pipeline.</p>
      </div>
    );
  }

  const title = projectData.metadata?.title || 'Untitled';
  const subtitle = projectData.metadata?.logline || '';
  const actCount = new Set(scenes.map(s => s.actTitle).filter(Boolean)).size;
  const totalShots = scenes.reduce((sum, s) => sum + s.shots.length, 0);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 px-4 pt-4 pb-2">
        <h1 className="text-xl font-bold text-white">{title}</h1>
        {subtitle && <p className="text-xs text-slate-400 mt-1 italic">{subtitle}</p>}
        <div className="flex gap-3 mt-2 text-[11px] text-slate-500">
          {actCount > 0 && <span>{actCount} Acts</span>}
          <span>{scenes.length} Scenes</span>
          <span>{projectData.elements.length} Elements</span>
          <span>{projectData.characters.length} Characters</span>
          {totalShots > 0 && <span>{totalShots} Shots</span>}
        </div>
        {pipeline.projectFolder && (
          <div className="mt-1 text-[10px] text-indigo-400/50" title={pipeline.projectFolder}>
            📁 {pipeline.projectFolder}
          </div>
        )}
      </div>

      {/* Toolbar + Search */}
      <div className="flex-shrink-0 px-4 flex items-center gap-2">
        <div className="flex-1">
          <Toolbar projectData={projectData} onAction={handleAction} />
        </div>
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search dialogue, characters, action..."
          className="w-52 px-3 py-1.5 rounded-md text-xs bg-white/[0.03] border border-white/5 text-slate-300 placeholder-slate-600 outline-none focus:border-indigo-500/30"
        />
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
          scenes={scenes.map(s => ({ id: s.id, title: s.title, actTitle: s.actTitle }))}
          activeScene={activeSceneId}
          onSelect={scrollToScene}
        />
      </div>

      {/* Content */}
      <div ref={contentRef} className="flex-1 overflow-y-auto px-4 py-4">
        {(() => {
          let currentAct = '';
          const query = searchQuery.toLowerCase().trim();

          return scenes.map(scene => {
            // Filter by search query
            if (query) {
              const titleMatch = scene.title.toLowerCase().includes(query);
              const actionMatch = scene.actions.some(a => a.toLowerCase().includes(query));
              const dialogueMatch = scene.dialogue.some(d =>
                d.characterName.toLowerCase().includes(query) ||
                d.lines.some(l => l.toLowerCase().includes(query))
              );
              if (!titleMatch && !actionMatch && !dialogueMatch) return null;
            }

            const showActHeader = scene.actTitle && scene.actTitle !== currentAct;
            if (scene.actTitle) currentAct = scene.actTitle;

            return (
              <React.Fragment key={scene.id}>
                {showActHeader && (
                  <h2 className="text-sm font-bold text-indigo-400 uppercase tracking-wider mt-6 mb-3">
                    {scene.actTitle}
                  </h2>
                )}
                <SceneCard scene={scene} charMap={charMap} locMap={locMap} pipelineId={pipelineId} />
              </React.Fragment>
            );
          }).filter(Boolean);
        })()}
      </div>
    </div>
  );
}
