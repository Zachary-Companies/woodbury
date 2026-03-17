/**
 * Pipeline Bindings — Custom data connections between pipeline entities.
 *
 * Bindings represent semantic relationships between entities in different
 * pipeline node outputs (e.g., "shot X depicts characters A and B").
 * They enable:
 * - Image generation to reference only the correct characters/locations
 * - Audio generation to use the correct character voice
 * - Custom views to show entity relationships
 *
 * Bindings are stored per-pipeline in the bindings/ directory and can be
 * created manually, through the UI, or automatically via rules.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { existsSync } from 'fs';

// ── Types ────────────────────────────────────────────────────

/** Reference to a specific entity in a pipeline's data */
export interface EntityRef {
  /** The semantic type: "character", "location", "shot", "dialogue", "scene", etc. */
  entityType: string;
  /** The entity's ID within the data */
  entityId: string;
}

/** A binding connects two entities with a typed relationship */
export interface Binding {
  id: string;
  /** Relationship type: "depicts", "set-in", "voice", "references", or custom */
  type: string;
  /** The source entity (e.g., a shot) */
  source: EntityRef;
  /** The target entity (e.g., a character appearing in that shot) */
  target: EntityRef;
  /** Confidence score 0-1 (1.0 = explicit/manual, <1 = auto-inferred) */
  confidence: number;
  /** How this binding was created */
  origin: string; // "manual", "auto:<ruleId>", "ai-generated"
  /** ISO timestamp */
  createdAt: string;
  /** ISO timestamp */
  updatedAt: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/** The bindings document stored at bindings/bindings.json */
export interface BindingsDocument {
  version: '1.0';
  pipelineId: string;
  bindings: Binding[];
}

/** An auto-binding rule that populates bindings from node output data */
export interface BindingRule {
  id: string;
  name: string;
  description?: string;
  /** Whether this rule is active */
  enabled: boolean;
  /** Rule type determines how matching works */
  type: 'text-match' | 'field-match' | 'scene-heading' | 'custom';
  /** Source entity config */
  source: {
    entityType: string;
    /** JSONPath-like key into the data to find the match text */
    field: string;
  };
  /** Target entity config */
  target: {
    entityType: string;
    /** Field on the target entity to match against */
    matchField: string;
  };
  /** Relationship type to create */
  relationship: string;
  /** For text-match: case-insensitive substring match by default */
  matchOptions?: {
    caseSensitive?: boolean;
    wholeWord?: boolean;
  };
}

export interface RulesDocument {
  version: '1.0';
  pipelineId: string;
  rules: BindingRule[];
}

/** Custom view configuration stored per-pipeline */
export interface ViewConfig {
  id: string;
  type: string; // "screenplay-nle", "gallery", "timeline", etc.
  label: string;
  icon?: string;
  /** Maps semantic data roles to specific node outputs */
  entityMappings: Record<string, {
    nodeId: string;
    port?: string;
    path?: string;
  }>;
  /** Which binding types this view uses */
  bindingTypes?: string[];
  /** Custom view settings */
  settings?: Record<string, unknown>;
}

export interface ViewsDocument {
  version: '1.0';
  pipelineId: string;
  views: ViewConfig[];
}

// ── Load / Save ──────────────────────────────────────────────

export async function loadBindings(pipelineDir: string): Promise<BindingsDocument> {
  const filePath = join(pipelineDir, 'bindings', 'bindings.json');
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { version: '1.0', pipelineId: '', bindings: [] };
  }
}

export async function saveBindings(pipelineDir: string, doc: BindingsDocument): Promise<void> {
  const dir = join(pipelineDir, 'bindings');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'bindings.json'), JSON.stringify(doc, null, 2), 'utf-8');
}

export async function loadRules(pipelineDir: string): Promise<RulesDocument> {
  const filePath = join(pipelineDir, 'bindings', 'rules.json');
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { version: '1.0', pipelineId: '', rules: [] };
  }
}

export async function saveRules(pipelineDir: string, doc: RulesDocument): Promise<void> {
  const dir = join(pipelineDir, 'bindings');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'rules.json'), JSON.stringify(doc, null, 2), 'utf-8');
}

export async function loadViews(pipelineDir: string): Promise<ViewsDocument> {
  const filePath = join(pipelineDir, 'bindings', 'views.json');
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { version: '1.0', pipelineId: '', views: [] };
  }
}

export async function saveViews(pipelineDir: string, doc: ViewsDocument): Promise<void> {
  const dir = join(pipelineDir, 'bindings');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'views.json'), JSON.stringify(doc, null, 2), 'utf-8');
}

// ── Query helpers ────────────────────────────────────────────

/**
 * Get all bindings where the given entity is the source.
 * e.g., "What does shot X depict?" → returns character bindings
 */
export function getBindingsFrom(
  doc: BindingsDocument,
  entityType: string,
  entityId: string,
  relationshipType?: string,
): Binding[] {
  return doc.bindings.filter(b =>
    b.source.entityType === entityType &&
    b.source.entityId === entityId &&
    (!relationshipType || b.type === relationshipType)
  );
}

