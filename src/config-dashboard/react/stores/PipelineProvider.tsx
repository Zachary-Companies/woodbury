/**
 * PipelineProvider — React Context provider for centralized pipeline data.
 *
 * This is the single source of truth for all pipeline data in the client.
 * All components read from this context, and all writes go through it.
 */
import React, { createContext, useContext, useReducer, useCallback, useEffect, type ReactNode } from 'react';
import type { ProjectData, Character, Location, Section, Element, ScriptMetadata } from './pipeline-store';

// Re-export types
export type { ProjectData, Character, Location, Section, Element, ScriptMetadata };

// ── State ────────────────────────────────────────────────────

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

const initialState: PipelineContextState = {
  pipelineId: '',
  pipelineName: '',
  projectFolder: null,
  project: null,
  loading: true,
  error: null,
  saving: false,
  dirty: false,
};

// ── Actions ──────────────────────────────────────────────────

type Action =
  | { type: 'LOADING' }
  | { type: 'LOADED'; project: ProjectData; pipelineName: string; projectFolder: string | null }
  | { type: 'ERROR'; error: string }
  | { type: 'SAVING' }
  | { type: 'SAVED' }
  | { type: 'UPDATE_PROJECT'; partial: Partial<ProjectData> }
  | { type: 'UPDATE_CHARACTER'; id: string; data: Partial<Character> }
  | { type: 'UPDATE_LOCATION'; id: string; data: Partial<Location> }
  | { type: 'UPDATE_ELEMENT'; id: string; data: Partial<Element> }
  | { type: 'SET_PROJECT_FOLDER'; folder: string }
  | { type: 'CLEAR' };

function reducer(state: PipelineContextState, action: Action): PipelineContextState {
  switch (action.type) {
    case 'LOADING':
      return { ...state, loading: true, error: null };
    case 'LOADED':
      return { ...state, loading: false, project: action.project, pipelineName: action.pipelineName, projectFolder: action.projectFolder };
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

// ── Context ──────────────────────────────────────────────────

interface PipelineContextValue extends PipelineContextState {
  // Data loading
  reload: () => Promise<void>;

  // Project-level mutations
  updateProject: (partial: Partial<ProjectData>) => void;
  saveProject: () => Promise<void>;
  clearProject: () => Promise<void>;
  setProjectFolder: (folder: string) => Promise<void>;

  // Entity mutations
  updateCharacter: (id: string, data: Partial<Character>) => void;
  updateLocation: (id: string, data: Partial<Location>) => void;
  updateElement: (id: string, data: Partial<Element>) => void;

  // AI operations
  enrichCharacter: (id: string) => Promise<void>;
  enrichLocation: (id: string) => Promise<void>;
  enrichAllCharacters: () => Promise<void>;
  enrichAllLocations: () => Promise<void>;
  generateCharacterImages: () => Promise<any>;
  generateLocationImages: () => Promise<any>;
}

const PipelineContext = createContext<PipelineContextValue | null>(null);

// ── Provider ─────────────────────────────────────────────────

export function PipelineProvider({ pipelineId, children }: { pipelineId: string; children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { ...initialState, pipelineId });

  // ── Load pipeline data ─────────────────────────────────────
  const reload = useCallback(async () => {
    dispatch({ type: 'LOADING' });
    try {
      const [schemaRes, stateRes] = await Promise.all([
        fetch(`/api/app/${encodeURIComponent(pipelineId)}/schema`),
        fetch(`/api/app/${encodeURIComponent(pipelineId)}/state`),
      ]);
      const schema = await schemaRes.json();
      const appState = await stateRes.json();
      const project = extractProjectData(appState, pipelineId);

      let projectFolder: string | null = null;
      try {
        const compRes = await fetch(`/api/compositions/${encodeURIComponent(pipelineId)}`);
        const comp = await compRes.json();
        projectFolder = comp?.composition?.metadata?.projectFolder || null;
      } catch {}

      dispatch({
        type: 'LOADED',
        project: project || createEmptyProject(pipelineId),
        pipelineName: schema?.name || appState?.pipelineName || pipelineId,
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
      if (state.projectFolder) {
        await fetch(`/api/app/${encodeURIComponent(pipelineId)}/project`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: state.project }),
        });
      } else {
        await fetch(`/api/app/${encodeURIComponent(pipelineId)}/state/node-15`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            outputs: {
              scriptPackage: {
                script: {
                  metadata: state.project.metadata,
                  characters: state.project.characters,
                  locations: state.project.locations,
                  sections: state.project.sections,
                  elements: state.project.elements,
                },
                previsualizations: state.project.previsualizations || { shots: [] },
                assets: state.project.assets || [],
              },
              _fountainSource: state.project._fountainSource,
            },
          }),
        });
      }
      dispatch({ type: 'SAVED' });
    } catch (err: any) {
      dispatch({ type: 'ERROR', error: 'Save failed: ' + err.message });
    }
  }, [pipelineId, state.project, state.projectFolder]);

  // Auto-save when dirty (debounced)
  useEffect(() => {
    if (!state.dirty) return;
    const timer = setTimeout(() => saveProject(), 2000);
    return () => clearTimeout(timer);
  }, [state.dirty, saveProject]);

  // ── Clear project ──────────────────────────────────────────
  const clearProjectAction = useCallback(async () => {
    await fetch(`/api/app/${encodeURIComponent(pipelineId)}/state`, { method: 'DELETE' });
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
    const res = await fetch(`/api/app/${encodeURIComponent(pipelineId)}/generate-assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'characters' }),
    });
    const result = await res.json();
    await reload(); // Reload to get updated imagePaths
    return result;
  }, [pipelineId, reload]);

  const generateLocationImages = useCallback(async () => {
    const res = await fetch(`/api/app/${encodeURIComponent(pipelineId)}/generate-assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'locations' }),
    });
    const result = await res.json();
    await reload();
    return result;
  }, [pipelineId, reload]);

  // ── Context value ──────────────────────────────────────────
  const value: PipelineContextValue = {
    ...state,
    reload,
    updateProject,
    saveProject,
    clearProject: clearProjectAction,
    setProjectFolder,
    updateCharacter,
    updateLocation,
    updateElement,
    enrichCharacter,
    enrichLocation,
    enrichAllCharacters,
    enrichAllLocations,
    generateCharacterImages,
    generateLocationImages,
  };

  return <PipelineContext.Provider value={value}>{children}</PipelineContext.Provider>;
}

// ── Hook ─────────────────────────────────────────────────────

export function usePipeline(): PipelineContextValue {
  const ctx = useContext(PipelineContext);
  if (!ctx) throw new Error('usePipeline must be used within PipelineProvider');
  return ctx;
}

// ── Helpers ──────────────────────────────────────────────────

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

function buildCharacterEnrichPrompt(char: Character, project: ProjectData): string {
  const dialogues = project.elements.filter(e => e.type === 'dialogue' && e.characterName === char.name).slice(0, 10);
  const samples = dialogues.map(d => `${char.name}: "${(d.lines?.join(' ') || d.content || '').substring(0, 150)}"`).join('\n');
  const others = project.characters.filter(c => c.id !== char.id).map(c => c.name).join(', ');

  return `Analyze this character from a screenplay:\n\nCharacter: ${char.name}\nRole: ${char.role || 'unknown'}\n\nDialogue:\n${samples}\n\nOther characters: ${others}\n\nReturn JSON with: description, ageRange, gender, traits (5), arc, voiceDescription, wardrobeNotes, relationships [{characterName, type}].\nReturn ONLY JSON.`;
}
