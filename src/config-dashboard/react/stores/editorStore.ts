/**
 * EditorStore — types, initial state, and reducer for the React StoryCut editor.
 * Mirrors the vanilla JS editorState but in a React-friendly useReducer pattern.
 */

// ── Constants ──────────────────────────────────────────────
export const TRACK_HEIGHT = 48;
export const RULER_HEIGHT = 32;
export const SCENE_LANE_HEIGHT = 28;
export const PX_PER_SEC = 80;

export const MEDIA_COLORS: Record<string, { bg: string; border: string; accent: string }> = {
  image:    { bg: 'rgba(100,116,139,0.35)', border: '#64748b', accent: '#94a3b8' },
  video:    { bg: 'rgba(129,95,222,0.3)',   border: '#8b5cf6', accent: '#a78bfa' },
  dialog:   { bg: 'rgba(34,197,94,0.25)',   border: '#22c55e', accent: '#4ade80' },
  music:    { bg: 'rgba(245,158,11,0.25)',   border: '#f59e0b', accent: '#fbbf24' },
  sfx:      { bg: 'rgba(245,158,11,0.2)',    border: '#d97706', accent: '#f59e0b' },
  text:     { bg: 'rgba(236,72,153,0.25)',   border: '#ec4899', accent: '#f472b6' },
  caption:  { bg: 'rgba(148,163,184,0.2)',   border: '#94a3b8', accent: '#cbd5e1' },
  ambience: { bg: 'rgba(245,158,11,0.15)',   border: '#92400e', accent: '#d97706' },
};

export const DEFAULT_TRACKS: Track[] = [
  { id: 'visuals',    name: 'Visuals',          type: 'video',   locked: false, visible: true, muted: false },
  { id: 'gen-motion', name: 'Generated Motion',  type: 'video',   locked: false, visible: true, muted: false },
  { id: 'titles',     name: 'Titles',            type: 'text',    locked: false, visible: true, muted: false },
  { id: 'subtitles',  name: 'Subtitles',         type: 'caption', locked: false, visible: true, muted: false },
  { id: 'dialog',     name: 'Dialog',            type: 'dialog',  locked: false, visible: true, muted: false },
  { id: 'music',      name: 'Music',             type: 'music',   locked: false, visible: true, muted: false },
  { id: 'sfx',        name: 'SFX',               type: 'sfx',     locked: false, visible: true, muted: false },
  { id: 'ambience',   name: 'Ambience',          type: 'ambience',locked: false, visible: true, muted: false },
];

export const KEYFRAMEABLE: Record<string, { min: number; max: number; def: number }> = {
  volume:    { min: 0, max: 200, def: 100 },
  opacity:   { min: 0, max: 100, def: 100 },
  scale:     { min: 0, max: 1000, def: 100 },
  rotation:  { min: -360, max: 360, def: 0 },
  positionX: { min: -9999, max: 9999, def: 0 },
  positionY: { min: -9999, max: 9999, def: 0 },
  speed:     { min: 0.1, max: 10, def: 1 },
  fontSize:  { min: 1, max: 999, def: 32 },
  letterSpacing: { min: -10, max: 50, def: 0 },
  lineHeight: { min: 0.5, max: 5, def: 1.4 },
  strength:  { min: 0, max: 1, def: 0.7 },
  motionIntensity: { min: 0, max: 100, def: 5 },
};

// ── Types ──────────────────────────────────────────────────

export interface Keyframe {
  time: number;
  value: number;
  easing: 'linear' | 'constant' | 'bezier';
}

export interface Clip {
  id: string;
  elementId?: string;
  trackId: string;
  type: string; // 'image' | 'video' | 'dialog' | 'music' | 'sfx' | 'text' | 'caption' | 'ambience'
  name: string;
  startTime: number;
  duration: number;
  characterName?: string;
  characterId?: string;
  lines?: string[];
  content?: string;
  color?: string;
  filePath?: string;
  fileName?: string;
  cameraMovement?: string;
  frameSize?: string;
  source?: string;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
  opacity?: number;
  speed?: number;
  keyframes?: Record<string, Keyframe[]>;
  _objectUrl?: string;
  _file?: File;
}

export interface Track {
  id: string;
  name: string;
  type: string;
  locked: boolean;
  visible: boolean;
  muted: boolean;
}

export interface EditorScene {
  id: string;
  name: string;
  duration: number;
  startTime: number;
  children: string[];
  color: string;
}

export interface EditorCharacter {
  id: string;
  name: string;
  displayName?: string;
  headshot?: string;
  image?: string;
}

export interface EditorAsset {
  id?: string;
  name?: string;
  type?: string;
  filePath?: string;
  metadata?: Record<string, any>;
}

