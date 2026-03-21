/**
 * LocationCard — cinematic location card with hero image,
 * type/mood badges, and enrich action.
 * Uses React.memo to skip re-renders when location data hasn't changed.
 */
import React, { useState } from 'react';
import { useAIOperations, type Location } from '../stores/PipelineProvider';

const TYPE_STYLES: Record<string, string> = {
  interior: 'bg-amber-400/80 text-black',
  exterior: 'bg-sky-400/80 text-black',
};

export const LocationCard = React.memo(function LocationCard({ location }: { location: Location }) {
  const { enrichLocation } = useAIOperations();
  const [enriching, setEnriching] = useState(false);
  const [showLightbox, setShowLightbox] = useState(false);
  const hasDescription = location.description && location.description.length > 20;

  const imgSrc = location.imagePath
    ? `/api/file?path=${encodeURIComponent(location.imagePath)}`
    : null;

  const handleEnrich = async () => {
    setEnriching(true);
    try {
      await enrichLocation(location.id);
    } catch (err: any) {
      console.error('Enrich failed:', err);
    }
    setEnriching(false);
  };

  const typeBadge = location.type || '';
  const meta = [location.type, location.mood].filter(Boolean).join(' \u00b7 ');

  return (
    <div className="group relative rounded-xl overflow-hidden bg-[#0c1018] border border-white/[0.06] transition-all duration-200 hover:border-white/[0.12] hover:shadow-lg hover:shadow-black/40">
      {/* Hero image area — click to open lightbox */}
      <div
        className="relative h-40 bg-gradient-to-b from-slate-800/40 to-[#0c1018] overflow-hidden cursor-pointer"
        onClick={() => imgSrc && setShowLightbox(true)}
      >
        {imgSrc ? (
          <img
            src={imgSrc}
            alt={location.name}
            className="w-full h-full object-cover object-center transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-slate-800/30 to-slate-900/50">
            <svg className="w-10 h-10 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
        )}

        {/* Gradient overlay — pointer-events-none so clicks go to image */}
        <div className="absolute inset-0 bg-gradient-to-t from-[#0c1018] via-[#0c1018]/60 via-25% to-transparent pointer-events-none" />

        {/* Type badge — top right */}
        {typeBadge && (
          <span className={`absolute top-2.5 right-2.5 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider pointer-events-none ${TYPE_STYLES[typeBadge.toLowerCase()] || 'bg-slate-400/70 text-black'}`}>
            {typeBadge}
          </span>
        )}

        {/* Name + meta overlay at bottom of image */}
        <div className="absolute bottom-0 left-0 right-0 px-4 pb-3 pointer-events-none">
          <h3 className="text-[14px] font-bold text-white leading-tight tracking-wide drop-shadow-lg">
            {location.name}
          </h3>
          {meta && (
            <p className="text-[11px] text-slate-400 mt-0.5">{meta}</p>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="px-4 pt-3 pb-4 flex flex-col gap-2">
        {/* Description */}
        {location.description && (
          <p className="text-[11px] text-slate-400 leading-[1.6] line-clamp-2">
            {location.description}
          </p>
        )}

        {/* Atmosphere */}
        {location.atmosphere && (
          <p className="text-[10px] text-slate-500 leading-relaxed italic border-l-2 border-slate-700/50 pl-2.5">
            {location.atmosphere}
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
        </div>
      </div>

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
              alt={location.name}
              className="max-w-full max-h-[calc(100vh-6rem)] object-contain rounded-lg shadow-2xl"
              onClick={e => e.stopPropagation()}
            />
            <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/70 to-transparent rounded-b-lg pointer-events-none">
              <p className="text-lg font-bold text-white drop-shadow-lg">{location.name}</p>
              {meta && <p className="text-sm text-slate-300">{meta}</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}, (prev, next) => {
  const p = prev.location, n = next.location;
  return p.id === n.id
    && p.imagePath === n.imagePath
    && p.description === n.description
    && p.name === n.name
    && p.type === n.type
    && p.mood === n.mood
    && p.atmosphere === n.atmosphere;
});
