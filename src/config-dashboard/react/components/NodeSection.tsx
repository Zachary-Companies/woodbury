/**
 * NodeSection — display for a pipeline node's output data.
 * Uses pipeline appConfig.nodeRenderers for specialized renderers.
 * Falls back to generic key-value/card grid for unknown data shapes.
 */
import React, { useState, useCallback } from 'react';
import { usePipeline, useAIOperations } from '../stores/PipelineProvider';
import { CharacterCard } from './CharacterCard';
import { LocationCard } from './LocationCard';

interface NodeRendererConfig {
  id: string;
  matchFields: string[];
  excludeFields?: string[];
  renderer: string;
}

interface NodeSectionProps {
  section: any;
  appState: any;
  pipelineId: string;
  appConfig?: any;
}

/** Match an array value against pipeline-declared renderer configs */
function matchRenderer(value: any, renderers: NodeRendererConfig[]): string | null {
  if (!Array.isArray(value) || value.length === 0 || typeof value[0] !== 'object') return null;
  const sample = value[0];
  for (const r of renderers) {
    const hasAll = r.matchFields.every(f => f in sample);
    const hasNone = !(r.excludeFields || []).some(f => f in sample);
    if (hasAll && hasNone) return r.renderer;
  }
  return null;
}

export function NodeSection({ section, appState, pipelineId, appConfig }: NodeSectionProps) {
  const nodeData = appState?.nodeData?.[section.nodeId];
  const outputs = nodeData?.outputs;
  const isStale = (appState?.staleNodes || []).includes(section.nodeId);
  const isEdited = nodeData?.manuallyEdited;

  if (!outputs) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#64748b', gap: 12 }}>
        <span style={{ fontSize: 36 }}>📦</span>
        <h3 style={{ fontSize: 14, fontWeight: 600 }}>No data for "{section.label}"</h3>
        <p style={{ fontSize: 12, color: '#475569', maxWidth: 320, textAlign: 'center' }}>
          This section will be populated after the pipeline runs.
        </p>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '16px 24px' }}>
      {/* Section header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: '#fff', margin: 0 }}>{section.label}</h2>
          {section.description && (
            <p style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{section.description}</p>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {isStale && (
            <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: 'rgba(245,158,11,0.1)', color: '#fbbf24', border: '1px solid rgba(245,158,11,0.2)' }}>
              ⚠ Stale
            </span>
          )}
          {isEdited && (
            <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: 'rgba(100,116,139,0.1)', color: '#94a3b8', border: '1px solid rgba(100,116,139,0.2)' }}>
              ✎ Edited
            </span>
          )}
        </div>
      </div>

      {/* Output blocks */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {Object.entries(outputs).map(([key, value]) => (
          <OutputBlock
            key={key}
            outputKey={key}
            value={value}
            section={section}
            pipelineId={pipelineId}
            appConfig={appConfig}
          />
        ))}
      </div>
    </div>
  );
}