export interface RenderSettings {
  resolutionX: number;
  resolutionY: number;
  resolutionPct: number;
  fps: number;
  frameStart: number;
  frameEnd: number | null;
  outputPath: string;
  format: string;
  quality: string;
}

export interface EditorState {
  currentTime: number;
  duration: number;
  fps: number;
  resolution: string;
  zoom: number;
  timelineZoom: number;
  playing: boolean;
  snapEnabled: boolean;
  fillGaps: boolean;
  selectedClipId: string | null;
  selectedTrackId: string | null;
  sidebarTab: string;
  inspectorTab: string;
  tracks: Track[];
  clips: Clip[];
  scenes: EditorScene[];
  characters: EditorCharacter[];
  assets: EditorAsset[];
  markers: any[];
  previsMap: Record<string, string>;
  dialogAudioMap: Record<string, string>;
  dialogDurationMap: Record<string, number>;
  previewZoom: 'fit' | number;
  userClips: Clip[];
  timelineHeight: number;
  sidebarCollapsed: boolean;
  inspectorCollapsed: boolean;
  appSidebarCollapsed: boolean;
  renderSettings: RenderSettings;
  renderStatus: string | null;
  renderProgress: number;
  renderError: string | null;
  lastRenderPath: string | null;
}

export const initialEditorState: EditorState = {
  currentTime: 0,
  duration: 120,
  fps: 24,
  resolution: '1920x1080',
  zoom: 1,
  timelineZoom: 1,
  playing: false,
  snapEnabled: true,
  fillGaps: true,
  selectedClipId: null,
  selectedTrackId: null,
  sidebarTab: 'story',
  inspectorTab: 'clip',
  tracks: [],
  clips: [],
  scenes: [],
  characters: [],
  assets: [],
  markers: [],
  previsMap: {},
  dialogAudioMap: {},
  dialogDurationMap: {},
  previewZoom: 'fit',
  userClips: [],
  timelineHeight: 260,
  sidebarCollapsed: false,
  inspectorCollapsed: false,
  appSidebarCollapsed: false,
  renderSettings: {
    resolutionX: 1920, resolutionY: 1080, resolutionPct: 100,
    fps: 24, frameStart: 0, frameEnd: null,
    outputPath: '', format: 'mp4', quality: 'medium',
  },
  renderStatus: null,
  renderProgress: 0,
  renderError: null,
  lastRenderPath: null,
};

// ── Actions ────────────────────────────────────────────────

export type EditorAction =
  | { type: 'SET_DATA'; clips: Clip[]; scenes: EditorScene[]; characters: EditorCharacter[]; assets: EditorAsset[]; tracks: Track[]; duration: number; previsMap: Record<string, string>; dialogAudioMap: Record<string, string>; dialogDurationMap: Record<string, number>; userClips: Clip[] }
  | { type: 'SET_TIME'; time: number }
  | { type: 'TOGGLE_PLAY' }
  | { type: 'STOP_PLAY' }
  | { type: 'SET_SELECTED_CLIP'; clipId: string | null }
  | { type: 'SET_SIDEBAR_TAB'; tab: string }
  | { type: 'SET_TIMELINE_ZOOM'; zoom: number }
  | { type: 'SET_PREVIEW_ZOOM'; zoom: 'fit' | number }
  | { type: 'TOGGLE_SNAP' }
  | { type: 'TOGGLE_FILL_GAPS' }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'TOGGLE_INSPECTOR' }
  | { type: 'TOGGLE_APP_SIDEBAR' }
  | { type: 'SET_TIMELINE_HEIGHT'; height: number }
  | { type: 'UPDATE_CLIP'; clipId: string; updates: Partial<Clip> }
  | { type: 'DELETE_CLIP'; clipId: string }
  | { type: 'ADD_CLIP'; clip: Clip }
  | { type: 'SET_TRACK_MUTED'; trackId: string; muted: boolean }
  | { type: 'SET_RENDER_SETTINGS'; settings: Partial<RenderSettings> }
  | { type: 'SET_RENDER_STATUS'; status: string | null; progress?: number; error?: string | null; path?: string | null }
  | { type: 'SET_DIALOG_AUDIO'; elementId: string; filePath: string }
  | { type: 'SET_RESOLUTION'; resolution: string }
  | { type: 'SET_FPS'; fps: number }
  | { type: 'ADJUST_SCENE_TIMING'; sceneId: string; audioDurations: Record<string, number> };

