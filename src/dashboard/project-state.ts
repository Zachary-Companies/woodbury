/**
 * ProjectStateManager — single source of truth for project data.
 *
 * Holds loaded projects in memory, keyed by pipelineId.
 * All reads come from memory. All writes go through this manager
 * and flush to disk (debounced, atomic).
 *
 * The project folder structure:
 *   {projectFolder}/
 *     project.json              — metadata (title, version, timestamps, pipelineId)
 *     screenplay.fountain       — source fountain text
 *     characters/_index.json    — character array
 *     characters/{id}.png       — character headshots
 *     locations/_index.json     — location array
 *     locations/{id}.png        — location images
 *     scenes/_index.json        — scene-grouped data
 *     structure/sections.json   — section hierarchy
 *     structure/elements.json   — all script elements
 *     assets/_index.json        — asset metadata
 *     previs/_index.json        — previs shot metadata
 *     previs/{shot}.png         — previs images
 *     audio/_index.json         — dialogue audio metadata
 *     audio/{element}.mp3       — audio files
 *     .project-state.json       — internal bookkeeping
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { debugLog } from '../debug-log.js';
import type {
  ProjectData,
  DomainSlice,
  ScriptMetadata,
  ProjectStateInfo,
} from './project-types.js';
import { SLICE_FILE_MAP } from './project-types.js';

// ── Internal state per loaded project ───────────────────────

interface LoadedProject {
  pipelineId: string;
  pipelineName: string;
  projectFolder: string;
  data: ProjectData;
  lastRunId: string | null;
  lastRunAt: string | null;
  dirtySlices: Set<DomainSlice>;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

// ── The Manager ─────────────────────────────────────────────

export class ProjectStateManager {
  private projects = new Map<string, LoadedProject>();
  private flushDelayMs: number;

  constructor(opts?: { flushDelayMs?: number }) {
    this.flushDelayMs = opts?.flushDelayMs ?? 500;
  }

  // ── Load ────────────────────────────────────────────────

  /**
   * Load a project from disk into memory.
   * If already loaded, returns the in-memory version.
   */
  async load(pipelineId: string, pipelineName: string, projectFolder: string): Promise<ProjectData> {
    const existing = this.projects.get(pipelineId);
    if (existing) {
      // Update folder/name if changed
      existing.projectFolder = projectFolder;
      existing.pipelineName = pipelineName;
      return existing.data;
    }

    const data = await this.readFromDisk(projectFolder, pipelineId);

    const loaded: LoadedProject = {
      pipelineId,
      pipelineName,
      projectFolder,
      data,
      lastRunId: null,
      lastRunAt: null,
      dirtySlices: new Set(),
      flushTimer: null,
    };

    // Read internal state
    try {
      const stateRaw = await readFile(join(projectFolder, '.project-state.json'), 'utf-8');
      const stateInfo = JSON.parse(stateRaw);
      loaded.lastRunId = stateInfo.lastRunId || null;
      loaded.lastRunAt = stateInfo.lastRunAt || null;
    } catch { /* no state file yet */ }

    this.projects.set(pipelineId, loaded);
    return data;
  }

  // ── Get ─────────────────────────────────────────────────

  /**
   * Get the in-memory project data. Returns null if not loaded.
   */
  get(pipelineId: string): ProjectData | null {
    return this.projects.get(pipelineId)?.data ?? null;
  }

  /**
   * Get the full loaded project info. Returns null if not loaded.
   */
  getInfo(pipelineId: string): { data: ProjectData; projectFolder: string; pipelineName: string; lastRunId: string | null; lastRunAt: string | null } | null {
    const p = this.projects.get(pipelineId);
    if (!p) return null;
    return {
      data: p.data,
      projectFolder: p.projectFolder,
      pipelineName: p.pipelineName,
      lastRunId: p.lastRunId,
      lastRunAt: p.lastRunAt,
    };
  }

  /**
   * Get the project folder path for a loaded project.
   */
  getProjectFolder(pipelineId: string): string | null {
    return this.projects.get(pipelineId)?.projectFolder ?? null;
  }

  /**
   * Check if a project is loaded.
   */
  isLoaded(pipelineId: string): boolean {
    return this.projects.has(pipelineId);
  }

  // ── Update ──────────────────────────────────────────────

  /**
   * Apply a partial update to the project data.
   * Marks affected slices as dirty and schedules a flush.
   */
  update(pipelineId: string, partial: Partial<ProjectData>): void {
    const loaded = this.projects.get(pipelineId);
    if (!loaded) throw new Error(`Project ${pipelineId} not loaded`);

    // Determine which slices are affected
    const sliceKeys: Array<[keyof ProjectData, DomainSlice]> = [
      ['metadata', 'metadata'],
      ['characters', 'characters'],
      ['locations', 'locations'],
      ['sections', 'sections'],
      ['elements', 'elements'],
      ['scenes', 'scenes'],
      ['previsualizations', 'previsualizations'],
      ['assets', 'assets'],
      ['dialogueAudio', 'dialogueAudio'],
      ['_fountainSource', 'fountain'],
    ];

    for (const [key, slice] of sliceKeys) {
      if (key in partial) {
        loaded.dirtySlices.add(slice);
      }
    }

    // Always mark metadata dirty for updatedAt
    loaded.dirtySlices.add('metadata');

    // Merge into data
    loaded.data = {
      ...loaded.data,
      ...partial,
      updatedAt: new Date().toISOString(),
    };

    this.scheduleFlush(pipelineId);
  }

  /**
   * Mark specific slices as dirty and schedule a flush.
   */
  markDirty(pipelineId: string, slices: DomainSlice[]): void {
    const loaded = this.projects.get(pipelineId);
    if (!loaded) return;
    for (const s of slices) loaded.dirtySlices.add(s);
    this.scheduleFlush(pipelineId);
  }

  // ── Apply pipeline run outputs ──────────────────────────

  /**
   * Apply node outputs from a completed pipeline run.
   * Maps output keys to domain slices and merges into project data.
   */
  applyRunOutputs(
    pipelineId: string,
    runId: string,
    nodeOutputs: Record<string, Record<string, unknown>>,
    executionOrder: string[],
  ): void {
    const loaded = this.projects.get(pipelineId);
    if (!loaded) {
      debugLog.info('project-state', `Cannot apply run outputs: project ${pipelineId} not loaded`);
      return;
    }

    loaded.lastRunId = runId;
    loaded.lastRunAt = new Date().toISOString();

    for (const nodeId of executionOrder) {
      const outputs = nodeOutputs[nodeId];
      if (!outputs || Object.keys(outputs).length === 0) continue;

      // Check for scriptPackage wrapper (assembly/output nodes)
      const sp = (outputs as any).scriptPackage;
      if (sp) {
        const script = sp.script || sp;
        if (script.metadata) { loaded.data.metadata = script.metadata; loaded.dirtySlices.add('metadata'); }
        if (script.characters) { loaded.data.characters = script.characters; loaded.dirtySlices.add('characters'); }
        if (script.locations) { loaded.data.locations = script.locations; loaded.dirtySlices.add('locations'); }
        if (script.sections) { loaded.data.sections = script.sections; loaded.dirtySlices.add('sections'); }
        if (script.elements) { loaded.data.elements = script.elements; loaded.dirtySlices.add('elements'); }
        if (sp.previsualizations) { loaded.data.previsualizations = sp.previsualizations; loaded.dirtySlices.add('previsualizations'); }
        if (sp.assets) { loaded.data.assets = sp.assets; loaded.dirtySlices.add('assets'); }
        if ((outputs as any)._fountainSource) { loaded.data._fountainSource = (outputs as any)._fountainSource; loaded.dirtySlices.add('fountain'); }
        continue;
      }

      // Map individual output keys to slices
      for (const [key, value] of Object.entries(outputs)) {
        if (key === '_fountainSource') {
          loaded.data._fountainSource = value as string;
          loaded.dirtySlices.add('fountain');
        } else if (key === 'metadata' && value && typeof value === 'object') {
          loaded.data.metadata = value as any;
          loaded.dirtySlices.add('metadata');
        } else if (key === 'characters' && Array.isArray(value)) {
          loaded.data.characters = value;
          loaded.dirtySlices.add('characters');
        } else if (key === 'locations' && Array.isArray(value)) {
          loaded.data.locations = value;
          loaded.dirtySlices.add('locations');
        } else if (key === 'sections' && Array.isArray(value)) {
          loaded.data.sections = value;
          loaded.dirtySlices.add('sections');
        } else if (key === 'elements' && Array.isArray(value)) {
          loaded.data.elements = value;
          loaded.dirtySlices.add('elements');
        } else if (key === 'scenes' && Array.isArray(value)) {
          loaded.data.scenes = value;
          loaded.dirtySlices.add('scenes');
        } else if (key === 'previsualizations') {
          loaded.data.previsualizations = value as any;
          loaded.dirtySlices.add('previsualizations');
        } else if (key === 'assets' && Array.isArray(value)) {
          loaded.data.assets = value;
          loaded.dirtySlices.add('assets');
        } else if (key === 'dialogueAudio') {
          loaded.data.dialogueAudio = value;
          loaded.dirtySlices.add('dialogueAudio');
        }
      }
    }

    loaded.data.updatedAt = new Date().toISOString();
    this.scheduleFlush(pipelineId);
  }

  // ── Flush ───────────────────────────────────────────────

  /**
   * Flush dirty slices to disk immediately.
   */
  async flush(pipelineId: string): Promise<void> {
    const loaded = this.projects.get(pipelineId);
    if (!loaded) return;

    // Cancel pending timer
    if (loaded.flushTimer) {
      clearTimeout(loaded.flushTimer);
      loaded.flushTimer = null;
    }

    if (loaded.dirtySlices.size === 0) return;

    const dirty = [...loaded.dirtySlices];
    loaded.dirtySlices.clear();

    debugLog.info('project-state', `Flushing ${dirty.length} slices for ${pipelineId}: ${dirty.join(', ')}`);

    try {
      await this.writeToDisk(loaded, dirty);
    } catch (err) {
      debugLog.error('project-state', `Flush failed for ${pipelineId}: ${err}`);
      // Re-mark as dirty for retry
      for (const s of dirty) loaded.dirtySlices.add(s);
    }
  }

  /**
   * Flush all loaded projects.
   */
  async flushAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const pipelineId of this.projects.keys()) {
      promises.push(this.flush(pipelineId));
    }
    await Promise.all(promises);
  }

  // ── Unload ──────────────────────────────────────────────

  /**
   * Flush and unload a project from memory.
   */
  async unload(pipelineId: string): Promise<void> {
    await this.flush(pipelineId);
    const loaded = this.projects.get(pipelineId);
    if (loaded?.flushTimer) clearTimeout(loaded.flushTimer);
    this.projects.delete(pipelineId);
  }

  /**
   * Clear project data (for "New Project").
   */
  async clear(pipelineId: string): Promise<void> {
    const loaded = this.projects.get(pipelineId);
    if (!loaded) return;

    loaded.data = createEmptyProject(pipelineId);
    loaded.dirtySlices = new Set([
      'metadata', 'characters', 'locations', 'sections', 'elements',
      'scenes', 'previsualizations', 'assets', 'fountain',
    ]);
    loaded.lastRunId = null;
    loaded.lastRunAt = null;

    await this.flush(pipelineId);
  }

  /**
   * Force reload from disk (discards in-memory changes).
   */
  async reload(pipelineId: string): Promise<ProjectData | null> {
    const loaded = this.projects.get(pipelineId);
    if (!loaded) return null;

    if (loaded.flushTimer) {
      clearTimeout(loaded.flushTimer);
      loaded.flushTimer = null;
    }
    loaded.dirtySlices.clear();

    loaded.data = await this.readFromDisk(loaded.projectFolder, pipelineId);
    return loaded.data;
  }

  // ── Private: disk I/O ───────────────────────────────────

  private scheduleFlush(pipelineId: string): void {
    const loaded = this.projects.get(pipelineId);
    if (!loaded) return;
    if (loaded.flushTimer) clearTimeout(loaded.flushTimer);
    loaded.flushTimer = setTimeout(() => {
      this.flush(pipelineId).catch(err => {
        debugLog.error('project-state', `Scheduled flush failed: ${err}`);
      });
    }, this.flushDelayMs);
  }

  /**
   * Read all project data from the folder structure.
   * Falls back to a monolithic project.json if domain files don't exist.
   */
  private async readFromDisk(projectFolder: string, pipelineId: string): Promise<ProjectData> {
    // Try reading domain-specific files first
    let metadata: ScriptMetadata = { title: 'Untitled' };
    let characters: any[] = [];
    let locations: any[] = [];
    let sections: any[] = [];
    let elements: any[] = [];
    let scenes: any[] = [];
    let previs: any = { shots: [] };
    let assets: any[] = [];
    let dialogueAudio: any = undefined;
    let fountain = '';
    let version = '1.0';
    let createdAt: string | undefined;
    let updatedAt: string | undefined;

    // Check for domain-specific files
    let hasDomainFiles = false;

    try {
      const raw = await readFile(join(projectFolder, 'characters', '_index.json'), 'utf-8');
      characters = JSON.parse(raw);
      hasDomainFiles = true;
    } catch { /* not split yet */ }

    try {
      const raw = await readFile(join(projectFolder, 'locations', '_index.json'), 'utf-8');
      locations = JSON.parse(raw);
      hasDomainFiles = true;
    } catch { /* not split yet */ }

    try {
      const raw = await readFile(join(projectFolder, 'structure', 'sections.json'), 'utf-8');
      sections = JSON.parse(raw);
      hasDomainFiles = true;
    } catch { /* not split yet */ }

    try {
      const raw = await readFile(join(projectFolder, 'structure', 'elements.json'), 'utf-8');
      elements = JSON.parse(raw);
      hasDomainFiles = true;
    } catch { /* not split yet */ }

    try {
      const raw = await readFile(join(projectFolder, 'scenes', '_index.json'), 'utf-8');
      scenes = JSON.parse(raw);
    } catch { /* no scenes yet */ }

    try {
      const raw = await readFile(join(projectFolder, 'previs', '_index.json'), 'utf-8');
      previs = JSON.parse(raw);
    } catch { /* no previs yet */ }

    try {
      const raw = await readFile(join(projectFolder, 'assets', '_index.json'), 'utf-8');
      assets = JSON.parse(raw);
    } catch { /* no assets yet */ }

    try {
      const raw = await readFile(join(projectFolder, 'audio', '_index.json'), 'utf-8');
      dialogueAudio = JSON.parse(raw);
    } catch { /* no audio yet */ }

    try {
      fountain = await readFile(join(projectFolder, 'screenplay.fountain'), 'utf-8');
    } catch { /* no fountain */ }

    // Always read project.json for metadata
    try {
      const raw = await readFile(join(projectFolder, 'project.json'), 'utf-8');
      const proj = JSON.parse(raw);
      metadata = proj.metadata || metadata;
      version = proj.version || version;
      createdAt = proj.createdAt;
      updatedAt = proj.updatedAt;

      // If no domain files exist, read everything from project.json (migration)
      if (!hasDomainFiles) {
        if (proj.characters?.length) characters = proj.characters;
        if (proj.locations?.length) locations = proj.locations;
        if (proj.sections?.length) sections = proj.sections;
        if (proj.elements?.length) elements = proj.elements;
        if (proj.scenes?.length) scenes = proj.scenes;
        if (proj.previsualizations) previs = proj.previsualizations;
        if (proj.assets?.length) assets = proj.assets;
        if (proj.dialogueAudio) dialogueAudio = proj.dialogueAudio;
        if (proj._fountainSource) fountain = proj._fountainSource;
      }
    } catch { /* no project.json yet */ }

    return {
      version,
      pipelineId,
      createdAt,
      updatedAt,
      metadata,
      characters,
      locations,
      sections,
      elements,
      scenes: scenes.length > 0 ? scenes : undefined,
      previsualizations: previs,
      assets,
      dialogueAudio,
      _fountainSource: fountain || undefined,
    };
  }

  /**
   * Write dirty slices to their respective files.
   */
  private async writeToDisk(loaded: LoadedProject, dirtySlices: DomainSlice[]): Promise<void> {
    const folder = loaded.projectFolder;

    for (const slice of dirtySlices) {
      const filePath = join(folder, SLICE_FILE_MAP[slice]);
      const dir = dirname(filePath);
      await mkdir(dir, { recursive: true });

      let content: string;

      switch (slice) {
        case 'metadata': {
          // project.json contains metadata + top-level fields
          const projJson = {
            version: loaded.data.version,
            pipelineId: loaded.data.pipelineId,
            createdAt: loaded.data.createdAt,
            updatedAt: loaded.data.updatedAt,
            metadata: loaded.data.metadata,
          };
          content = JSON.stringify(projJson, null, 2);
          break;
        }
        case 'characters':
          content = JSON.stringify(loaded.data.characters, null, 2);
          break;
        case 'locations':
          content = JSON.stringify(loaded.data.locations, null, 2);
          break;
        case 'sections':
          content = JSON.stringify(loaded.data.sections, null, 2);
          break;
        case 'elements':
          content = JSON.stringify(loaded.data.elements, null, 2);
          break;
        case 'scenes':
          content = JSON.stringify(loaded.data.scenes || [], null, 2);
          break;
        case 'previsualizations':
          content = JSON.stringify(loaded.data.previsualizations || { shots: [] }, null, 2);
          break;
        case 'assets':
          content = JSON.stringify(loaded.data.assets || [], null, 2);
          break;
        case 'dialogueAudio':
          content = JSON.stringify(loaded.data.dialogueAudio || {}, null, 2);
          break;
        case 'fountain':
          content = loaded.data._fountainSource || '';
          break;
        default:
          continue;
      }

      // Atomic write
      const tmpPath = filePath + '.tmp';
      await writeFile(tmpPath, content, 'utf-8');
      await rename(tmpPath, filePath);
    }

    // Write internal state file
    const stateInfo = {
      pipelineId: loaded.pipelineId,
      pipelineName: loaded.pipelineName,
      lastRunId: loaded.lastRunId,
      lastRunAt: loaded.lastRunAt,
      flushedAt: new Date().toISOString(),
    };
    const statePath = join(folder, '.project-state.json');
    await writeFile(statePath, JSON.stringify(stateInfo, null, 2), 'utf-8');
  }
}

// ── Helpers ─────────────────────────────────────────────────

function createEmptyProject(pipelineId: string): ProjectData {
  return {
    version: '1.0',
    pipelineId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: { title: 'Untitled' },
    characters: [],
    locations: [],
    sections: [],
    elements: [],
  };
}
