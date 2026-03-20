/**
 * CharacterCard — displays a character with headshot, traits, and enrich button.
 * Uses React.memo to skip re-renders when character data hasn't changed.
 */
import React, { useState } from 'react';
import { useAIOperations, type Character } from '../stores/PipelineProvider';
import { CharacterEditor } from './CharacterEditor';
import { ImageZoom } from './ImageZoom';

export const CharacterCard = React.memo(function CharacterCard({ character, pipelineId }: { character: Character; pipelineId: string }) {
  const { enrichCharacter } = useAIOperations();
  const [enriching, setEnriching] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const hasDescription = character.description && character.description.length > 20;

  const handleEnrich = async () => {
    setEnriching(true);
    try {
      await enrichCharacter(character.id);
    } catch (err: any) {
      console.error('Enrich failed:', err);
    }
    setEnriching(false);
  };

  return (
    <div className="rounded-lg border border-white/5 bg-[#111827]/60 p-4 flex flex-col gap-3">
      {/* Header with image */}
      <div className="flex items-start gap-3">
        {character.imagePath ? (
          <ImageZoom
            src={`/api/file?path=${encodeURIComponent(character.imagePath)}`}
            className="w-16 h-20 rounded-lg object-cover border border-white/10 flex-shrink-0"
            alt={character.name}
          />
        ) : (
          <div className="w-16 h-20 rounded-lg bg-white/[0.03] border border-white/5 flex items-center justify-center text-2xl flex-shrink-0">
            👤
          </div>
        )}
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-white truncate">{character.name}</h3>
          {character.displayName && character.displayName !== character.name && (
            <p className="text-[10px] text-slate-500 uppercase tracking-wider">{character.displayName}</p>
          )}
          {character.role && (
            <span className={`inline-block mt-1 px-2 py-0.5 rounded text-[10px] font-medium ${
              character.role === 'main' ? 'bg-indigo-500/15 text-indigo-300' :
              character.role === 'supporting' ? 'bg-teal-500/15 text-teal-300' :
              'bg-slate-500/15 text-slate-400'
            }`}>
              {character.role}
            </span>
          )}
          <div className="flex gap-2 mt-1 text-[10px] text-slate-500">
            {character.ageRange && <span>{character.ageRange}</span>}
            {character.gender && <span>• {character.gender}</span>}
          </div>
        </div>
      </div>

      {/* Description */}
      {character.description && (
        <p className="text-xs text-slate-400 leading-relaxed line-clamp-3">{character.description}</p>
      )}

      {/* Traits */}
      {character.traits && character.traits.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {character.traits.slice(0, 5).map((trait, i) => (
            <span key={i} className="px-2 py-0.5 rounded-full text-[10px] bg-white/[0.03] border border-white/5 text-slate-400">
              {trait}
            </span>
          ))}
        </div>
      )}

      {/* Voice */}
      {character.voiceDescription && (
        <p className="text-[10px] text-slate-500 italic">🎙 {character.voiceDescription}</p>
      )}

      {/* Enrich button */}
      <button
        onClick={handleEnrich}
        disabled={enriching}
        className={`w-full py-1.5 rounded text-[11px] font-medium transition-all ${
          enriching ? 'bg-amber-500/10 border border-amber-500/20 text-amber-300 cursor-wait' :
          hasDescription ? 'bg-emerald-500/8 border border-emerald-500/15 text-emerald-400 hover:bg-emerald-500/15' :
          'bg-purple-500/10 border border-purple-500/20 text-purple-300 hover:bg-purple-500/20'
        }`}
      >
        {enriching ? '⏳ Enriching...' : hasDescription ? '✅ Enriched' : '✨ Enrich with AI'}
      </button>

      {/* Edit button */}
      <button
        onClick={() => setShowEditor(true)}
        className="w-full py-1 rounded text-[10px] text-slate-500 border border-white/5 hover:text-slate-300 hover:bg-white/[0.03] transition-colors"
      >
        ✏️ Edit Details
      </button>

      {/* Editor modal */}
      {showEditor && <CharacterEditor character={character} onClose={() => setShowEditor(false)} />}
    </div>
  );
}, (prev, next) => {
  // Custom equality: skip re-render if character data is the same
  const p = prev.character, n = next.character;
  return p.id === n.id
    && p.imagePath === n.imagePath
    && p.description === n.description
    && p.name === n.name
    && p.role === n.role
    && p.voiceDescription === n.voiceDescription
    && prev.pipelineId === next.pipelineId;
});
