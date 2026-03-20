/**
 * PipelineProvider — Split into 3 contexts for fine-grained re-rendering:
 *
 * 1. PipelineIdentity — pipelineId, name, folder, loading/saving state (rarely changes)
 * 2. ProjectData — characters, locations, elements, sections, previs (changes on edits)
 * 3. AIOperations — enrichment & generation actions with own progress state
 *
 * The legacy `usePipeline()` hook still works — it merges all 3 contexts for backward compat.
 */
import React, {
  createContext, useContext, useReducer, useCallback, useEffect, useRef, useMemo,
  useState, type ReactNode,
} from 'react';
import type { ProjectData, Character, Location, Section, Element, ScriptMetadata, SceneData } from './pipeline-store';
import { buildScenes } from '../parsers/fountainParser';

// Re-export types — these come from pipeline-store which re-exports from project-types
export type { ProjectData, Character, Location, Section, Element, ScriptMetadata, SceneData, SceneShot, SceneDialogue };

// ════════════════════════════════════════════════════════════════
// Context 1: Pipeline Identity (rarely changes)
// ════════════════════════════════════════════════════════════════

interface IdentityState {
  pipelineId: string;
  pipelineName: string;
  projectFolder: string | null;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  error: string | null;
}

interface IdentityContextValue extends IdentityState {
  reload: () => Promise<void>;
  saveProject: () => Promise<void>;
  clearProject: () => Promise<void>;
  setProjectFolder: (folder: string) => Promise<void>;
}

const IdentityContext = createContext<IdentityContextValue | null>(null);

export function usePipelineIdentity(): IdentityContextValue {
  const ctx = useContext(IdentityContext);
  if (!ctx) throw new Error('usePipelineIdentity must be used within PipelineProvider');
  return ctx;
}

// ════════════════════════════════════════════════════════════════
// Context 2: Project Data (changes on edits)
// ════════════════════════════════════════════════════════════════

