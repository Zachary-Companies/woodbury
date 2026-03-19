/**
 * VoicesView — manage voice assignments for characters, preview TTS.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { usePipeline, type Character } from '../stores/PipelineProvider';

interface VoiceOption {
  voice_id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
  preview_url?: string;
}

export function VoicesView() {
  const { project: projectData, pipelineId } = usePipeline();
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(true);
  const [bindings, setBindings] = useState<any[]>([]);
  const [playingPreview, setPlayingPreview] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  // Load available voices
  useEffect(() => {
    fetch('/api/extensions/elevenlabs/voices')
      .then(r => r.json())
      .then(data => {
        setVoices(data.voices || []);
        setLoadingVoices(false);
      })
      .catch(() => setLoadingVoices(false));

    // Load bindings
    if (pipelineId) {
      fetch(`/api/app/${encodeURIComponent(pipelineId)}/bindings`)
        .then(r => r.json())
        .then(data => setBindings(data.bindings || []))
        .catch(() => {});
    }
  }, [pipelineId]);

  const characters = projectData?.characters || [];

  const getAssignedVoice = useCallback((charId: string) => {
    const binding = bindings.find(b =>
      b.sourceEntityId === charId && b.bindingType === 'voiced-by'
    );
    if (!binding) return null;
    return voices.find(v => v.voice_id === binding.targetEntityId) || null;
  }, [bindings, voices]);

  const handleAssignVoice = useCallback(async (charId: string, voiceId: string) => {
    // Save binding
    const newBindings = bindings.filter(b => !(b.sourceEntityId === charId && b.bindingType === 'voiced-by'));
    if (voiceId) {
      newBindings.push({
        sourceEntityType: 'character',
        sourceEntityId: charId,
        targetEntityType: 'voice',
        targetEntityId: voiceId,
        bindingType: 'voiced-by',
      });
    }
    setBindings(newBindings);

    await fetch(`/api/app/${encodeURIComponent(pipelineId)}/bindings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bindings: newBindings }),
    });
  }, [pipelineId, bindings]);

  const playPreview = useCallback((url: string, voiceId: string) => {
    if (playingPreview === voiceId) {
      setPlayingPreview(null);
      return;
    }
    setPlayingPreview(voiceId);
    const audio = new Audio(url);
    audio.onended = () => setPlayingPreview(null);
    audio.play().catch(() => setPlayingPreview(null));
  }, [playingPreview]);

  if (!projectData) return <div className="flex items-center justify-center h-full text-slate-500">No project data</div>;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-shrink-0 px-4 py-3 border-b border-white/5">
        <h2 className="text-sm font-semibold text-white">Voice Assignments</h2>
        <p className="text-[10px] text-slate-500 mt-0.5">Assign ElevenLabs voices to each character for dialogue TTS generation</p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="space-y-3">
          {characters.map(char => {
            const assignedVoice = getAssignedVoice(char.id);
            return (
              <CharacterVoiceRow
                key={char.id}
                character={char}
                assignedVoice={assignedVoice}
                voices={voices}
                loadingVoices={loadingVoices}
                playingPreview={playingPreview}
                onAssign={(voiceId) => handleAssignVoice(char.id, voiceId)}
                onPreview={playPreview}
              />
            );
          })}
        </div>

        {characters.length === 0 && (
          <div className="text-center text-slate-500 text-sm py-8">
            No characters. Import a script first.
          </div>
        )}
      </div>
    </div>
  );
}

function CharacterVoiceRow({ character, assignedVoice, voices, loadingVoices, playingPreview, onAssign, onPreview }: {
  character: Character;
  assignedVoice: VoiceOption | null;
  voices: VoiceOption[];
  loadingVoices: boolean;
  playingPreview: string | null;
  onAssign: (voiceId: string) => void;
  onPreview: (url: string, voiceId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-white/5 bg-[#111827]/60 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Character info */}
        {character.imagePath ? (
          <img src={`/api/file?path=${encodeURIComponent(character.imagePath)}`} className="w-10 h-10 rounded-full object-cover border border-white/10" alt="" />
        ) : (
          <div className="w-10 h-10 rounded-full bg-white/[0.03] border border-white/5 flex items-center justify-center text-lg">👤</div>
        )}

        <div className="flex-1 min-w-0">
          <h3 className="text-xs font-semibold text-white">{character.name}</h3>
          {character.voiceDescription && (
            <p className="text-[10px] text-slate-500 truncate">{character.voiceDescription}</p>
          )}
        </div>

        {/* Assigned voice */}
        <div className="flex items-center gap-2">
          {assignedVoice ? (
            <span className="px-2 py-1 rounded text-[10px] bg-emerald-500/10 border border-emerald-500/15 text-emerald-300">
              🎙 {assignedVoice.name}
            </span>
          ) : (
            <span className="px-2 py-1 rounded text-[10px] bg-amber-500/10 border border-amber-500/15 text-amber-300">
              No voice assigned
            </span>
          )}
          <button
            onClick={() => setExpanded(!expanded)}
            className="px-2 py-1 rounded text-[10px] bg-white/[0.03] border border-white/8 text-slate-400 hover:text-white transition-colors"
          >
            {expanded ? '▲ Close' : '▼ Assign'}
          </button>
        </div>
      </div>

      {/* Voice picker */}
      {expanded && (
        <div className="px-4 pb-3 border-t border-white/5 pt-2">
          {loadingVoices ? (
            <p className="text-xs text-slate-500">Loading voices...</p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-1.5 max-h-48 overflow-y-auto">
              <button
                onClick={() => { onAssign(''); setExpanded(false); }}
                className="px-2 py-1.5 rounded text-[10px] text-left bg-white/[0.02] border border-white/5 text-slate-500 hover:bg-white/[0.05] transition-colors"
              >
                ✕ Remove voice
              </button>
              {voices.map(v => (
                <button
                  key={v.voice_id}
                  onClick={() => { onAssign(v.voice_id); setExpanded(false); }}
                  className={`px-2 py-1.5 rounded text-[10px] text-left border transition-colors flex items-center gap-1.5 ${
                    assignedVoice?.voice_id === v.voice_id
                      ? 'bg-indigo-500/15 border-indigo-500/25 text-indigo-300'
                      : 'bg-white/[0.02] border-white/5 text-slate-400 hover:bg-white/[0.05]'
                  }`}
                >
                  <span className="truncate flex-1">{v.name}</span>
                  {v.preview_url && (
                    <span
                      onClick={e => { e.stopPropagation(); onPreview(v.preview_url!, v.voice_id); }}
                      className="flex-shrink-0 cursor-pointer hover:text-white"
                    >
                      {playingPreview === v.voice_id ? '⏹' : '▶'}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
