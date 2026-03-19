/**
 * LocationCard — displays a location with image and enrich button.
 */
import React, { useState } from 'react';
import { usePipeline, type Location } from '../stores/PipelineProvider';

export function LocationCard({ location }: { location: Location }) {
  const { enrichLocation } = usePipeline();
  const [enriching, setEnriching] = useState(false);
  const hasDescription = location.description && location.description.length > 20;

  const handleEnrich = async () => {
    setEnriching(true);
    try {
      await enrichLocation(location.id);
    } catch (err: any) {
      console.error('Enrich failed:', err);
    }
    setEnriching(false);
  };

  return (
    <div className="rounded-lg border border-white/5 bg-[#111827]/60 overflow-hidden">
      {/* Location image */}
      {location.imagePath ? (
        <div className="h-24 overflow-hidden">
          <img
            src={`/api/file?path=${encodeURIComponent(location.imagePath)}`}
            className="w-full h-full object-cover"
            alt={location.name}
          />
        </div>
      ) : (
        <div className="h-16 bg-gradient-to-br from-slate-800/50 to-slate-900/50 flex items-center justify-center text-lg">
          🌍
        </div>
      )}

      <div className="p-3 flex flex-col gap-2">
        <div>
          <h3 className="text-xs font-semibold text-white truncate">{location.name}</h3>
          <div className="flex gap-2 mt-0.5 text-[10px] text-slate-500">
            {location.type && <span>{location.type}</span>}
            {location.mood && <span>• {location.mood}</span>}
          </div>
        </div>

        {location.description && (
          <p className="text-[10px] text-slate-400 leading-relaxed line-clamp-2">{location.description}</p>
        )}

        {location.atmosphere && (
          <p className="text-[10px] text-slate-500 italic">{location.atmosphere}</p>
        )}

        <button
          onClick={handleEnrich}
          disabled={enriching}
          className={`w-full py-1 rounded text-[10px] font-medium transition-all ${
            enriching ? 'bg-amber-500/10 border border-amber-500/20 text-amber-300' :
            hasDescription ? 'bg-emerald-500/8 border border-emerald-500/15 text-emerald-400' :
            'bg-purple-500/10 border border-purple-500/20 text-purple-300 hover:bg-purple-500/20'
          }`}
        >
          {enriching ? '⏳...' : hasDescription ? '✅' : '✨ Enrich'}
        </button>
      </div>
    </div>
  );
}
