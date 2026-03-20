/**
 * Pipeline App Store — shared state for React pipeline views.
 * Uses a simple pub/sub pattern with React hooks.
 */
import { useState, useEffect, useCallback } from 'react';

// ── Types ────────────────────────────────────────────────────

export interface Character {
  id: string;
  name: string;
  displayName?: string;
  role?: string;
  description?: string;
  ageRange?: string;
  gender?: string;
  traits?: string[];
  arc?: string;
  voiceDescription?: string;
  wardrobeNotes?: string;
  relationships?: Array<{ characterName: string; characterId?: string; type: string }>;
  aliases?: string[];
  imagePath?: string;
}

export interface Location {
  id: string;
  name: string;
  description?: string;
  type?: string;
  mood?: string;
  timeOfDay?: string;
  setting?: string;
  atmosphere?: string;
  imagePath?: string;
}

export interface Section {
  type: 'act' | 'scene';
  id?: string;
  title: string;
  location?: string;
  timeOfDay?: string;
  order?: number;
  children?: Section[];
}

export interface Element {
  id: string;
  type: 'dialogue' | 'action' | 'transition' | 'shot';
  content: string;
  characterName?: string;
  characterId?: string;
  lines?: string[];
  modifiers?: string[];
  shotText?: string;
}

// ── Scene-grouped data model ─────────────────────────────────

export interface SceneShot {
  id: string;
  shotType: string;           // "WIDE SHOT", "CLOSE-UP", etc.
  description: string;        // vivid description of what the camera captures
  characterIds: string[];     // characters visible in this shot
  previsPath?: string;        // path to generated previs image
  generatedAt?: string;
}

export interface SceneDialogue {
  elementId: string;          // ref to original element
  characterId: string;
  characterName: string;
  lines: string[];
  modifiers?: string[];
}

export interface SceneData {
  id: string;
  title: string;              // "INT. HERN'S DEPARTMENT STORE - DAY"
  location: string;           // "HERN'S DEPARTMENT STORE"
  locationId?: string;        // ref to locations[]
  timeOfDay?: string;
  actTitle?: string;
  characterIds: string[];     // all characters who speak or appear
  dialogue: SceneDialogue[];  // ordered dialogue in scene
  actions: string[];          // action/description text
  shots: SceneShot[];         // camera shots for previs
  elementRange: [number, number]; // [start, end) indices into elements[]
}

export interface ScriptMetadata {
  title: string;
  subtitle?: string;
  logline?: string;
  author?: Array<{ name: string; role: string }>;
  genre?: string[];
  tone?: string[];
  runtimeMinutes?: number;
  estimatedPages?: number;
  draftDate?: string;
  version?: string;
}

export interface ProjectData {
  version: string;
  pipelineId: string;
  createdAt?: string;
  updatedAt?: string;
  metadata: ScriptMetadata;
  characters: Character[];
  locations: Location[];
  sections: Section[];
  elements: Element[];
  scenes?: SceneData[];         // scene-grouped view of the data
  previsualizations?: { shots: any[] };
  assets?: any[];
  _fountainSource?: string;
}

export interface PipelineState {
  pipelineId: string;
  pipelineName: string;
  projectFolder: string | null;
  projectData: ProjectData | null;
  loading: boolean;
  error: string | null;
  activeView: 'data' | 'screenplay' | 'editor' | 'script' | 'voices';
  activeSection: string | null;
  selectedCharacterId: string | null;
  selectedLocationId: string | null;
}

// ── Store ────────────────────────────────────────────────────

type Listener = () => void;

let state: PipelineState = {
  pipelineId: '',
  pipelineName: '',
  projectFolder: null,
  projectData: null,
  loading: false,
  error: null,
  activeView: 'screenplay',
  activeSection: null,
  selectedCharacterId: null,
  selectedLocationId: null,
};

const listeners = new Set<Listener>();

function notify() {
  listeners.forEach(fn => fn());
}

export function getState(): PipelineState {
  return state;
}

export function setState(partial: Partial<PipelineState>) {
  state = { ...state, ...partial };
  notify();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ── React Hook ───────────────────────────────────────────────

export function usePipelineStore(): PipelineState;
export function usePipelineStore<T>(selector: (s: PipelineState) => T): T;
export function usePipelineStore<T>(selector?: (s: PipelineState) => T) {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    return subscribe(() => forceUpdate(n => n + 1));
  }, []);

  return selector ? selector(state) : state;
}

// ── API Actions ──────────────────────────────────────────────

const API_BASE = '';  // Same origin

