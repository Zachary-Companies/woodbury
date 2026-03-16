import { discoverCompositions, discoverWorkflows } from '../workflow/loader.js';

export interface CompositionInterfaceInput {
  name: string;
  label: string;
  type: string;
  description: string;
  nodeId: string;
  nodeLabel: string;
  workflowId: string;
  workflowName: string;
  portName: string;
  required: boolean;
  default?: unknown;
  generationPrompt?: string;
  inputControl?: 'text' | 'textarea' | 'select' | 'combobox';
  options?: string[];
  objectFields?: Array<{
    key: string;
    label?: string;
    type?: string;
    default?: string;
    options?: string[];
  }>;
}

export interface CompositionInterfaceOutput {
  name: string;
  type: string;
  description: string;
}

function inferBuiltInInputPorts(node: any): Array<{
  name: string;
  label?: string;
  type?: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  generationPrompt?: string;
}> {
  if (!node || typeof node !== 'object') return [];

  if (node.workflowId === '__junction__' && node.junctionNode) {
    return Array.isArray(node.junctionNode.ports) ? node.junctionNode.ports : [];
  }

  if (node.workflowId === '__branch__') {
    return [
      { name: 'condition', type: 'boolean', description: 'Optional condition override for the branch node' },
    ];
  }

  if (node.workflowId === '__delay__') {
    return [
      { name: 'delay_ms', type: 'number', description: 'Optional delay override in milliseconds' },
    ];
  }

  if (node.workflowId === '__gate__') {
    return [
      { name: 'open', type: 'boolean', description: 'Optional gate-open override' },
      { name: 'data', type: 'object', description: 'Optional payload to emit on the out port when the gate is open' },
    ];
  }

  if (node.workflowId === '__for_each__') {
    return [
      { name: 'items', type: 'object[]', description: 'Array of items to iterate over' },
    ];
  }

  if (node.workflowId === '__switch__') {
    return [
      { name: 'value', type: 'string', description: 'Value to match against the switch cases' },
    ];
  }

  if (node.workflowId === '__json_keys__') {
    return [
      { name: 'json', type: 'object', description: 'JSON object or string to inspect' },
      { name: 'path', type: 'string', description: 'Optional dot-notation path override' },
    ];
  }

  if (node.workflowId === '__file_op__') {
    const operation = node.fileOp?.operation || 'copy';
    if (operation === 'delete') return [{ name: 'filePath', type: 'string', description: 'Path of the file to delete' }];
    if (operation === 'mkdir') return [{ name: 'folderPath', type: 'string', description: 'Path of the folder to create' }];
    if (operation === 'list') return [{ name: 'folderPath', type: 'string', description: 'Path of the folder to list' }];
    return [
      { name: 'sourcePath', type: 'string', description: 'Source file path' },
      { name: 'destinationPath', type: 'string', description: 'Destination file path' },
    ];
  }

  if (node.workflowId === '__file_write__') {
    return [
      { name: 'filePath', type: 'string', description: 'Destination file path' },
      { name: 'content', type: 'object', description: 'String or object content to write' },
    ];
  }

  if (node.workflowId === '__file_read__') {
    return [
      { name: 'filePath', type: 'string', description: 'Path of the file to read' },
    ];
  }

  if (node.workflowId === '__tool__') {
    const schema = node.toolNode?.paramSchema;
    const props = schema?.properties;
    const required = Array.isArray(schema?.required) ? schema.required : [];
    if (props && typeof props === 'object') {
      return Object.entries(props).map(([name, value]: [string, any]) => ({
        name,
        type: typeof value?.type === 'string' ? value.type : 'string',
        description: typeof value?.description === 'string' ? value.description : '',
        required: required.includes(name),
        default: value?.default,
      }));
    }
    return [];
  }

  if (node.workflowId === '__image_viewer__') {
    return [
      { name: 'filePath', type: 'string', description: 'Image file path to display' },
    ];
  }

  if (node.workflowId === '__media__') {
    const sourceMode = node.mediaPlayer?.sourceMode || 'file_path';
    if (sourceMode === 'url') return [{ name: 'url', type: 'string', description: 'Media URL to display' }];
    if (sourceMode === 'asset_id') return [{ name: 'assetId', type: 'string', description: 'Asset id to display' }];
    return [{ name: 'filePath', type: 'string', description: 'Media file path to display' }];
  }

  if (node.workflowId === '__asset__') {
    const mode = node.asset?.mode || 'pick';
    if (mode === 'save') {
      return [
        { name: 'filePath', type: 'string', description: 'File path to save as an asset' },
        { name: 'name', type: 'string', description: 'Optional asset display name' },
      ];
    }
    if (mode === 'remove') {
      return [
        { name: 'assetId', type: 'string', description: 'Asset id to remove' },
      ];
    }
    return [];
  }

  return [];
}