interface ProjectContextValue {
  project: ProjectData | null;
  updateProject: (partial: Partial<ProjectData>) => void;
  updateCharacter: (id: string, data: Partial<Character>) => void;
  updateLocation: (id: string, data: Partial<Location>) => void;
  updateElement: (id: string, data: Partial<Element>) => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProjectData(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProjectData must be used within PipelineProvider');
  return ctx;
}

// ════════════════════════════════════════════════════════════════
// Context 3: AI Operations (async, long-running)
// ════════════════════════════════════════════════════════════════

interface AIOperationsContextValue {
  enrichCharacter: (id: string) => Promise<void>;
  enrichLocation: (id: string) => Promise<void>;
  enrichAllCharacters: () => Promise<void>;
  enrichAllLocations: () => Promise<void>;
  generateCharacterImages: () => Promise<any>;
  generateLocationImages: () => Promise<any>;
}

const AIOperationsContext = createContext<AIOperationsContextValue | null>(null);

export function useAIOperations(): AIOperationsContextValue {
  const ctx = useContext(AIOperationsContext);
  if (!ctx) throw new Error('useAIOperations must be used within PipelineProvider');
  return ctx;
}

// ════════════════════════════════════════════════════════════════
// Reducer (shared state machine)
// ════════════════════════════════════════════════════════════════

interface FullState {
  pipelineId: string;
  pipelineName: string;
  projectFolder: string | null;
  project: ProjectData | null;
  loading: boolean;
  error: string | null;
  saving: boolean;
  dirty: boolean;
}

const initialState: FullState = {
  pipelineId: '',
  pipelineName: '',
  projectFolder: null,
  project: null,
  loading: true,
  error: null,
  saving: false,
  dirty: false,
};

type Action =
  | { type: 'LOADING' }
  | { type: 'LOADED'; project: ProjectData; pipelineName: string; projectFolder: string | null }
  | { type: 'REFRESH'; project: ProjectData; pipelineName: string; projectFolder: string | null }
  | { type: 'ERROR'; error: string }
  | { type: 'SAVING' }
  | { type: 'SAVED' }
  | { type: 'UPDATE_PROJECT'; partial: Partial<ProjectData> }
  | { type: 'UPDATE_CHARACTER'; id: string; data: Partial<Character> }
  | { type: 'UPDATE_LOCATION'; id: string; data: Partial<Location> }
  | { type: 'UPDATE_ELEMENT'; id: string; data: Partial<Element> }
  | { type: 'SET_PROJECT_FOLDER'; folder: string }
  | { type: 'CLEAR' };

function reducer(state: FullState, action: Action): FullState {
  switch (action.type) {
    case 'LOADING':
      return { ...state, loading: true, error: null };
    case 'LOADED':
      return { ...state, loading: false, project: action.project, pipelineName: action.pipelineName, projectFolder: action.projectFolder };
    case 'REFRESH':
      return { ...state, project: action.project, pipelineName: action.pipelineName, projectFolder: action.projectFolder, dirty: false };
    case 'ERROR':
      return { ...state, loading: false, error: action.error };
    case 'SAVING':
      return { ...state, saving: true };
    case 'SAVED':
      return { ...state, saving: false, dirty: false };
    case 'UPDATE_PROJECT':
      if (!state.project) return state;
      return { ...state, project: { ...state.project, ...action.partial, updatedAt: new Date().toISOString() }, dirty: true };
    case 'UPDATE_CHARACTER': {
      if (!state.project) return state;
      const chars = state.project.characters.map(c => c.id === action.id ? { ...c, ...action.data } : c);
      return { ...state, project: { ...state.project, characters: chars }, dirty: true };
    }
    case 'UPDATE_LOCATION': {
      if (!state.project) return state;
      const locs = state.project.locations.map(l => l.id === action.id ? { ...l, ...action.data } : l);
      return { ...state, project: { ...state.project, locations: locs }, dirty: true };
    }
    case 'UPDATE_ELEMENT': {
      if (!state.project) return state;
      const elems = state.project.elements.map(e => e.id === action.id ? { ...e, ...action.data } : e);
      return { ...state, project: { ...state.project, elements: elems }, dirty: true };
    }
    case 'SET_PROJECT_FOLDER':
      return { ...state, projectFolder: action.folder };
    case 'CLEAR':
      return { ...initialState, pipelineId: state.pipelineId, loading: false };
    default:
      return state;
  }
}

// ════════════════════════════════════════════════════════════════
// Combined Provider
// ════════════════════════════════════════════════════════════════

export function PipelineProvider({ pipelineId, children }: { pipelineId: string; children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { ...initialState, pipelineId });

  // ── Load pipeline data ─────────────────────────────────────
  const initialLoadDone = useRef(false);

  const reload = useCallback(async () => {
    const isInitial = !initialLoadDone.current;
    if (isInitial) dispatch({ type: 'LOADING' });
    try {
      // Try new /api/project/:id endpoint first (single source of truth)
      const projectRes = await fetch(`/api/project/${encodeURIComponent(pipelineId)}`);

      let project: ProjectData | null = null;
      let pipelineName = pipelineId;
      let projectFolder: string | null = null;

      if (projectRes.ok) {
        const data = await projectRes.json();
        project = data.project;
        pipelineName = data.pipelineName || pipelineId;
        projectFolder = data.projectFolder || null;
      } else {
        // Fallback to legacy endpoints
        const [schemaRes, stateRes] = await Promise.all([
          fetch(`/api/app/${encodeURIComponent(pipelineId)}/schema`),
          fetch(`/api/app/${encodeURIComponent(pipelineId)}/state`),
        ]);
        const schema = await schemaRes.json();
        const appState = await stateRes.json();
        project = extractProjectData(appState, pipelineId);
        pipelineName = schema?.name || appState?.pipelineName || pipelineId;

        try {
          const compRes = await fetch(`/api/compositions/${encodeURIComponent(pipelineId)}`);
          const comp = await compRes.json();
          projectFolder = comp?.composition?.metadata?.projectFolder || null;
        } catch {}
      }

      // Auto-compute scenes if not present
      if (project && (!project.scenes || project.scenes.length === 0)) {
        project.scenes = computeScenes(project);
      }

      initialLoadDone.current = true;
      dispatch({
        type: isInitial ? 'LOADED' : 'REFRESH',
        project: project || createEmptyProject(pipelineId),
        pipelineName,
        projectFolder,
      });
    } catch (err: any) {
      dispatch({ type: 'ERROR', error: err.message });
    }
  }, [pipelineId]);

  useEffect(() => { reload(); }, [reload]);

  // ── Save project data ──────────────────────────────────────
  const saveProject = useCallback(async () => {
    if (!state.project) return;
    dispatch({ type: 'SAVING' });
    try {
      // Use new PATCH /api/project/:id endpoint (single path)
      const res = await fetch(`/api/project/${encodeURIComponent(pipelineId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: state.project }),
      });

      if (!res.ok) {
        // Fallback to legacy PUT endpoint
        await fetch(`/api/app/${encodeURIComponent(pipelineId)}/project`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: state.project }),
        });
      }

      dispatch({ type: 'SAVED' });
    } catch (err: any) {
      dispatch({ type: 'ERROR', error: 'Save failed: ' + err.message });
    }
  }, [pipelineId, state.project]);

  // Auto-save when dirty (debounced)
  useEffect(() => {
    if (!state.dirty) return;
    const timer = setTimeout(() => saveProject(), 2000);
    return () => clearTimeout(timer);
  }, [state.dirty, saveProject]);

  // ── Clear project ──────────────────────────────────────────
  const clearProjectAction = useCallback(async () => {
    // Try new endpoint first, fall back to legacy
    const res = await fetch(`/api/project/${encodeURIComponent(pipelineId)}`, { method: 'DELETE' });
    if (!res.ok) {
      await fetch(`/api/app/${encodeURIComponent(pipelineId)}/state`, { method: 'DELETE' });
    }
    dispatch({ type: 'CLEAR' });
  }, [pipelineId]);

  // ── Set project folder ─────────────────────────────────────
  const setProjectFolder = useCallback(async (folder: string) => {
    await fetch(`/api/compositions/${encodeURIComponent(pipelineId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata: { projectFolder: folder } }),
    });
    dispatch({ type: 'SET_PROJECT_FOLDER', folder });
  }, [pipelineId]);

  // ── Entity mutations ───────────────────────────────────────
  const updateProject = useCallback((partial: Partial<ProjectData>) => {
    dispatch({ type: 'UPDATE_PROJECT', partial });
  }, []);

  const updateCharacter = useCallback((id: string, data: Partial<Character>) => {
    dispatch({ type: 'UPDATE_CHARACTER', id, data });
  }, []);

  const updateLocation = useCallback((id: string, data: Partial<Location>) => {
    dispatch({ type: 'UPDATE_LOCATION', id, data });
  }, []);

  const updateElement = useCallback((id: string, data: Partial<Element>) => {
    dispatch({ type: 'UPDATE_ELEMENT', id, data });
  }, []);

  // ── AI Enrichment ──────────────────────────────────────────
  const enrichCharacter = useCallback(async (id: string) => {
    const char = state.project?.characters.find(c => c.id === id);
    if (!char || !state.project) return;

    const prompt = buildCharacterEnrichPrompt(char, state.project);
    const res = await fetch('/api/chat/one-shot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: prompt }),
    });
    const { response } = await res.json();
    const match = response?.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AI did not return JSON');
    const enriched = JSON.parse(match[0]);
    dispatch({ type: 'UPDATE_CHARACTER', id, data: enriched });
  }, [state.project]);

