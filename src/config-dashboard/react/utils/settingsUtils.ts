/**
 * Pure utility functions for the SettingsView.
 * Handles parsing pipeline-inputs.json, building grouped field layouts,
 * and humanizing camelCase field names.
 */

export interface FriendlyInput {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'select';
  description: string;
  placeholder?: string;
  required?: boolean;
  rows?: number;
  options?: { value: string; label: string }[];
  group?: string;
}

export interface ConditionalGroup {
  showWhen: string[];
  inputs: FriendlyInput[];
}

export interface FieldGroup {
  id: string;
  label: string;
  description?: string;
  columns?: number;
  fields: FriendlyInput[];
  visible: boolean;
}

/**
 * Convert camelCase to human-readable label.
 * "projectType" → "Project Type"
 * "storyIdea" → "Story Idea"
 * "targetAudience" → "Target Audience"
 * "authorName" → "Author Name"
 */
export function humanizeFieldName(name: string): string {
  if (!name) return '';
  // Insert space before uppercase letters, then title-case
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, ch => ch.toUpperCase())
    .trim();
}

/**
 * Parse pipeline-inputs.json data into structured friendly inputs and conditional groups.
 */
export function parseFriendlyInputs(data: any): {
  inputs: FriendlyInput[];
  conditional: Record<string, ConditionalGroup>;
} {
  if (!data) return { inputs: [], conditional: {} };

  const inputs: FriendlyInput[] = (data.friendlyInputs || []).map((inp: any) => ({
    id: inp.id || '',
    label: inp.label || humanizeFieldName(inp.id || ''),
    type: inp.type === 'textarea' ? 'textarea' : inp.type === 'select' ? 'select' : 'text',
    description: inp.description || '',
    placeholder: inp.placeholder || '',
    required: !!inp.required,
    rows: inp.rows,
    options: inp.options,
    group: inp.group,
  }));

  const conditional: Record<string, ConditionalGroup> = {};
  if (data.conditionalInputs) {
    for (const [key, group] of Object.entries(data.conditionalInputs as Record<string, any>)) {
      conditional[key] = {
        showWhen: group.showWhen || [],
        inputs: (group.inputs || []).map((inp: any) => ({
          id: inp.id || '',
          label: inp.label || humanizeFieldName(inp.id || ''),
          type: inp.type === 'textarea' ? 'textarea' : inp.type === 'select' ? 'select' : 'text',
          description: inp.description || '',
          placeholder: inp.placeholder || '',
          required: !!inp.required,
          rows: inp.rows,
          options: inp.options,
        })),
      };
    }
  }

  return { inputs, conditional };
}

/**
 * Build organized field groups for the settings form.
 *
 * When friendlyInputs is available:
 *   - Groups fields into logical sections (essentials, creative, production)
 *   - Adds conditional groups (TV, commercial) based on current field values
 *
 * When friendlyInputs is null (no pipeline-inputs.json):
 *   - Falls back to port names with humanized labels in a single flat group
 */
export function buildFieldGroups(
  friendlyInputs: FriendlyInput[] | null,
  conditionalInputs: Record<string, ConditionalGroup> | null,
  ports: { name: string; type?: string; description?: string }[],
  values: Record<string, string>,
): FieldGroup[] {
  // ── Fallback: no friendly inputs, use raw ports ──
  if (!friendlyInputs || friendlyInputs.length === 0) {
    const fields: FriendlyInput[] = ports.map(port => ({
      id: port.name,
      label: humanizeFieldName(port.name),
      type: 'text' as const,
      description: port.description || '',
      placeholder: port.type || 'Enter value...',
    }));

    return [{
      id: 'default',
      label: '',
      fields,
      visible: true,
    }];
  }

  // ── With friendly inputs: group by logical sections ──
  const projectType = values.projectType || '';

  // Partition friendlyInputs into groups
  const essentials = friendlyInputs.filter(f =>
    ['projectType', 'storyIdea', 'title', 'authorName'].includes(f.id)
  );
  const creative = friendlyInputs.filter(f =>
    ['genre', 'mood', 'visualStyle', 'targetAudience'].includes(f.id)
  );
  const production = friendlyInputs.filter(f =>
    ['length', 'additionalNotes', 'projectFolder'].includes(f.id)
  );
  // Everything else that wasn't categorized
  const categorized = new Set([...essentials, ...creative, ...production].map(f => f.id));
  const uncategorized = friendlyInputs.filter(f => !categorized.has(f.id));

  const groups: FieldGroup[] = [
    {
      id: 'essentials',
      label: 'Project Essentials',
      description: 'The core details that define your project',
      fields: essentials,
      visible: essentials.length > 0,
    },
    {
      id: 'creative',
      label: 'Creative Direction',
      description: 'Shape the look and feel',
      columns: 2,
      fields: creative,
      visible: creative.length > 0,
    },
    {
      id: 'production',
      label: 'Production',
      description: 'Technical and logistical details',
      fields: production,
      visible: production.length > 0,
    },
  ];

  // Add uncategorized fields
  if (uncategorized.length > 0) {
    groups.push({
      id: 'other',
      label: 'Other',
      fields: uncategorized,
      visible: true,
    });
  }

  // Add conditional groups
  if (conditionalInputs) {
    for (const [key, group] of Object.entries(conditionalInputs)) {
      const visible = group.showWhen.includes(projectType);
      groups.push({
        id: key,
        label: key === 'tv' ? 'TV Series Details' : key === 'commercial' ? 'Commercial Details' : humanizeFieldName(key),
        description: key === 'tv' ? 'For TV pilots and episodes' : key === 'commercial' ? 'For advertisements' : undefined,
        fields: group.inputs,
        visible,
      });
    }
  }

  return groups;
}