export function inferCompositionInputs(
  comp: any,
  wfMap: Record<string, any>,
  compMap: Record<string, any> = {},
  visited: Set<string> = new Set()
): CompositionInterfaceInput[] {
  const connectedInputs = new Set<string>();
  for (const edge of comp.edges) {
    connectedInputs.add(`${edge.targetNodeId}:${edge.targetPort}`);
  }

  const result: CompositionInterfaceInput[] = [];

  const parseVariableDefault = (node: any): unknown => {
    const cfg = node?.variableNode;
    if (!cfg) return undefined;
    const initialValue = typeof cfg.initialValue === 'string'
      ? cfg.initialValue
      : (cfg.value !== undefined && cfg.value !== null
        ? (typeof cfg.value === 'string' ? cfg.value : JSON.stringify(cfg.value))
        : '');
    if (cfg.type === 'boolean') return cfg.initialValue === 'true';
    if (cfg.type === 'number') {
      const parsedNum = Number(initialValue);
      return Number.isFinite(parsedNum) ? parsedNum : undefined;
    }
    if (cfg.type === 'array') {
      try {
        const parsed = JSON.parse(initialValue || '[]');
        return Array.isArray(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    }
    return initialValue ?? '';
  };

  for (const node of comp.nodes) {
    if (node.workflowId === '__output__') continue;

    let ports: Array<{
      name: string;
      label?: string;
      type?: string;
      description?: string;
      required?: boolean;
      default?: unknown;
      generationPrompt?: string;
    }> = [];
    const nodeLabel = String(node.label || '').trim();
    const workflowName = node.workflowId === '__script__'
      ? (nodeLabel || 'Script')
      : (wfMap[node.id]?.name || nodeLabel || node.workflowId);

    if (node.workflowId === '__approval_gate__') {
      continue;
    } else if (node.workflowId === '__variable__' && node.variableNode?.exposeAsInput) {
      const inputName = String(node.variableNode.inputName || '').trim();
      if (!inputName) continue;
      // Use explicit inputControl/options, or auto-infer from description
      let varInputControl = node.variableNode.inputControl;
      let varOptions = node.variableNode.options;
      if (!varInputControl && (!varOptions || varOptions.length === 0) && (node.variableNode.type || 'string') === 'string') {
        const desc = String(node.variableNode.description || '').trim();
        const lbl = String(node.label || '').trim();
        const inferred = inferOptionsFromVariableDescription(desc, lbl);
        if (inferred.length >= 2) {
          varOptions = inferred;
          const hasEtc = /\betc\.?\b|\.{2,}|\band more\b|\bother\b/i.test(desc);
          varInputControl = hasEtc ? 'combobox' : 'select';
        }
      }

      result.push({
        name: inputName,
        label: String(node.label || inputName).trim() || inputName,
        type: node.variableNode.type === 'array' ? 'string[]' : node.variableNode.type || 'string',
        description: String(node.variableNode.description || '').trim(),
        nodeId: node.id,
        nodeLabel,
        workflowId: node.workflowId,
        workflowName: workflowName || 'Variable',
        portName: inputName,
        required: node.variableNode.required === true,
        default: parseVariableDefault(node),
        generationPrompt: node.variableNode.generationPrompt,
        inputControl: varInputControl,
        options: varOptions,
        objectFields: node.variableNode.type === 'object' ? node.variableNode.objectFields : undefined,
      });
      continue;
    } else if (node.workflowId === '__branch__' || node.workflowId === '__delay__' || node.workflowId === '__gate__' || node.workflowId === '__for_each__' || node.workflowId === '__switch__') {
      ports = inferBuiltInInputPorts(node);
    } else if (node.workflowId === '__script__' && node.script) {
      ports = node.script.inputs || [];
    } else if (
      node.workflowId === '__junction__' ||
      node.workflowId === '__json_keys__' ||
      node.workflowId === '__tool__' ||
      node.workflowId === '__file_write__' ||
      node.workflowId === '__file_read__' ||
      node.workflowId === '__file_op__' ||
      node.workflowId === '__asset__' ||
      node.workflowId === '__image_viewer__' ||
      node.workflowId === '__media__'
    ) {
      ports = inferBuiltInInputPorts(node);
    } else if (node.workflowId.startsWith('comp:') && node.compositionRef) {
      const childId = String(node.compositionRef.compositionId || '').trim();
      const childComp = childId ? compMap[childId] : undefined;
      if (!childComp) continue;
      const childVisited = new Set(visited);
      const cycleKey = String(childComp.id || childId || node.id || '').trim();
      if (cycleKey) {
        if (childVisited.has(cycleKey)) continue;
        childVisited.add(cycleKey);
      }
      ports = inferCompositionInputs(childComp, wfMap, compMap, childVisited).map((input) => ({
        name: input.name,
        label: input.label,
        type: input.type,
        description: input.description,
        required: input.required,
        default: input.default,
        generationPrompt: input.generationPrompt,
      }));
    } else {
      const wf = wfMap[node.id];
      if (wf && wf.variables) {
        ports = wf.variables.map((v: any) => ({ name: v.name, type: v.type || 'string', description: v.description }));
      }
    }

    for (const port of ports) {
      const key = `${node.id}:${port.name}`;
      if (!connectedInputs.has(key)) {
        const alias = node.portAliases && node.portAliases[port.name];
        const portLabel = String(port.label || port.name || '').trim();
        result.push({
          name: alias || port.name,
          label: alias || portLabel || port.name,
          type: port.type || 'string',
          description: port.description || '',
          nodeId: node.id,
          nodeLabel,
          workflowId: node.workflowId,
          workflowName,
          portName: port.name,
          required: port.required === true,
          default: port.default,
          generationPrompt: port.generationPrompt,
        });
      }
    }
  }

  return result;
}

export function inferCompositionOutputs(comp: any): CompositionInterfaceOutput[] {
  const outputNode = comp.nodes.find((n: any) => n.workflowId === '__output__');
  if (!outputNode || !outputNode.outputNode) return [];
  return outputNode.outputNode.ports.map((p: any) => ({
    name: p.name,
    type: p.type || 'string',
    description: p.description || '',
  }));
}

export async function resolveCompositionInterface(workDir: string, comp: any): Promise<{
  inputs: CompositionInterfaceInput[];
  outputs: CompositionInterfaceOutput[];
}> {
  const discovered = await discoverCompositions(workDir);
  const wfDiscovered = await discoverWorkflows(workDir);
  const wfMap: Record<string, any> = {};
  const compMap: Record<string, any> = {};

  for (const discoveredComp of discovered) {
    if (discoveredComp?.composition?.id) {
      compMap[discoveredComp.composition.id] = discoveredComp.composition;
    }
  }
  if (comp?.id) {
    compMap[String(comp.id)] = comp;
  }

  for (const node of comp.nodes || []) {
    if (node.workflowId === '__approval_gate__' || node.workflowId === '__script__' || node.workflowId === '__output__' || node.workflowId === '__image_viewer__' || node.workflowId === '__media__' || node.workflowId === '__branch__' || node.workflowId === '__delay__' || node.workflowId === '__gate__' || node.workflowId === '__for_each__' || node.workflowId === '__switch__' || node.workflowId === '__asset__' || node.workflowId === '__text__' || node.workflowId === '__file_op__' || node.workflowId === '__json_keys__' || node.workflowId === '__tool__' || node.workflowId === '__file_write__' || node.workflowId === '__file_read__' || node.workflowId === '__junction__' || node.workflowId === '__variable__' || node.workflowId === '__get_variable__') continue;
    if (typeof node.workflowId === 'string' && node.workflowId.startsWith('comp:')) continue;
    const wfFound = wfDiscovered.find((d: any) => d.workflow.id === node.workflowId);
    if (wfFound) {
      wfMap[node.id] = wfFound.workflow;
    }
  }

  return {
    inputs: inferCompositionInputs(comp, wfMap, compMap, new Set([String(comp.id || '')])),
    outputs: inferCompositionOutputs(comp),
  };
}

/**
 * Extract option values from a variable node's description.
 * Matches patterns like:
 *   "Type of script (feature, short, pilot, etc.)"
 *   "Genre: drama, comedy, sci-fi, horror"
 *   "Style — cinematic / documentary / animated"
 *   "e.g. drama, comedy, sci-fi"
 */
function inferOptionsFromVariableDescription(description: string, _label: string): string[] {
  if (!description) return [];

  // Pattern 1: parenthesized list — "something (opt1, opt2, opt3, etc.)"
  const parenMatch = description.match(/\(([^)]{4,})\)/);
  if (parenMatch) {
    const items = splitVariableOptionList(parenMatch[1]);
    if (items.length >= 2) return items;
  }

  // Pattern 2: colon/dash/em-dash separated — "Genre: drama, comedy, sci-fi"
  const colonMatch = description.match(/(?::|—|--|=>)\s*(.{4,})$/);
  if (colonMatch) {
    const items = splitVariableOptionList(colonMatch[1]);
    if (items.length >= 2) return items;
  }

  // Pattern 3: "e.g." or "such as" — "e.g. drama, comedy, sci-fi"
  const egMatch = description.match(/(?:e\.g\.?|such as|like|including)\s+(.{4,})/i);
  if (egMatch) {
    const items = splitVariableOptionList(egMatch[1]);
    if (items.length >= 2) return items;
  }

  return [];
}

/** Split a comma / slash / "or" delimited string into trimmed option values, filtering noise words. */
function splitVariableOptionList(raw: string): string[] {
  const parts = raw.split(/\s*[,\/]\s*|\s+or\s+/i);
  const noiseWords = new Set(['etc', 'etc.', '...', 'more', 'other', 'others', 'and more']);
  return parts
    .map(p => p.trim().replace(/^["']+|["']+$/g, '').replace(/\.{2,}$/, '').trim())
    .filter(p => p.length > 0 && !noiseWords.has(p.toLowerCase()));
}