export async function loadPipeline(pipelineId: string): Promise<void> {
  setState({ loading: true, error: null, pipelineId });

  try {
    // Load schema
    const schemaRes = await fetch(`${API_BASE}/api/app/${encodeURIComponent(pipelineId)}/schema`);
    const schema = await schemaRes.json();

    // Load state
    const stateRes = await fetch(`${API_BASE}/api/app/${encodeURIComponent(pipelineId)}/state`);
    const appState = await stateRes.json();

    // Extract project data from node data
    const projectData = extractProjectData(appState);

    // Get project folder
    let projectFolder: string | null = null;
    try {
      const compRes = await fetch(`${API_BASE}/api/compositions/${encodeURIComponent(pipelineId)}`);
      const compData = await compRes.json();
      projectFolder = compData?.composition?.metadata?.projectFolder || null;
    } catch { /* ignore */ }

    setState({
      loading: false,
      pipelineName: schema?.name || appState?.pipelineName || pipelineId,
      projectFolder,
      projectData,
    });
  } catch (err: any) {
    setState({ loading: false, error: err.message || 'Failed to load pipeline' });
  }
}

export async function saveProjectData(data: Partial<ProjectData>): Promise<void> {
  const { pipelineId, projectFolder, projectData } = getState();
  if (!pipelineId) return;

  const merged = { ...projectData, ...data, updatedAt: new Date().toISOString() };

  if (projectFolder) {
    // Save directly to project.json
    await fetch(`${API_BASE}/api/app/${encodeURIComponent(pipelineId)}/project`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: merged }),
    });
  } else {
    // Save to assembly node
    await fetch(`${API_BASE}/api/app/${encodeURIComponent(pipelineId)}/state/node-15`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outputs: {
          scriptPackage: {
            script: {
              metadata: merged.metadata,
              characters: merged.characters,
              locations: merged.locations,
              sections: merged.sections,
              elements: merged.elements,
            },
            previsualizations: merged.previsualizations || { shots: [] },
            assets: merged.assets || [],
          },
          _fountainSource: merged._fountainSource,
        },
      }),
    });
  }

  setState({ projectData: merged as ProjectData });
}

export async function enrichEntity(
  entityType: 'characters' | 'locations',
  entityId: string,
): Promise<void> {
  const { pipelineId, projectData } = getState();
  if (!pipelineId || !projectData) return;

  const items = entityType === 'characters' ? projectData.characters : projectData.locations;
  const item = items.find(i => i.id === entityId);
  if (!item) return;

  const res = await fetch(`${API_BASE}/api/chat/one-shot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: buildEnrichPrompt(entityType, item, projectData),
    }),
  });

  const { response } = await res.json();
  const match = response?.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI did not return JSON');

  const enriched = JSON.parse(match[0]);
  const updated = { ...item, ...enriched };

  const newItems = items.map(i => i.id === entityId ? updated : i);
  await saveProjectData({ [entityType]: newItems } as any);
}

export async function generateAssets(type: 'characters' | 'locations' | 'all'): Promise<any> {
  const { pipelineId } = getState();
  const res = await fetch(`${API_BASE}/api/app/${encodeURIComponent(pipelineId)}/generate-assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type }),
  });
  const result = await res.json();
  // Reload to get updated image paths
  await loadPipeline(pipelineId);
  return result;
}

export async function clearProject(): Promise<void> {
  const { pipelineId } = getState();
  await fetch(`${API_BASE}/api/app/${encodeURIComponent(pipelineId)}/state`, { method: 'DELETE' });
  setState({ projectData: null });
}

// ── Helpers ──────────────────────────────────────────────────

function extractProjectData(appState: any): ProjectData | null {
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

  // Try assembly node first (node-15)
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

  return {
    version: '1.0',
    pipelineId: appState.pipelineId,
    metadata,
    characters,
    locations,
    sections,
    elements,
    previsualizations: previs,
    assets,
    _fountainSource: fountain,
  };
}

function buildEnrichPrompt(entityType: string, item: any, projectData: ProjectData): string {
  if (entityType === 'characters') {
    const dialogues = projectData.elements
      .filter(e => e.type === 'dialogue' && e.characterName === item.name)
      .slice(0, 10);
    const samples = dialogues.map(d => `${item.name}: "${(d.lines?.join(' ') || d.content || '').substring(0, 150)}"`).join('\n');
    const others = projectData.characters.filter(c => c.id !== item.id).map(c => c.name).join(', ');

    return `Analyze this character from a screenplay and provide detailed information.

Character name: ${item.name}
Role: ${item.role || 'unknown'}

Sample dialogue:
${samples}

Other characters: ${others}

Return a JSON object with: description, ageRange, gender, traits (array of 5), arc, voiceDescription, wardrobeNotes, relationships (array of {characterName, type}).
Return ONLY the JSON object.`;
  }

  return `Analyze this location from a screenplay:

Location: ${item.name}

Return a JSON object with: description, type (interior/exterior), mood, setting, atmosphere.
Return ONLY the JSON object.`;
}