/** A single output key's rendered data */
function OutputBlock({ outputKey, value, section, pipelineId, appConfig }: {
  outputKey: string;
  value: any;
  section: any;
  pipelineId: string;
  appConfig?: any;
}) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [saving, setSaving] = useState(false);

  const handleEdit = useCallback(() => {
    setEditText(JSON.stringify(value, null, 2));
    setEditing(true);
  }, [value]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const parsed = JSON.parse(editText);
      await fetch(`/api/app/${encodeURIComponent(pipelineId)}/state/${encodeURIComponent(section.nodeId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outputs: { [outputKey]: parsed } }),
      });
      setEditing(false);
    } catch {}
    setSaving(false);
  }, [editText, pipelineId, section.nodeId, outputKey]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(JSON.stringify(value, null, 2));
  }, [value]);

  // Match against pipeline-declared renderers
  const rendererType = matchRenderer(value, appConfig?.nodeRenderers || []);
  const itemCount = Array.isArray(value) ? ` (${value.length})` : '';

  return (
    <div style={{ borderRadius: 8, border: '1px solid rgba(255,255,255,0.05)', background: 'rgba(255,255,255,0.01)', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)', background: 'rgba(255,255,255,0.02)' }}>
        <h3 style={{ fontSize: 12, fontWeight: 600, color: '#cbd5e1', margin: 0 }}>{humanize(outputKey)}{itemCount}</h3>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={handleEdit} style={{ fontSize: 10, color: '#64748b', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px', borderRadius: 4 }}>
            ✎ Edit
          </button>
          <button onClick={handleCopy} style={{ fontSize: 10, color: '#64748b', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px', borderRadius: 4 }}>
            📋 Copy
          </button>
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: '12px 16px' }}>
        {editing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <textarea
              value={editText}
              onChange={e => setEditText(e.target.value)}
              style={{ width: '100%', height: 200, background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: 12, fontSize: 12, color: '#cbd5e1', fontFamily: 'monospace', resize: 'vertical', outline: 'none' }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleSave} disabled={saving} style={{ padding: '4px 12px', borderRadius: 4, fontSize: 12, background: 'rgba(99,102,241,0.2)', color: '#a5b4fc', border: 'none', cursor: 'pointer' }}>
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button onClick={() => setEditing(false)} style={{ padding: '4px 12px', borderRadius: 4, fontSize: 12, color: '#64748b', background: 'none', border: 'none', cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          </div>
        ) : rendererType === 'builtin:character-grid' ? (
          <CharacterGrid characters={value} pipelineId={pipelineId} />
        ) : rendererType === 'builtin:location-grid' ? (
          <LocationGrid locations={value} />
        ) : rendererType === 'builtin:element-list' ? (
          <ElementList elements={value} />
        ) : rendererType === 'builtin:section-tree' ? (
          <SectionTree sections={value} />
        ) : (
          <ValueRenderer value={value} />
        )}
      </div>
    </div>
  );
}

/** Renders character array using CharacterCard */
function CharacterGrid({ characters, pipelineId }: { characters: any[]; pipelineId: string }) {
  const { enrichCharacter, generateCharacterImages } = useAIOperations();
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number; currentName: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const enrichedCount = characters.filter(c => c.description && c.description.length > 20).length;
  const withImages = characters.filter(c => c.imagePath).length;

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    const missing = characters.filter(c => !c.imagePath);
    const total = missing.length;
    if (total === 0) { setGenerating(false); return; }
    setProgress({ current: 0, total, currentName: missing[0]?.name || '' });
    try {
      const result = await generateCharacterImages((completed: number, charName: string) => {
        setProgress({ current: completed, total, currentName: charName });
      });
      if (result?.failed > 0) {
        setError(`${result.failed} of ${total} failed`);
      }
    } catch (err: any) {
      setError(err.message || 'Generation failed');
    }
    setProgress(null);
    setGenerating(false);
  }, [characters, generateCharacterImages]);

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          onClick={handleGenerate}
          disabled={generating}
          style={{ padding: '6px 12px', borderRadius: 6, fontSize: 11, fontWeight: 500, background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)', color: '#6ee7b7', cursor: 'pointer', opacity: generating ? 0.6 : 1 }}
        >
          {generating ? '⏳ Generating...' : '🖼 Generate Headshots'}
        </button>
        <span style={{ fontSize: 10, color: '#475569' }}>
          {enrichedCount}/{characters.length} enriched · {withImages}/{characters.length} with images
        </span>
        {error && (
          <span style={{ fontSize: 10, color: '#f87171', marginLeft: 4 }}>{error}</span>
        )}
      </div>
      {progress && (
        <div style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 8, background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.12)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 11, color: '#6ee7b7', fontWeight: 500 }}>
              Generating: {progress.currentName}
            </span>
            <span style={{ fontSize: 10, color: '#64748b' }}>
              {progress.current}/{progress.total}
            </span>
          </div>
          <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              borderRadius: 2,
              background: '#10b981',
              width: `${(progress.current / progress.total) * 100}%`,
              transition: 'width 0.3s ease',
            }} />
          </div>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
        {characters.map(char => (
          <CharacterCard key={char.id || char.name} character={char} pipelineId={pipelineId} />
        ))}
      </div>
    </div>
  );
}

/** Renders location array using LocationCard */
function LocationGrid({ locations }: { locations: any[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
      {locations.map(loc => (
        <LocationCard key={loc.id || loc.name} location={loc} />
      ))}
    </div>
  );
}

/** Renders screenplay elements as a compact list */
function ElementList({ elements }: { elements: any[] }) {
  const [showAll, setShowAll] = useState(false);
  const dialogues = elements.filter(e => e.type === 'dialogue');
  const actions = elements.filter(e => e.type === 'action');
  const visible = showAll ? elements : elements.slice(0, 50);

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 12, fontSize: 11, color: '#64748b' }}>
        <span><strong style={{ color: '#a5b4fc' }}>{dialogues.length}</strong> dialogue</span>
        <span><strong style={{ color: '#a5b4fc' }}>{actions.length}</strong> action</span>
        <span><strong style={{ color: '#a5b4fc' }}>{elements.length}</strong> total</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {visible.map((el, i) => (
          <div key={el.id || i} style={{ display: 'flex', gap: 8, padding: '4px 8px', borderRadius: 4, background: 'rgba(255,255,255,0.02)', fontSize: 11 }}>
            <span style={{
              color: el.type === 'dialogue' ? '#a5b4fc' : el.type === 'action' ? '#94a3b8' : '#64748b',
              fontWeight: 500, width: 60, flexShrink: 0, textTransform: 'uppercase', fontSize: 9,
            }}>
              {el.type}
            </span>
            {el.characterName && (
              <span style={{ color: '#c4b5fd', fontWeight: 600, width: 80, flexShrink: 0, textTransform: 'uppercase', fontSize: 10 }}>
                {el.characterName}
              </span>
            )}
            <span style={{ color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {el.content || el.lines?.join(' ') || ''}
            </span>
          </div>
        ))}
      </div>
      {elements.length > 50 && !showAll && (
        <button onClick={() => setShowAll(true)} style={{ marginTop: 8, fontSize: 11, color: '#818cf8', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 6, padding: '4px 12px', cursor: 'pointer' }}>
          Show all {elements.length} elements...
        </button>
      )}
    </div>
  );
}

/** Renders section tree (acts/scenes) */
function SectionTree({ sections }: { sections: any[] }) {
  const typeIcons: Record<string, string> = {
    act: '📁', scene: '🎬', teaser: '🎪', montage: '🎞', sequence: '🔗',
    'cold-open': '❄️', tag: '🏷', blackout: '⬛', 'end-credits': '🎬',
  };
  const typeColors: Record<string, string> = {
    act: '#a5b4fc', scene: '#94a3b8', teaser: '#c4b5fd', montage: '#67e8f9',
    sequence: '#fbbf24', 'cold-open': '#93c5fd', tag: '#d4d4d8', 'end-credits': '#64748b',
  };

  function renderNode(node: any, depth: number, index: number): React.ReactElement {
    const title = node.title || node.name || node.heading || node.label || `${(node.type || 'section')} ${index + 1}`;
    const icon = typeIcons[node.type] || (node.children?.length > 0 ? '📁' : '🎬');
    const color = typeColors[node.type] || (depth === 0 ? '#a5b4fc' : '#94a3b8');
    const childCount = node.children?.length || 0;
    const hasDetails = node.location || node.timeOfDay || node.setting || node.description;

    return (
      <div key={node.id || title + index} style={{ marginLeft: depth * 20, marginBottom: depth === 0 ? 8 : 2 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: depth === 0 ? '6px 10px' : '3px 8px',
          borderRadius: 6,
          background: depth === 0 ? 'rgba(255,255,255,0.02)' : 'transparent',
          border: depth === 0 ? '1px solid rgba(255,255,255,0.04)' : 'none',
        }}>
          <span style={{ fontSize: 12 }}>{icon}</span>
          <span style={{ fontSize: depth === 0 ? 13 : 12, color, fontWeight: depth === 0 ? 600 : 400 }}>
            {title}
          </span>
          {node.type && (
            <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 3, background: 'rgba(255,255,255,0.04)', color: '#64748b' }}>
              {node.type}
            </span>
          )}
          {childCount > 0 && (
            <span style={{ fontSize: 9, color: '#475569' }}>({childCount})</span>
          )}
          {node.timeOfDay && <span style={{ fontSize: 9, color: '#475569' }}>{node.timeOfDay}</span>}
          {node.location && node.location !== title && (
            <span style={{ fontSize: 9, color: '#475569' }}>@ {typeof node.location === 'string' ? node.location : node.location?.name || ''}</span>
          )}
        </div>
        {node.description && (
          <div style={{ marginLeft: 28, fontSize: 10, color: '#475569', marginTop: 1, marginBottom: 2 }}>
            {String(node.description).slice(0, 120)}
          </div>
        )}
        {node.children?.map((child: any, i: number) => renderNode(child, depth + 1, i))}
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 8 }}>
        {sections.length} top-level sections · {sections.reduce((sum, s) => sum + (s.children?.length || 0), 0)} nested
      </div>
      {sections.map((s, i) => renderNode(s, 0, i))}
    </div>
  );
}

/** Renders any value type intelligently */
function ValueRenderer({ value, depth = 0 }: { value: any; depth?: number }) {
  if (value === null || value === undefined) {
    return <span style={{ fontSize: 12, color: '#475569', fontStyle: 'italic' }}>No value</span>;
  }

  if (typeof value === 'string') {
    if (isImageUrl(value)) {
      const src = resolveImageSrc(value);
      return <img src={src} alt="" style={{ maxWidth: 320, borderRadius: 6 }} loading="lazy" />;
    }
    if (value.length > 200) {
      return <pre style={{ fontSize: 12, color: '#94a3b8', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 256, overflowY: 'auto' }}>{value}</pre>;
    }
    return <span style={{ fontSize: 12, color: '#cbd5e1' }}>{value}</span>;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span style={{ fontSize: 12, color: '#cbd5e1', fontFamily: 'monospace' }}>{String(value)}</span>;
  }

  if (Array.isArray(value)) {
    return <ArrayRenderer items={value} depth={depth} />;
  }

  if (typeof value === 'object') {
    return <ObjectRenderer obj={value} depth={depth} />;
  }

  return <span style={{ fontSize: 12, color: '#94a3b8' }}>{String(value)}</span>;
}

/** Renders arrays as card grids */
function ArrayRenderer({ items, depth }: { items: any[]; depth: number }) {
  const [filter, setFilter] = useState('');

  if (items.length === 0) {
    return <span style={{ fontSize: 12, color: '#475569', fontStyle: 'italic' }}>Empty list</span>;
  }

  // Simple value array
  if (typeof items[0] !== 'object' || items[0] === null) {
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {items.map((item, i) => (
          <span key={i} style={{ padding: '2px 8px', borderRadius: 4, background: 'rgba(255,255,255,0.05)', fontSize: 12, color: '#94a3b8' }}>
            {String(item)}
          </span>
        ))}
      </div>
    );
  }

  // Object array — card grid
  const sample = items[0];
  const keys = Object.keys(sample);
  const titleKey = findBestField(keys, ['name', 'title', 'label', 'heading', 'displayName', 'id']);
  const descKey = findBestField(keys, ['description', 'desc', 'summary', 'text', 'content', 'body']);
  const typeKey = findBestField(keys, ['type', 'category', 'kind', 'role', 'status']);
  const imageKey = findBestField(keys, ['image', 'imageUrl', 'thumbnail', 'photo', 'avatar', 'src']);

  const filtered = filter
    ? items.filter(item => {
        const searchStr = Object.values(item).map(v => String(v || '')).join(' ').toLowerCase();
        return searchStr.includes(filter.toLowerCase());
      })
    : items;

  return (
    <div>
      {items.length > 8 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <input
            type="text"
            placeholder={`Filter ${items.length} items...`}
            value={filter}
            onChange={e => setFilter(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 6, fontSize: 12, background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.06)', color: '#cbd5e1', outline: 'none', width: 200 }}
          />
          <span style={{ fontSize: 10, color: '#475569' }}>{filtered.length} of {items.length}</span>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8 }}>
        {filtered.slice(0, 100).map((item, i) => {
          const itemTitle = titleKey ? item[titleKey] : `Item ${i + 1}`;
          const imgVal = imageKey ? item[imageKey] : null;
          const imgSrc = imgVal && typeof imgVal === 'string' && isImageUrl(imgVal) ? resolveImageSrc(imgVal) : null;

          return (
            <div key={i} style={{ borderRadius: 8, border: '1px solid rgba(255,255,255,0.05)', background: 'rgba(255,255,255,0.02)', overflow: 'hidden' }}>
              {imgSrc && (
                <div style={{ height: 96, overflow: 'hidden', background: 'rgba(0,0,0,0.2)' }}>
                  <img src={imgSrc} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
                </div>
              )}
              <div style={{ padding: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(itemTitle || `Item ${i + 1}`)}</div>
                {typeKey && item[typeKey] && (
                  <span style={{ display: 'inline-block', marginTop: 2, padding: '1px 6px', borderRadius: 3, fontSize: 9, background: 'rgba(99,102,241,0.1)', color: '#818cf8' }}>
                    {String(item[typeKey])}
                  </span>
                )}
                {descKey && item[descKey] && (
                  <p style={{ fontSize: 10, color: '#64748b', marginTop: 4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as any }}>{String(item[descKey]).slice(0, 140)}</p>
                )}
                <ExtraFields item={item} shownKeys={[titleKey, descKey, typeKey, imageKey]} allKeys={keys} />
              </div>
            </div>
          );
        })}
      </div>
      {filtered.length > 100 && (
        <p style={{ fontSize: 10, color: '#475569', marginTop: 8 }}>Showing 100 of {filtered.length} items</p>
      )}
    </div>
  );
}

function ExtraFields({ item, shownKeys, allKeys }: { item: any; shownKeys: (string | null)[]; allKeys: string[] }) {
  const shown = new Set(shownKeys.filter(Boolean));
  const extras = allKeys.filter(k => !shown.has(k)).slice(0, 3);
  if (extras.length === 0) return null;

  return (
    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
      {extras.map(k => {
        const v = item[k];
        if (v === null || v === undefined) return null;
        const display = typeof v === 'object'
          ? (Array.isArray(v) ? `${v.length} items` : `${Object.keys(v).length} fields`)
          : String(v).slice(0, 60);
        return (
          <div key={k} style={{ display: 'flex', gap: 6, fontSize: 9 }}>
            <span style={{ color: '#475569' }}>{humanize(k)}</span>
            <span style={{ color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{display}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Renders objects as key-value grids */
function ObjectRenderer({ obj, depth }: { obj: Record<string, any>; depth: number }) {
  const entries = Object.entries(obj);

  // Split into simple vs complex
  const simple: [string, any][] = [];
  const complex: [string, any][] = [];
  for (const [k, v] of entries) {
    if (v && typeof v === 'object' && ((Array.isArray(v) && v.length >= 3) || (!Array.isArray(v) && Object.keys(v).length >= 5))) {
      complex.push([k, v]);
    } else {
      simple.push([k, v]);
    }
  }

  // If has complex children, use tabs
  if (complex.length > 0 && depth < 2) {
    return <TabbedObject simple={simple} complex={complex} depth={depth} />;
  }

  // Simple KV grid
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {entries.map(([k, v]) => (
        <div key={k} style={{ display: 'flex', gap: 12, padding: '3px 0' }}>
          <span style={{ fontSize: 11, color: '#64748b', width: 120, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{humanize(k)}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            {typeof v === 'object' && v !== null ? (
              <span style={{ fontSize: 11, color: '#475569' }}>
                {Array.isArray(v) ? `[${v.length} items]` : `{${Object.keys(v).length} fields}`}
              </span>
            ) : (
              <span style={{ fontSize: 12, color: '#cbd5e1', wordBreak: 'break-word' }}>{formatValue(v)}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function TabbedObject({ simple, complex, depth }: {
  simple: [string, any][];
  complex: [string, any][];
  depth: number;
}) {
  const tabs = [
    ...(simple.length > 0 ? [{ id: '_summary', label: 'Summary', count: `${simple.length} fields` }] : []),
    ...complex.map(([k, v]) => ({
      id: k,
      label: humanize(k),
      count: Array.isArray(v) ? `${v.length} items` : `${Object.keys(v).length} fields`,
    })),
  ];

  const [activeTab, setActiveTab] = useState(tabs[0]?.id || '');

  return (
    <div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '6px 12px', borderRadius: 6, fontSize: 11, fontWeight: 500,
              background: activeTab === tab.id ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.03)',
              border: activeTab === tab.id ? '1px solid rgba(99,102,241,0.25)' : '1px solid rgba(255,255,255,0.06)',
              color: activeTab === tab.id ? '#a5b4fc' : '#64748b',
              cursor: 'pointer', transition: 'all 0.15s',
            }}
          >
            {tab.label} <span style={{ color: '#475569', marginLeft: 3, fontSize: 10 }}>{tab.count}</span>
          </button>
        ))}
      </div>

      {activeTab === '_summary' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {simple.map(([k, v]) => (
            <div key={k} style={{ display: 'flex', gap: 12, padding: '3px 0' }}>
              <span style={{ fontSize: 11, color: '#64748b', width: 120, flexShrink: 0 }}>{humanize(k)}</span>
              <span style={{ fontSize: 12, color: '#cbd5e1', wordBreak: 'break-word' }}>{formatValue(v)}</span>
            </div>
          ))}
        </div>
      )}

      {complex.map(([k, v]) =>
        activeTab === k ? (
          <div key={k}>
            <ValueRenderer value={v} depth={depth + 1} />
          </div>
        ) : null
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────

function humanize(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function formatValue(v: any): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v.length > 200 ? v.slice(0, 180) + '...' : v;
  if (Array.isArray(v)) return `${v.length} items`;
  if (typeof v === 'object') return `${Object.keys(v).length} fields`;
  return String(v);
}

function isImageUrl(str: string): boolean {
  if (!str) return false;
  if (str.startsWith('data:image')) return true;
  const lower = str.toLowerCase().split('?')[0].split('#')[0];
  return /\.(png|jpg|jpeg|gif|webp|svg|bmp|avif)$/.test(lower);
}

function resolveImageSrc(src: string): string {
  if (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://') || src.startsWith('blob:')) return src;
  return `/api/file?path=${encodeURIComponent(src)}`;
}

function findBestField(keys: string[], candidates: string[]): string | null {
  for (const c of candidates) {
    if (keys.includes(c)) return c;
  }
  const lowerKeys = keys.map(k => k.toLowerCase());
  for (const c of candidates) {
    const idx = lowerKeys.indexOf(c.toLowerCase());
    if (idx !== -1) return keys[idx];
  }
  for (const c of candidates) {
    for (let i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase().includes(c.toLowerCase())) return keys[i];
    }
  }
  return null;
}
