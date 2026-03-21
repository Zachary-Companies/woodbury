/**
 * Project Types — shared between server and client.
 *
 * These are the canonical type definitions for all project data.
 * The project folder is the single source of truth; data is split
 * into domain-specific files within the folder.
 */

// ── Characters ──────────────────────────────────────────────

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

// ── Locations ───────────────────────────────────────────────

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

// ── Structure ───────────────────────────────────────────────

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

// ── Scene-Grouped Data ──────────────────────────────────────

/** A single previs image generation for a shot. */
export interface PrevisGeneration {
  id: string;
  filePath: string;
  generatedAt: string;
  aspectRatio?: string;
  referenceImages?: string[];
  referenceCharacterIds?: string[];
  referenceLocationId?: string;
  generationModel?: string;
  generationPrompt?: string;
}

export interface SceneShot {
  id: string;
  shotType: string;
  description: string;
  characterIds: string[];
  aspectRatio?: string;
  /** Path to the currently selected previs image */
  previsPath?: string;
  generatedAt?: string;
  /** All previs generations for this shot (newest last) */
  generations?: PrevisGeneration[];
  /** ID of the user-selected generation (defaults to latest) */
  selectedGenerationId?: string;
  /** User-assigned duration in seconds for timeline placement */
  duration?: number;
}

export interface SceneDialogue {
  elementId: string;
  characterId: string;
  characterName: string;
  lines: string[];
  modifiers?: string[];
}

export interface SceneData {
  id: string;
  title: string;
  location: string;
  locationId?: string;
  timeOfDay?: string;
  actTitle?: string;
  characterIds: string[];
  dialogue: SceneDialogue[];
  actions: string[];
  shots: SceneShot[];
  elementRange: [number, number];
}

// ── Script Metadata ─────────────────────────────────────────

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

// ── Project Data (the full project) ─────────────────────────

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
  scenes?: SceneData[];
  previsualizations?: { shots: any[] };
  assets?: any[];
  dialogueAudio?: any;
  _fountainSource?: string;
}

// ── Domain Slices (keys into the project folder) ────────────

/**
 * Each domain slice maps to a specific file in the project folder.
 * The ProjectStateManager tracks which slices are dirty and flushes
 * only those to disk.
 */
export type DomainSlice =
  | 'metadata'
  | 'characters'
  | 'locations'
  | 'sections'
  | 'elements'
  | 'scenes'
  | 'previsualizations'
  | 'assets'
  | 'dialogueAudio'
  | 'fountain';

/**
 * Maps domain slices to their file paths within the project folder.
 */
export const SLICE_FILE_MAP: Record<DomainSlice, string> = {
  metadata: 'project.json',
  characters: 'characters/_index.json',
  locations: 'locations/_index.json',
  sections: 'structure/sections.json',
  elements: 'structure/elements.json',
  scenes: 'scenes/_index.json',
  previsualizations: 'previs/_index.json',
  assets: 'assets/_index.json',
  dialogueAudio: 'audio/_index.json',
  fountain: 'screenplay.fountain',
};

// ── Project State (internal bookkeeping) ────────────────────

export interface ProjectStateInfo {
  pipelineId: string;
  pipelineName: string;
  lastRunId: string | null;
  lastRunAt: string | null;
  dirtySlices: Set<DomainSlice>;
}

// ── Node Output Mapping ─────────────────────────────────────

/**
 * Maps pipeline node output keys to project domain slices.
 * Used when applying pipeline run outputs to the project.
 * Unlike the old NODE_KEY_MAP (which used node IDs), this uses
 * the output port names from the pipeline schema.
 */
export const OUTPUT_TO_SLICE: Record<string, DomainSlice> = {
  metadata: 'metadata',
  characters: 'characters',
  locations: 'locations',
  sections: 'sections',
  elements: 'elements',
  scenes: 'scenes',
  previsualizations: 'previsualizations',
  assets: 'assets',
  dialogueAudio: 'dialogueAudio',
  _fountainSource: 'fountain',
};