// ── Reducer ────────────────────────────────────────────────

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'SET_DATA':
      return {
        ...state,
        clips: action.clips,
        scenes: action.scenes,
        characters: action.characters,
        assets: action.assets,
        tracks: action.tracks,
        duration: action.duration,
        previsMap: action.previsMap,
        dialogAudioMap: { ...state.dialogAudioMap, ...action.dialogAudioMap },
        dialogDurationMap: { ...state.dialogDurationMap, ...action.dialogDurationMap },
        userClips: action.userClips.length > 0 && state.userClips.length === 0
          ? action.userClips
          : state.userClips,
      };

    case 'SET_TIME':
      return { ...state, currentTime: Math.max(0, Math.min(action.time, state.duration)) };

    case 'TOGGLE_PLAY':
      return { ...state, playing: !state.playing };

    case 'STOP_PLAY':
      return { ...state, playing: false };

    case 'SET_SELECTED_CLIP':
      return { ...state, selectedClipId: action.clipId };

    case 'SET_SIDEBAR_TAB':
      return { ...state, sidebarTab: action.tab };

    case 'SET_TIMELINE_ZOOM':
      return { ...state, timelineZoom: Math.max(0.1, Math.min(4, action.zoom)) };

    case 'SET_PREVIEW_ZOOM':
      return { ...state, previewZoom: action.zoom };

    case 'TOGGLE_SNAP':
      return { ...state, snapEnabled: !state.snapEnabled };

    case 'TOGGLE_FILL_GAPS':
      return { ...state, fillGaps: !state.fillGaps };

    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed };

    case 'TOGGLE_INSPECTOR':
      return { ...state, inspectorCollapsed: !state.inspectorCollapsed };

    case 'TOGGLE_APP_SIDEBAR':
      return { ...state, appSidebarCollapsed: !state.appSidebarCollapsed };

    case 'SET_TIMELINE_HEIGHT':
      return { ...state, timelineHeight: Math.max(100, Math.min(800, action.height)) };

    case 'UPDATE_CLIP': {
      const clips = state.clips.map(c =>
        c.id === action.clipId ? { ...c, ...action.updates } : c
      );
      const userClips = state.userClips.map(c =>
        c.id === action.clipId ? { ...c, ...action.updates } : c
      );
      return { ...state, clips, userClips };
    }

    case 'DELETE_CLIP': {
      return {
        ...state,
        clips: state.clips.filter(c => c.id !== action.clipId),
        userClips: state.userClips.filter(c => c.id !== action.clipId),
        selectedClipId: state.selectedClipId === action.clipId ? null : state.selectedClipId,
      };
    }

    case 'ADD_CLIP':
      return {
        ...state,
        clips: [...state.clips, action.clip],
        userClips: [...state.userClips, action.clip],
        selectedClipId: action.clip.id,
      };

    case 'SET_TRACK_MUTED': {
      const tracks = state.tracks.map(t =>
        t.id === action.trackId ? { ...t, muted: action.muted } : t
      );
      return { ...state, tracks };
    }

    case 'SET_RENDER_SETTINGS':
      return { ...state, renderSettings: { ...state.renderSettings, ...action.settings } };

    case 'SET_RENDER_STATUS':
      return {
        ...state,
        renderStatus: action.status,
        renderProgress: action.progress ?? state.renderProgress,
        renderError: action.error !== undefined ? action.error : state.renderError,
        lastRenderPath: action.path !== undefined ? action.path : state.lastRenderPath,
      };

    case 'SET_DIALOG_AUDIO':
      return {
        ...state,
        dialogAudioMap: { ...state.dialogAudioMap, [action.elementId]: action.filePath },
      };

    case 'SET_RESOLUTION':
      return { ...state, resolution: action.resolution };

    case 'SET_FPS':
      return { ...state, fps: action.fps };

    case 'ADJUST_SCENE_TIMING': {
      // Adjust a scene's duration and its clips based on actual audio durations.
      // audioDurations maps elementId → seconds of audio.
      const scene = state.scenes.find(s => s.id === action.sceneId);
      if (!scene) return state;

      // Gather dialog clips in this scene, sorted by startTime
      const sceneClips = state.clips
        .filter(c => c.startTime >= scene.startTime && c.startTime < scene.startTime + scene.duration)
        .sort((a, b) => a.startTime - b.startTime);

      const dialogClips = sceneClips.filter(c => c.trackId === 'dialog');
      const otherClips = sceneClips.filter(c => c.trackId !== 'dialog');

      // Compute new total duration from audio durations + small gaps
      const GAP = 0.3;
      let totalAudioDur = 0;
      for (const dc of dialogClips) {
        const audioDur = action.audioDurations[dc.elementId || ''];
        totalAudioDur += (audioDur || dc.duration) + GAP;
      }
      const newSceneDur = Math.max(totalAudioDur, 2);

      // Redistribute dialog clips sequentially with audio durations
      const newClips = [...state.clips];
      let offset = scene.startTime;
      for (const dc of dialogClips) {
        const audioDur = action.audioDurations[dc.elementId || ''] || dc.duration;
        const idx = newClips.findIndex(c => c.id === dc.id);
        if (idx >= 0) {
          newClips[idx] = { ...newClips[idx], startTime: offset, duration: audioDur };
        }
        offset += audioDur + GAP;
      }

      // Redistribute non-dialog clips (subtitles, visuals) proportionally
      const scale = newSceneDur / scene.duration;
      for (const oc of otherClips) {
        const idx = newClips.findIndex(c => c.id === oc.id);
        if (idx >= 0) {
          const relStart = oc.startTime - scene.startTime;
          newClips[idx] = {
            ...newClips[idx],
            startTime: scene.startTime + relStart * scale,
            duration: oc.duration * scale,
          };
        }
      }

      // Shift all clips AFTER this scene by the duration change
      const durDelta = newSceneDur - scene.duration;
      if (Math.abs(durDelta) > 0.01) {
        const afterTime = scene.startTime + scene.duration;
        for (let i = 0; i < newClips.length; i++) {
          if (newClips[i].startTime >= afterTime) {
            newClips[i] = { ...newClips[i], startTime: newClips[i].startTime + durDelta };
          }
        }
      }

      // Update scenes
      const newScenes = state.scenes.map(s => {
        if (s.id === action.sceneId) return { ...s, duration: newSceneDur };
        if (s.startTime > scene.startTime) return { ...s, startTime: s.startTime + durDelta };
        return s;
      });

      return {
        ...state,
        clips: newClips,
        scenes: newScenes,
        duration: Math.max(state.duration + durDelta, 60),
        dialogDurationMap: { ...state.dialogDurationMap, ...action.audioDurations },
      };
    }

    default:
      return state;
  }
}

