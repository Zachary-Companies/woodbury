/**
 * CharacterCard — cinematic character card with headshot hero image,
 * role badge, traits, and action buttons.
 * Uses React.memo to skip re-renders when character data hasn't changed.
 */
import React, { useState, useCallback } from 'react';
import { useAIOperations, type Character } from '../stores/PipelineProvider';
import { CharacterEditor } from './CharacterEditor';

const ROLE_STYLES: Record<string, string> = {
  main: 'bg-amber-400/90 text-black',
  supporting: 'bg-sky-400/80 text-black',
  minor: 'bg-slate-400/70 text-black',
};

export const CharacterCard = React.memo(function CharacterCard({ character, pipelineId }: { character: Character; pipelineId: string }) {
  const { enrichCharacter } = useAIOperations();
  const [enriching, setEnriching] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [showLightbox, setShowLightbox] = useState(false);
  const [hovered, setHovered] = useState(false);
  const hasDescription = character.description && character.description.length > 20;

  const imgSrc = character.imagePath
    ? `/api/file?path=${encodeURIComponent(character.imagePath)}`
    : null;

  const handleEnrich = async () => {
    setEnriching(true);
    try {
      await enrichCharacter(character.id);
    } catch (err: any) {
      console.error('Enrich failed:', err);
    }
    setEnriching(false);
  };

  const roleBadge = character.role || 'minor';
  const meta = [character.ageRange, character.gender].filter(Boolean).join(' \u00b7 ');

  return (
    <div
      className="group relative rounded-xl overflow-hidden bg-[#0c1018] border border-white/[0.06] transition-all duration-200 hover:border-white/[0.12] hover:shadow-lg hover:shadow-black/40"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Hero image area — click to open lightbox */}
      <div
        className="relative h-48 bg-gradient-to-b from-slate-800/40 to-[#0c1018] overflow-hidden cursor-pointer"
        onClick={() => imgSrc && setShowLightbox(true)}
      >
        {imgSrc ? (
          <img
            src={imgSrc}
            alt={character.name}
            className="w-full h-full object-cover object-center transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-slate-800/30 to-slate-900/50">
            <div className="w-16 h-16 rounded-full bg-white/[0.04] border border-white/[0.06] flex items-center justify-center">
              <svg className="w-8 h-8 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
            </div>
          </div>
        )}

        {/* Gradient overlay for text readability — pointer-events-none so clicks go to image */}
        <div className="absolute inset-0 bg-gradient-to-t from-[#0c1018] via-[#0c1018]/70 via-30% to-transparent pointer-events-none" />

        {/* Role badge — top right */}
        <span className={`absolute top-2.5 right-2.5 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider pointer-events-none ${ROLE_STYLES[roleBadge] || ROLE_STYLES.minor}`}>
          {roleBadge}
        </span>

        {/* Name + meta overlay at bottom of image */}
        <div className="absolute bottom-0 left-0 right-0 px-4 pb-3 pointer-events-none">
          <h3 className="text-[15px] font-bold text-white leading-tight tracking-wide drop-shadow-lg">
            {character.name}
          </h3>
          {character.displayName && character.displayName !== character.name && (
            <p className="text-[10px] text-slate-400 uppercase tracking-widest mt-0.5">{character.displayName}</p>
          )}
          {meta && (
            <p className="text-[11px] text-slate-500 mt-0.5">{meta}</p>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="px-4 pt-3 pb-4 flex flex-col gap-2.5">
        {/* Description */}
        {character.description && (
          <p className="text-[11px] text-slate-400 leading-[1.6] line-clamp-3">
            {character.description}
          </p>
        )}

        {/* Traits */}
        {character.traits && character.traits.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {character.traits.slice(0, 5).map((trait, i) => (
              <span key={i} className="px-2 py-[3px] rounded text-[10px] font-medium bg-white/[0.04] text-slate-400 border border-white/[0.05]">
                {trait}
              </span>
            ))}
            {character.traits.length > 5 && (
              <span className="px-2 py-[3px] rounded text-[10px] text-slate-600">
                +{character.traits.length - 5}
              </span>
            )}
          </div>
        )}

        {/* Voice description */}
        {character.voiceDescription && (
          <p className="text-[10px] text-slate-500 leading-relaxed italic border-l-2 border-slate-700/50 pl-2.5">
            {character.voiceDescription}
          </p>
        )}

        {/* Actions */}
        <div className="flex gap-2 mt-1">
          {!hasDescription ? (
            <button
              onClick={handleEnrich}
              disabled={enriching}
              className="flex-1 py-1.5 rounded-lg text-[11px] font-medium bg-indigo-500/15 text-indigo-300 border border-indigo-500/20 hover:bg-indigo-500/25 transition-colors disabled:opacity-50"
            >
              {enriching ? 'Enriching\u2026' : 'Enrich with AI'}
            </button>
          ) : (
            <span className="flex items-center gap-1 text-[10px] text-emerald-500/70 font-medium">
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              Enriched
            </span>
          )}
          <button
            onClick={() => setShowEditor(true)}
            className="px-3 py-1.5 rounded-lg text-[11px] text-slate-500 border border-white/[0.06] hover:text-slate-300 hover:bg-white/[0.04] transition-colors"
          >
            Edit
          </button>
        </div>
      </div>

      {/* Editor modal */}
      {showEditor && <CharacterEditor character={character} onClose={() => setShowEditor(false)} />}

      {/* Image lightbox */}
      {showLightbox && imgSrc && (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/85 backdrop-blur-sm cursor-pointer"
          onClick={() => setShowLightbox(false)}
        >
          <div className="relative max-w-[calc(100vw-4rem)] max-h-[calc(100vh-4rem)]">
            <button
              onClick={e => { e.stopPropagation(); setShowLightbox(false); }}
              className="absolute -top-3 -right-3 w-9 h-9 rounded-full bg-slate-900/90 border border-white/15 text-slate-300 text-xl flex items-center justify-center hover:text-white hover:bg-slate-800 transition-colors z-10"
            >
              &times;
            </button>
            <img
              src={imgSrc}
              alt={character.name}
              className="max-w-full max-h-[calc(100vh-6rem)] object-contain rounded-lg shadow-2xl"
              onClick={e => e.stopPropagation()}
            />
            <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/70 to-transparent rounded-b-lg pointer-events-none">
              <p className="text-lg font-bold text-white drop-shadow-lg">{character.name}</p>
              {meta && <p className="text-sm text-slate-300">{meta}</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}, (prev, next) => {
  const p = prev.character, n = next.character;
  return p.id === n.id
    && p.imagePath === n.imagePath
    && p.description === n.description
    && p.name === n.name
    && p.role === n.role
    && p.voiceDescription === n.voiceDescription
    && JSON.stringify(p.traits) === JSON.stringify(n.traits)
    && prev.pipelineId === next.pipelineId;
});
