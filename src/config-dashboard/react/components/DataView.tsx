/**
 * DataView — displays characters and locations as card grids with enrich/generate actions.
 */
import React, { useState, useCallback } from 'react';
import { usePipeline } from '../stores/PipelineProvider';
import { CharacterCard } from './CharacterCard';
import { LocationCard } from './LocationCard';

type Tab = 'characters' | 'locations' | 'metadata' | 'sections';

export function DataView() {
  const pipeline = usePipeline();
  const { project: projectData, pipelineId, loading } = pipeline;
  const [activeTab, setActiveTab] = useState<Tab>('characters');
  const [filter, setFilter] = useState('');
  const [generating, setGenerating] = useState<string | null>(null);

  const handleGenerate = useCallback(async (type: 'characters' | 'locations') => {
    setGenerating(type);
    try {
      await (type === 'characters' ? pipeline.generateCharacterImages() : pipeline.generateLocationImages());
    } catch (err: any) {
      console.error('Generation failed:', err);
    }
    setGenerating(null);
  }, []);

  if (loading) return <div className="flex items-center justify-center h-full text-slate-500">Loading...</div>;
  if (!projectData) return <div className="flex items-center justify-center h-full text-slate-500">No data loaded</div>;

  const characters = projectData.characters || [];
  const locations = projectData.locations || [];
  const filteredChars = filter
    ? characters.filter(c => c.name.toLowerCase().includes(filter.toLowerCase()))
    : characters;
  const filteredLocs = filter
    ? locations.filter(l => l.name.toLowerCase().includes(filter.toLowerCase()))
    : locations;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Tabs */}
      <div className="flex-shrink-0 flex items-center gap-1 px-4 py-2 border-b border-white/5">
        {(['characters', 'locations', 'metadata', 'sections'] as Tab[]).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              activeTab === tab
                ? 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/25'
                : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.03]'
            }`}
          >
            {tab === 'characters' ? `👥 Characters (${characters.length})` :
             tab === 'locations' ? `📍 Locations (${locations.length})` :
             tab === 'metadata' ? '📋 Metadata' :
             `📁 Sections (${projectData.sections?.length || 0})`}
          </button>
        ))}

        <div className="flex-1" />

        {/* Filter */}
        {(activeTab === 'characters' || activeTab === 'locations') && (
          <input
            type="text"
            placeholder="Filter..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="px-3 py-1 rounded-md text-xs bg-white/[0.03] border border-white/5 text-slate-300 placeholder-slate-600 outline-none focus:border-indigo-500/30 w-40"
          />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {activeTab === 'characters' && (
          <>
            {/* Actions bar */}
            <div className="flex items-center gap-2 mb-4">
              <button
                onClick={() => handleGenerate('characters')}
                disabled={generating === 'characters'}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
              >
                {generating === 'characters' ? '⏳ Generating...' : '🖼 Generate All Headshots'}
              </button>
              <span className="text-[10px] text-slate-600">
                {characters.filter(c => c.description && c.description.length > 20).length}/{characters.length} enriched
                {' • '}
                {characters.filter(c => c.imagePath).length}/{characters.length} with images
              </span>
            </div>

            {/* Card grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {filteredChars.map(char => (
                <CharacterCard key={char.id} character={char} pipelineId={pipelineId} />
              ))}
            </div>
          </>
        )}

        {activeTab === 'locations' && (
          <>
            <div className="flex items-center gap-2 mb-4">
              <button
                onClick={() => handleGenerate('locations')}
                disabled={generating === 'locations'}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
              >
                {generating === 'locations' ? '⏳ Generating...' : '🌍 Generate All Location Shots'}
              </button>
              <span className="text-[10px] text-slate-600">
                {locations.filter(l => l.description && l.description.length > 20).length}/{locations.length} enriched
                {' • '}
                {locations.filter(l => l.imagePath).length}/{locations.length} with images
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {filteredLocs.map(loc => (
                <LocationCard key={loc.id} location={loc} />
              ))}
            </div>
          </>
        )}

        {activeTab === 'metadata' && (
          <div className="max-w-2xl">
            <MetadataView metadata={projectData.metadata} />
          </div>
        )}

        {activeTab === 'sections' && (
          <SectionsView sections={projectData.sections || []} />
        )}
      </div>
    </div>
  );
}

// ── Metadata View ────────────────────────────────────────────

function MetadataView({ metadata }: { metadata: any }) {
  if (!metadata) return <p className="text-slate-500 text-sm">No metadata</p>;

  const fields = [
    ['Title', metadata.title],
    ['Subtitle', metadata.subtitle],
    ['Logline', metadata.logline],
    ['Author', metadata.author?.map((a: any) => a.name).join(', ')],
    ['Genre', metadata.genre?.join(', ')],
    ['Tone', metadata.tone?.join(', ')],
    ['Runtime', metadata.runtimeMinutes ? `${metadata.runtimeMinutes} min` : null],
    ['Pages', metadata.estimatedPages],
    ['Draft Date', metadata.draftDate],
    ['Version', metadata.version],
    ['Language', metadata.language],
  ].filter(([, v]) => v);

  return (
    <div className="space-y-2">
      {fields.map(([label, value]) => (
        <div key={label as string} className="flex gap-3">
          <span className="text-xs text-slate-500 w-24 flex-shrink-0">{label}</span>
          <span className="text-xs text-slate-300">{value as string}</span>
        </div>
      ))}
    </div>
  );
}

// ── Sections View ────────────────────────────────────────────

function SectionsView({ sections }: { sections: any[] }) {
  function renderSection(sec: any, depth: number) {
    return (
      <div key={sec.id || sec.title} style={{ marginLeft: depth * 16 }} className="mb-1">
        <div className={`flex items-center gap-2 py-1 ${depth === 0 ? 'text-indigo-300 font-semibold' : 'text-slate-400'}`}>
          <span className="text-[10px]">{sec.type === 'act' ? '📁' : '🎬'}</span>
          <span className="text-xs">{sec.title}</span>
          {sec.timeOfDay && <span className="text-[9px] text-slate-600">({sec.timeOfDay})</span>}
        </div>
        {sec.children?.map((child: any) => renderSection(child, depth + 1))}
      </div>
    );
  }

  return (
    <div>
      {sections.map(sec => renderSection(sec, 0))}
    </div>
  );
}