  const enrichLocation = useCallback(async (id: string) => {
    const loc = state.project?.locations.find(l => l.id === id);
    if (!loc) return;

    const prompt = `Analyze this location from a screenplay:\n\nLocation: ${loc.name}\n\nReturn a JSON object with: description, type (interior/exterior), mood, setting, atmosphere.\nReturn ONLY the JSON object.`;
    const res = await fetch('/api/chat/one-shot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: prompt }),
    });
    const { response } = await res.json();
    const match = response?.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AI did not return JSON');
    const enriched = JSON.parse(match[0]);
    dispatch({ type: 'UPDATE_LOCATION', id, data: enriched });
  }, [state.project]);

  const enrichAllCharacters = useCallback(async () => {
    for (const char of state.project?.characters || []) {
      if (!char.description || char.description.length < 20) {
        await enrichCharacter(char.id);
      }
    }
  }, [state.project, enrichCharacter]);

  const enrichAllLocations = useCallback(async () => {
    for (const loc of state.project?.locations || []) {
      if (!loc.description || loc.description.length < 20) {
        await enrichLocation(loc.id);
      }
    }
  }, [state.project, enrichLocation]);

  // ── Image Generation ───────────────────────────────────────
  const generateCharacterImages = useCallback(async () => {
    const poll = setInterval(() => { reload(); }, 5000);
    try {
      const res = await fetch(`/api/app/${encodeURIComponent(pipelineId)}/generate-assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'characters' }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Generation failed');
      return result;
    } finally {
      clearInterval(poll);
      await reload();
    }
  }, [pipelineId, reload]);

  const generateLocationImages = useCallback(async () => {
    const poll = setInterval(() => { reload(); }, 5000);
    try {
      const res = await fetch(`/api/app/${encodeURIComponent(pipelineId)}/generate-assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'locations' }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Generation failed');
      return result;
    } finally {
      clearInterval(poll);
      await reload();
    }
  }, [pipelineId, reload]);

  // ── Memoized context values (only re-create when deps change) ──

  const identityValue = useMemo<IdentityContextValue>(() => ({
    pipelineId: state.pipelineId,
    pipelineName: state.pipelineName,
    projectFolder: state.projectFolder,
    loading: state.loading,
    saving: state.saving,
    dirty: state.dirty,
    error: state.error,
    reload,
    saveProject,
    clearProject: clearProjectAction,
    setProjectFolder,
  }), [state.pipelineId, state.pipelineName, state.projectFolder, state.loading, state.saving, state.dirty, state.error, reload, saveProject, clearProjectAction, setProjectFolder]);

  const projectValue = useMemo<ProjectContextValue>(() => ({
    project: state.project,
    updateProject,
    updateCharacter,
    updateLocation,
    updateElement,
  }), [state.project, updateProject, updateCharacter, updateLocation, updateElement]);

  const aiValue = useMemo<AIOperationsContextValue>(() => ({
    enrichCharacter,
    enrichLocation,
    enrichAllCharacters,
    enrichAllLocations,
    generateCharacterImages,
    generateLocationImages,
  }), [enrichCharacter, enrichLocation, enrichAllCharacters, enrichAllLocations, generateCharacterImages, generateLocationImages]);

  return (
    <IdentityContext.Provider value={identityValue}>
      <ProjectContext.Provider value={projectValue}>
        <AIOperationsContext.Provider value={aiValue}>
          {children}
        </AIOperationsContext.Provider>
      </ProjectContext.Provider>
    </IdentityContext.Provider>
  );
}