// ── Helpers ────────────────────────────────────────────────

export function formatTimecode(seconds: number, fps = 24): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const f = Math.floor((seconds % 1) * fps);
  return (h > 0 ? String(h).padStart(2, '0') + ':' : '') +
    String(m).padStart(2, '0') + ':' +
    String(s).padStart(2, '0') + ':' +
    String(f).padStart(2, '0');
}

export function parseTimecodeToSeconds(str: string, fps = 24): number {
  str = (str || '').trim();
  if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);
  const parts = str.split(':').map(Number);
  if (parts.length === 4) return parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / fps;
  if (parts.length === 3) return parts[0] * 60 + parts[1] + parts[2] / fps;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return NaN;
}

export function pxPerSec(zoom: number): number {
  return PX_PER_SEC * zoom;
}

export function timeToPx(t: number, zoom: number): number {
  return t * pxPerSec(zoom);
}

export function pxToTime(px: number, zoom: number): number {
  return px / pxPerSec(zoom);
}

export function charColor(name: string): string {
  const colors = ['#f472b6','#a78bfa','#60a5fa','#34d399','#fbbf24','#fb923c','#f87171','#38bdf8','#4ade80','#e879f9'];
  let hash = 0;
  const str = name || '';
  for (let i = 0; i < str.length; i++) hash = ((hash << 5) - hash) + str.charCodeAt(i);
  return colors[Math.abs(hash) % colors.length];
}

export function imgSrc(filePath: string): string {
  return '/api/file?path=' + encodeURIComponent(filePath);
}

export function genId(): string {
  return 'clip-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function stableId(prefix: string, elementId?: string): string {
  return elementId ? ('clip-' + prefix + '-' + elementId) : genId();
}

export function getClipAtTime(clips: Clip[], time: number, trackId?: string): Clip | null {
  let found: Clip | null = null;
  for (const c of clips) {
    if (trackId && c.trackId !== trackId) continue;
    if (time >= c.startTime && time < c.startTime + c.duration) {
      found = c;
    }
  }
  return found;
}

export function evaluateKeyframes(clip: Clip, prop: string, localTime: number): number {
  const fallback = (clip as any)[prop] != null ? (clip as any)[prop] : (KEYFRAMEABLE[prop] ? KEYFRAMEABLE[prop].def : 0);
  if (!clip.keyframes || !clip.keyframes[prop] || clip.keyframes[prop].length === 0) return fallback;
  const kfs = clip.keyframes[prop];
  if (kfs.length === 1) return kfs[0].value;
  if (localTime <= kfs[0].time) return kfs[0].value;
  if (localTime >= kfs[kfs.length - 1].time) return kfs[kfs.length - 1].value;
  for (let i = 0; i < kfs.length - 1; i++) {
    if (localTime >= kfs[i].time && localTime <= kfs[i + 1].time) {
      const k0 = kfs[i], k1 = kfs[i + 1];
      if (k0.easing === 'constant') return k0.value;
      let t = (localTime - k0.time) / (k1.time - k0.time);
      if (k0.easing === 'bezier') t = t * t * (3 - 2 * t);
      return k0.value + (k1.value - k0.value) * t;
    }
  }
  return fallback;
}