/**
 * Get all bindings where the given entity is the target.
 * e.g., "What shots depict character X?" → returns shot bindings
 */
export function getBindingsTo(
  doc: BindingsDocument,
  entityType: string,
  entityId: string,
  relationshipType?: string,
): Binding[] {
  return doc.bindings.filter(b =>
    b.target.entityType === entityType &&
    b.target.entityId === entityId &&
    (!relationshipType || b.type === relationshipType)
  );
}

/**
 * Get all target entity IDs for a given source and relationship type.
 * e.g., getTargetIds(doc, "shot", "shot-1", "depicts") → ["char-emma", "char-john"]
 */
export function getTargetIds(
  doc: BindingsDocument,
  sourceEntityType: string,
  sourceEntityId: string,
  relationshipType: string,
): string[] {
  return getBindingsFrom(doc, sourceEntityType, sourceEntityId, relationshipType)
    .map(b => b.target.entityId);
}

// ── Auto-binding engine ──────────────────────────────────────

/**
 * Apply auto-binding rules against pipeline data to generate bindings.
 *
 * @param pipelineDir - Pipeline directory path
 * @param sourceEntities - Array of source entities to check (e.g., shot elements)
 * @param targetEntities - Array of target entities to match against (e.g., characters)
 * @param rules - Rules to apply
 * @returns New bindings that were generated
 */
export function applyRules(
  rules: BindingRule[],
  sourceEntities: Array<{ entityType: string; entityId: string; data: Record<string, any> }>,
  targetEntities: Array<{ entityType: string; entityId: string; data: Record<string, any> }>,
): Binding[] {
  const now = new Date().toISOString();
  const newBindings: Binding[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;

    // Filter sources and targets by entity type
    const sources = sourceEntities.filter(e => e.entityType === rule.source.entityType);
    const targets = targetEntities.filter(e => e.entityType === rule.target.entityType);

    for (const source of sources) {
      const sourceValue = getNestedValue(source.data, rule.source.field);
      if (!sourceValue || typeof sourceValue !== 'string') continue;

      for (const target of targets) {
        const targetValue = getNestedValue(target.data, rule.target.matchField);
        if (!targetValue || typeof targetValue !== 'string') continue;

        const matched = matchValues(sourceValue, targetValue, rule);
        if (matched) {
          newBindings.push({
            id: `bind-${rule.id}-${source.entityId}-${target.entityId}`,
            type: rule.relationship,
            source: { entityType: source.entityType, entityId: source.entityId },
            target: { entityType: target.entityType, entityId: target.entityId },
            confidence: 0.9,
            origin: `auto:${rule.id}`,
            createdAt: now,
            updatedAt: now,
          });
        }
      }
    }
  }

  return newBindings;
}

/**
 * Run all rules for a pipeline against its current app state data.
 * Merges new auto-bindings with existing ones (preserving manual bindings).
 */
export async function applyAllRules(
  pipelineDir: string,
  sourceEntities: Array<{ entityType: string; entityId: string; data: Record<string, any> }>,
  targetEntities: Array<{ entityType: string; entityId: string; data: Record<string, any> }>,
): Promise<{ added: number; removed: number }> {
  const rulesDoc = await loadRules(pipelineDir);
  const bindingsDoc = await loadBindings(pipelineDir);

  // Generate new auto-bindings
  const autoBindings = applyRules(rulesDoc.rules, sourceEntities, targetEntities);

  // Remove old auto-bindings (keep manual ones)
  const manualBindings = bindingsDoc.bindings.filter(b => b.origin === 'manual' || b.origin === 'ai-generated');

  // Deduplicate new auto-bindings
  const seen = new Set(manualBindings.map(b => `${b.source.entityId}:${b.target.entityId}:${b.type}`));
  const uniqueAuto = autoBindings.filter(b => {
    const key = `${b.source.entityId}:${b.target.entityId}:${b.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const oldAutoCount = bindingsDoc.bindings.filter(b => b.origin.startsWith('auto:')).length;
  bindingsDoc.bindings = [...manualBindings, ...uniqueAuto];

  await saveBindings(pipelineDir, bindingsDoc);

  return {
    added: uniqueAuto.length,
    removed: oldAutoCount,
  };
}

// ── Helpers ──────────────────────────────────────────────────

function getNestedValue(obj: any, path: string): any {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function matchValues(sourceText: string, targetValue: string, rule: BindingRule): boolean {
  const caseSensitive = rule.matchOptions?.caseSensitive ?? false;
  const wholeWord = rule.matchOptions?.wholeWord ?? true;

  const haystack = caseSensitive ? sourceText : sourceText.toLowerCase();
  const needle = caseSensitive ? targetValue : targetValue.toLowerCase();

  if (wholeWord) {
    // Match whole word (bounded by word boundaries)
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, caseSensitive ? '' : 'i');
    return regex.test(sourceText);
  }

  return haystack.includes(needle);
}