// ════════════════════════════════════════════════════════════════
// Legacy Hook — merges all 3 contexts (backward compatible)
// ════════════════════════════════════════════════════════════════

// Keep old state shape for backward compat
export interface PipelineContextState {
  pipelineId: string;
  pipelineName: string;
  projectFolder: string | null;
  project: ProjectData | null;
  loading: boolean;
  error: string | null;
  saving: boolean;
  dirty: boolean;
}

interface PipelineContextValue extends PipelineContextState {
  reload: () => Promise<void>;
  updateProject: (partial: Partial<ProjectData>) => void;
  saveProject: () => Promise<void>;
  clearProject: () => Promise<void>;
  setProjectFolder: (folder: string) => Promise<void>;
  updateCharacter: (id: string, data: Partial<Character>) => void;
  updateLocation: (id: string, data: Partial<Location>) => void;
  updateElement: (id: string, data: Partial<Element>) => void;
  enrichCharacter: (id: string) => Promise<void>;
  enrichLocation: (id: string) => Promise<void>;
  enrichAllCharacters: () => Promise<void>;
  enrichAllLocations: () => Promise<void>;
  generateCharacterImages: () => Promise<any>;
  generateLocationImages: () => Promise<any>;
}

/**
 * Legacy hook — subscribes to ALL 3 contexts.
 * Use the specific hooks (usePipelineIdentity, useProjectData, useAIOperations) for better perf.
 */
export function usePipeline(): PipelineContextValue {
  const identity = usePipelineIdentity();
  const projectCtx = useProjectData();
  const ai = useAIOperations();
  return {
    ...identity,
    ...projectCtx,
    ...ai,
  };
}

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════

function createEmptyProject(pipelineId: string): ProjectData {
  return {
    version: '1.0',
    pipelineId,
    metadata: { title: 'Untitled' } as ScriptMetadata,
    characters: [],
    locations: [],
    sections: [],
    elements: [],
  };
}

function extractProjectData(appState: any, pipelineId: string): ProjectData | null {
  if (!appState?.nodeData) return null;

  const nd = appState.nodeData;
  let metadata: any = {};
  let characters: any[] = [];
  let locations: any[] = [];
  let sections: any[] = [];
  let elements: any[] = [];
  let previs: any = { shots: [] };
  let assets: any[] = [];
  let fountain = '';

  // Assembly node first (single source of truth)
  const assembly = nd['node-15'];
  if (assembly) {
    const sp = assembly.outputs?.scriptPackage || assembly.scriptPackage;
    const script = sp?.script || sp;
    if (script) {
      metadata = script.metadata || {};
      characters = script.characters || [];
      locations = script.locations || [];
      sections = script.sections || [];
      elements = script.elements || [];
    }
    if (sp?.previsualizations) previs = sp.previsualizations;
    if (sp?.assets) assets = sp.assets;
    fountain = assembly.outputs?._fountainSource || assembly._fountainSource || '';
  }

  // Fill gaps from individual nodes
  if (!characters.length) characters = nd['node-5']?.outputs?.characters || nd['node-5']?.characters || [];
  if (!locations.length) locations = nd['node-6']?.outputs?.locations || nd['node-6']?.locations || [];
  if (!sections.length) sections = nd['node-7']?.outputs?.sections || nd['node-7']?.sections || [];
  if (!elements.length) elements = nd['node-10']?.outputs?.elements || nd['node-10']?.elements || [];
  if (!Object.keys(metadata).length) metadata = nd['node-4']?.outputs?.metadata || nd['node-4']?.metadata || {};

  return { version: '1.0', pipelineId, metadata, characters, locations, sections, elements, previsualizations: previs, assets, _fountainSource: fountain };
}

function computeScenes(project: ProjectData): SceneData[] {
  const scenes = buildScenes({
    sections: project.sections as any,
    elements: project.elements as any,
    characters: project.characters,
    locations: project.locations,
  });

  // Link previs paths from previsualizations
  if (project.previsualizations?.shots) {
    const previsMap: Record<string, any> = {};
    for (const p of project.previsualizations.shots) {
      if (p.shotElementId) previsMap[p.shotElementId] = p;
    }
    for (const scene of scenes) {
      for (const shot of scene.shots) {
        const prev = previsMap[shot.id];
        if (prev) {
          shot.previsPath = prev.filePath || prev._generatedFilePath;
          shot.generatedAt = prev._generatedAt;
        }
      }
    }
  }

  return scenes;
}

function buildCharacterEnrichPrompt(char: Character, project: ProjectData): string {
  const dialogues = project.elements.filter(e => e.type === 'dialogue' && e.characterName === char.name).slice(0, 10);
  const samples = dialogues.map(d => `${char.name}: "${(d.lines?.join(' ') || d.content || '').substring(0, 150)}"`).join('\n');
  const others = project.characters.filter(c => c.id !== char.id).map(c => c.name).join(', ');

  return `Analyze this character from a screenplay:\n\nCharacter: ${char.name}\nRole: ${char.role || 'unknown'}\n\nDialogue:\n${samples}\n\nOther characters: ${others}\n\nReturn JSON with: description, ageRange, gender, traits (5), arc, voiceDescription, wardrobeNotes, relationships [{characterName, type}].\nReturn ONLY JSON.`;
}
