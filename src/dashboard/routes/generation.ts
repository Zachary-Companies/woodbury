/**
 * Dashboard Route: Generation
 *
 * Handles AI-powered generation endpoints:
 * - POST /api/autofill — AI-powered variable value generation
 * - POST /api/generate-variable — AI generation for a single variable using its custom prompt
 * - POST /api/compositions/generate-script — AI-powered code generation for script nodes
 * - POST /api/compositions/generate-pipeline — AI-powered pipeline decomposition
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DashboardContext, RouteHandler, ScriptToolDoc } from '../types.js';
import { sendJson, readBody } from '../utils.js';
import type { ToolDefinition } from '../../loop/types.js';
import { debugLog } from '../../debug-log.js';

// ── Constants ────────────────────────────────────────────────
const SCRIPT_TOOL_DOCS_PATH = join(homedir(), '.woodbury', 'data', 'script-tool-docs.json');

// ── Local helpers ────────────────────────────────────────────

async function loadScriptToolDocs(): Promise<ScriptToolDoc[]> {
  try {
    const content = await readFile(SCRIPT_TOOL_DOCS_PATH, 'utf-8');
    return JSON.parse(content);
  } catch { return []; }
}

function formatToolSignature(def: ToolDefinition): string {
  const props = def.parameters?.properties;
  if (!props || typeof props !== 'object') {
    return `context.tools.${def.name}(params)`;
  }
  const required: string[] = def.parameters?.required || [];
  const parts: string[] = [];
  for (const [name, prop] of Object.entries(props)) {
    const p = prop as any;
    const optional = !required.includes(name) ? '?' : '';
    let type: string = p.type || 'any';
    if (p.enum) {
      if (p.enum.length <= 4) {
        type = p.enum.map((v: string) => `"${v}"`).join('|');
      } else {
        type = p.enum.slice(0, 3).map((v: string) => `"${v}"`).join('|') + '|...';
      }
    }
    parts.push(`${name}${optional}: ${type}`);
  }
  return `context.tools.${def.name}({ ${parts.join(', ')} })`;
}

async function generateScriptToolDocs(ctx: DashboardContext): Promise<string> {
  const tools = ctx.extensionManager?.getAllTools() ?? [];
  if (tools.length === 0) return '';

  const customDocs = await loadScriptToolDocs();
  const customMap = new Map(customDocs.map(d => [d.toolName, d]));

  let section = '\nAvailable tools (via context.tools):\n';
  for (const tool of tools) {
    const custom = customMap.get(tool.definition.name);
    if (custom && !custom.enabled) continue;

    const sig = formatToolSignature(tool.definition);
    const desc = custom?.customDescription || tool.definition.description.split('\n')[0];
    section += `\n- ${sig} — ${desc}\n`;

    // Include parameter descriptions from JSON Schema
    const props = tool.definition.parameters?.properties;
    const required: string[] = tool.definition.parameters?.required || [];
    if (props && typeof props === 'object') {
      section += `  Parameters:\n`;
      for (const [name, prop] of Object.entries(props)) {
        const p = prop as any;
        const req = required.includes(name) ? 'required' : 'optional';
        const paramDesc = p.description || '';
        section += `    - ${name} (${req}): ${paramDesc}\n`;
      }
    }

    // Include return type documentation
    if (custom?.returns) {
      section += `  Returns: ${custom.returns}\n`;
    }

    if (custom?.examples?.length) {
      for (const ex of custom.examples) {
        section += `  Example: ${ex}\n`;
      }
    }
    if (custom?.notes) {
      section += `  Note: ${custom.notes}\n`;
    }
  }
  return section;
}

function parseScriptPorts(code: string): { inputs: Array<{ name: string; type: string; description: string }>; outputs: Array<{ name: string; type: string; description: string }> } {
  const inputs: Array<{ name: string; type: string; description: string }> = [];
  const outputs: Array<{ name: string; type: string; description: string }> = [];
  const regex = /@(input|output)\s+(\w+)\s+(string|number|boolean|object|string\[\]|number\[\]|object\[\])\s*(?:"([^"]*)")?/g;
  let match;
  while ((match = regex.exec(code)) !== null) {
    const decl = { name: match[2], type: match[3], description: match[4] || '' };
    (match[1] === 'input' ? inputs : outputs).push(decl);
  }
  return { inputs, outputs };
}

// ── Route handler ────────────────────────────────────────────

export const handleGenerationRoutes: RouteHandler = async (req, res, pathname, url, ctx) => {
  // POST /api/autofill — AI-powered variable value generation
  if (req.method === 'POST' && pathname === '/api/autofill') {
    try {
      const body = await readBody(req);
      const { variables, workflowName, site, steps } = body || {};

      if (!variables || !Array.isArray(variables) || variables.length === 0) {
        sendJson(res, 400, { error: 'Must provide a "variables" array' });
        return true;
      }

      // Build a concise context string from the workflow steps
      const stepsContext = (steps || [])
        .slice(0, 20) // limit to first 20 steps for token efficiency
        .map((s: any, i: number) => {
          let desc = `${i + 1}. ${s.type || 'action'}`;
          if (s.target?.textContent) desc += ` "${s.target.textContent}"`;
          if (s.target?.description) desc += ` (${s.target.description})`;
          if (s.value !== undefined) desc += ` → value: "${String(s.value).slice(0, 100)}"`;
          return desc;
        })
        .join('\n');

      // Build the variable descriptions
      const varDescriptions = variables
        .map((v: any) => {
          let line = `- ${v.name} (${v.type || 'string'})`;
          if (v.description) line += `: ${v.description}`;
          if (v.default) line += ` [default: ${v.default}]`;
          if (v.generationPrompt) line += ` [AI prompt: ${v.generationPrompt}]`;
          return line;
        })
        .join('\n');

      const prompt = `You are generating sample values for a browser automation workflow's variables. Generate realistic, creative, and contextually appropriate values.

Workflow: "${workflowName || 'Untitled'}"
Target site: ${site || 'unknown'}

Variables to fill:
${varDescriptions}

Workflow steps:
${stepsContext || '(no steps recorded)'}

Rules:
- Generate values that make sense for this specific workflow and target site
- For lyrics/text content, be creative and original — write a short verse or meaningful text
- For titles/names, be descriptive and catchy
- For genres/styles, pick something specific (not "General")
- For tags/hashtags, use relevant, realistic tags
- For URLs, use the target site domain if relevant
- For numbers, use sensible defaults for the context
- NEVER generate values for variables whose names contain "password", "secret", "token", or "key"
- Return ONLY a JSON object mapping variable names to generated values, no explanation

Example output:
{"song_title": "Neon Highways", "lyrics": "Driving fast through neon lights...\\nChasing dreams into the night", "genre": "Synthwave, Electronic"}`;

      // Try to use runPrompt from the LLM service
      const { runPrompt } = await import('../../loop/llm-service.js');

      // Use a fast model — try claude-sonnet first, fall back to gpt-4o-mini
      const model = process.env.ANTHROPIC_API_KEY
        ? 'claude-sonnet-4-20250514'
        : process.env.OPENAI_API_KEY
          ? 'gpt-4o-mini'
          : process.env.GROQ_API_KEY
            ? 'llama-3.1-70b-versatile'
            : 'claude-sonnet-4-20250514'; // default, will error if no key

      const llmResponse = await runPrompt(
        [
          { role: 'user', content: prompt },
        ],
        model,
        { maxTokens: 1024, temperature: 0.8 }
      );

      // Parse the JSON from the response
      const content = llmResponse.content.trim();
      // Extract JSON from potential markdown code blocks
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
      const jsonStr = (jsonMatch[1] || content).trim();
      const generated = JSON.parse(jsonStr);

      debugLog.info('dashboard', 'AI autofill generated values', {
        model,
        variableCount: variables.length,
        generatedKeys: Object.keys(generated),
      });

      sendJson(res, 200, { success: true, values: generated });
    } catch (err) {
      debugLog.error('dashboard', 'AI autofill failed', { error: String(err) });
      sendJson(res, 500, { error: `AI autofill failed: ${(err as Error).message}` });
    }
    return true;
  }

  // POST /api/generate-variable — AI generation for a single variable using its custom prompt
  if (req.method === 'POST' && pathname === '/api/generate-variable') {
    try {
      const body = await readBody(req);
      const { variableName, generationPrompt, workflowName, site, variableType } = body || {};

      if (!variableName || !generationPrompt) {
        sendJson(res, 400, { error: 'variableName and generationPrompt are required' });
        return true;
      }

      const prompt = `You are generating a value for a variable in a browser automation workflow.

Variable: "${variableName}" (type: ${variableType || 'string'})
Workflow: "${workflowName || 'Untitled'}" on ${site || 'unknown site'}

Instructions from the user:
${generationPrompt}

Rules:
- Follow the user's instructions precisely
- Be creative and original for text/lyrics/content
- Return ONLY the raw value — no JSON wrapping, no quotes around it, no explanation
- If the type is a number, return just the number
- If the type is boolean, return just "true" or "false"
- For multi-line content (lyrics, paragraphs), use actual newlines`;

      const { runPrompt } = await import('../../loop/llm-service.js');

      const model = process.env.ANTHROPIC_API_KEY
        ? 'claude-sonnet-4-20250514'
        : process.env.OPENAI_API_KEY
          ? 'gpt-4o-mini'
          : process.env.GROQ_API_KEY
            ? 'llama-3.1-70b-versatile'
            : 'claude-sonnet-4-20250514';

      const llmResponse = await runPrompt(
        [{ role: 'user', content: prompt }],
        model,
        { maxTokens: 2048, temperature: 0.9 }
      );

      const value = llmResponse.content.trim();

      debugLog.info('dashboard', `AI generated value for variable "${variableName}"`, {
        model,
        promptLength: generationPrompt.length,
        valueLength: value.length,
      });

      sendJson(res, 200, { success: true, value });
    } catch (err) {
      debugLog.error('dashboard', 'AI generate-variable failed', { error: String(err) });
      sendJson(res, 500, { error: `AI generation failed: ${(err as Error).message}` });
    }
    return true;
  }

  // POST /api/compositions/generate-script — AI-powered code generation for script nodes
  if (req.method === 'POST' && pathname === '/api/compositions/generate-script') {
    try {
      const body = await readBody(req);
      const { description, chatHistory, currentCode, dataContext } = body || {};

      if (!description && (!chatHistory || chatHistory.length === 0)) {
        sendJson(res, 400, { error: 'description or chatHistory is required' });
        return true;
      }

      const toolDocs = await generateScriptToolDocs(ctx);
      const systemPrompt = `You are a code generator for pipeline script nodes. The user describes what they want a node to do, and you generate JavaScript code.

IMPORTANT: You MUST generate code that follows this EXACT format:

1. Start with a JSDoc comment block containing @input and @output annotations
2. Then an async function called execute(inputs, context)
3. The function destructures inputs and uses context.llm.generate() for LLM calls
4. The function returns an object with all declared outputs

Port annotation format (one per line in the JSDoc):
  @input <name> <type> "<description>"
  @output <name> <type> "<description>"
Types: string, number, boolean, object, string[], number[], object[]

Available context methods:
- context.llm.generate(prompt) — Call an LLM, returns a string
- context.llm.generate(prompt, { temperature, maxTokens }) — With options
- context.llm.generateJSON(prompt) — Call LLM and parse JSON response
- context.log(message) — Log a message
${toolDocs}
Example:
\`\`\`javascript
/**
 * @input theme string "The theme to write about"
 * @output poem string "A generated poem"
 * @output wordCount number "Number of words in the poem"
 */
async function execute(inputs, context) {
  const { theme } = inputs;
  const { llm } = context;

  const poem = await llm.generate(
    \\\`Write a short poem about "\${theme}". Return only the poem.\\\`
  );

  const wordCount = poem.split(/\\s+/).length;

  return { poem, wordCount };
}
\`\`\`

Rules:
- Always include the JSDoc block with @input/@output annotations
- Always use the execute(inputs, context) function signature
- Keep code simple and readable — non-technical users will see it
- Use template literals for LLM prompts
- Return ALL declared outputs
- Include clear prompt instructions when calling llm.generate()
- Respond with ONLY the code block — no explanation before or after`;

      const { runPrompt } = await import('../../loop/llm-service.js');

      const model = process.env.ANTHROPIC_API_KEY
        ? 'claude-sonnet-4-20250514'
        : process.env.OPENAI_API_KEY
          ? 'gpt-4o-mini'
          : process.env.GROQ_API_KEY
            ? 'llama-3.1-70b-versatile'
            : 'claude-sonnet-4-20250514';

      // Build messages
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: systemPrompt },
      ];

      // Add chat history if present
      if (chatHistory && Array.isArray(chatHistory)) {
        for (const msg of chatHistory) {
          messages.push({ role: msg.role, content: msg.content });
        }
      }

      // Add the current request
      let userMessage = description || '';
      if (dataContext) {
        userMessage += `\n\nThe input data for this script looks like this (sample from a previous pipeline run):\n\`\`\`json\n${dataContext}\n\`\`\`\nUse this to understand the exact data structure and write code that handles it correctly. Make sure the first @input annotation matches the type of this data (it will be auto-connected to the source port). IMPORTANT: If the user's description references any other dynamic values (like keys, indices, filters, thresholds, etc.), create ADDITIONAL @input ports for each one. Every variable parameter should be its own input port so it can be wired from other nodes in the pipeline.`;
      }
      if (currentCode) {
        userMessage += `\n\nCurrent code:\n\`\`\`javascript\n${currentCode}\n\`\`\``;
      }
      if (userMessage.trim()) {
        messages.push({ role: 'user', content: userMessage.trim() });
      }

      const llmResponse = await runPrompt(messages, model, { maxTokens: 4096, temperature: 0.7 });
      const assistantMessage = llmResponse.content.trim();

      // Extract code block from response
      let code = assistantMessage;
      const codeBlockMatch = assistantMessage.match(/```(?:javascript|js)?\s*\n([\s\S]*?)\n```/);
      if (codeBlockMatch) {
        code = codeBlockMatch[1].trim();
      }

      // Parse @input/@output annotations
      const ports = parseScriptPorts(code);

      debugLog.info('dashboard', 'Script generated', {
        model,
        inputCount: ports.inputs.length,
        outputCount: ports.outputs.length,
        codeLength: code.length,
      });

      sendJson(res, 200, {
        success: true,
        code,
        inputs: ports.inputs,
        outputs: ports.outputs,
        assistantMessage,
      });
    } catch (err) {
      debugLog.error('dashboard', 'Script generation failed', { error: String(err) });
      sendJson(res, 500, { error: `Script generation failed: ${(err as Error).message}` });
    }
    return true;
  }

  // POST /api/compositions/generate-pipeline — AI-powered pipeline decomposition
  if (req.method === 'POST' && pathname === '/api/compositions/generate-pipeline') {
    try {
      const body = await readBody(req);
      const { description } = body || {};

      if (!description || typeof description !== 'string' || !description.trim()) {
        sendJson(res, 400, { error: 'description is required' });
        return true;
      }

      const toolDocs = await generateScriptToolDocs(ctx);
      const pipelineSystemPrompt = `You are a pipeline architect for a visual automation platform. The user describes a task, and you decompose it into multiple small, focused steps — each becoming a node in a pipeline graph.

IMPORTANT RULES:
1. Each script node should do ONE thing and be under 20 lines of code
2. Use the simplest node type for each step:
   - "text" for constant values (prompts, paths, configuration strings)
   - "file_op" for file operations (copy, move, delete, mkdir, list)
   - "script" for custom logic, LLM calls, data transformation, or tool usage
3. Connect nodes via matching port names in the connections array
4. Port names must use snake_case (e.g., "generated_text", "file_path")
5. Keep the pipeline linear or fan-out — avoid unnecessary complexity

NODE TYPES:

"text" — outputs a constant string value
  Output port: "text" (always)
  Config: { "type": "text", "label": "...", "textNode": { "value": "the text content" } }

"file_op" — file system operations
  Operations and their ports:
  - "copy": inputs [sourcePath, destinationPath], outputs [outputPath, success]
  - "move": inputs [sourcePath, destinationPath], outputs [outputPath, success]
  - "delete": inputs [filePath], outputs [success]
  - "mkdir": inputs [folderPath], outputs [outputPath, success]
  - "list": inputs [folderPath], outputs [files, count]
  Config: { "type": "file_op", "label": "...", "fileOp": { "operation": "copy" } }

"script" — custom code with @input/@output ports
  Must include a JSDoc block with @input and @output annotations.
  Format: @input <name> <type> "<description>"  |  @output <name> <type> "<description>"
  Types: string, number, boolean, object, string[], number[], object[]
  Function signature: async function execute(inputs, context)
  Available in context:
  - context.llm.generate(prompt) — Call an LLM, returns string
  - context.llm.generate(prompt, { temperature, maxTokens }) — With options
  - context.llm.generateJSON(prompt) — Call LLM, parse JSON response
  - context.log(message) — Log a message
  - require('fs'), require('path'), require('os') — Node.js modules
${toolDocs}

RESPONSE FORMAT — respond with ONLY a JSON object (no explanation, no markdown fences):

{
  "name": "Human-readable pipeline name",
  "nodes": [
    {
      "type": "text|script|file_op",
      "label": "Short Node Label",
      "description": "What this node does (script only)",
      "code": "// JavaScript code (script only)",
      "textNode": { "value": "..." },
      "fileOp": { "operation": "copy|move|delete|mkdir|list" }
    }
  ],
  "connections": [
    { "from": 0, "fromPort": "output_name", "to": 1, "toPort": "input_name" }
  ]
}

- "from" and "to" are zero-based indices into the nodes array
- Only include fields relevant to each node type
- Script nodes MUST have "code" with proper @input/@output JSDoc annotations
- Make sure every connection references port names that actually exist on the source and target nodes

EXAMPLE — "Generate a poem about a theme and save it to a file":

{
  "name": "Poem Generator & Saver",
  "nodes": [
    {
      "type": "text",
      "label": "Theme",
      "textNode": { "value": "autumn leaves" }
    },
    {
      "type": "script",
      "label": "Generate Poem",
      "description": "Generate a poem from a theme using AI",
      "code": "/**\\n * @input theme string \\"The theme to write about\\"\\n * @output poem string \\"The generated poem\\"\\n * @output title string \\"A title for the poem\\"\\n */\\nasync function execute(inputs, context) {\\n  const { theme } = inputs;\\n  const result = await context.llm.generateJSON(\\n    \`Write a poem about \\"\${theme}\\". Return JSON: { \\"title\\": \\"...\\\", \\"poem\\": \\"...\\" }\`\\n  );\\n  return { poem: result.poem, title: result.title };\\n}"
    },
    {
      "type": "script",
      "label": "Save to File",
      "description": "Write text content to a file",
      "code": "/**\\n * @input content string \\"Text to save\\"\\n * @input filename string \\"File name\\"\\n * @output file_path string \\"Path where saved\\"\\n */\\nasync function execute(inputs, context) {\\n  const fs = require('fs');\\n  const path = require('path');\\n  const { content, filename } = inputs;\\n  const dir = path.join(require('os').homedir(), 'Documents', 'outputs');\\n  fs.mkdirSync(dir, { recursive: true });\\n  const fp = path.join(dir, filename + '.txt');\\n  fs.writeFileSync(fp, content, 'utf-8');\\n  return { file_path: fp };\\n}"
    }
  ],
  "connections": [
    { "from": 0, "fromPort": "text", "to": 1, "toPort": "theme" },
    { "from": 1, "fromPort": "poem", "to": 2, "toPort": "content" },
    { "from": 1, "fromPort": "title", "to": 2, "toPort": "filename" }
  ]
}

Remember: respond with ONLY the JSON object.`;

      const { runPrompt } = await import('../../loop/llm-service.js');

      const pipelineModel = process.env.ANTHROPIC_API_KEY
        ? 'claude-sonnet-4-20250514'
        : process.env.OPENAI_API_KEY
          ? 'gpt-4o-mini'
          : process.env.GROQ_API_KEY
            ? 'llama-3.1-70b-versatile'
            : 'claude-sonnet-4-20250514';

      const pipelineMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: pipelineSystemPrompt },
        { role: 'user', content: description.trim() },
      ];

      const llmResp = await runPrompt(pipelineMessages, pipelineModel, { maxTokens: 8192, temperature: 0.7 });
      const rawResponse = llmResp.content.trim();

      // Extract JSON — may be wrapped in ```json ... ```
      let jsonStr = rawResponse;
      const jsonFenceMatch = rawResponse.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (jsonFenceMatch) {
        jsonStr = jsonFenceMatch[1].trim();
      }

      let pipeline: any;
      try {
        pipeline = JSON.parse(jsonStr);
      } catch {
        sendJson(res, 422, { error: 'LLM returned invalid JSON', raw: rawResponse });
        return true;
      }

      if (!Array.isArray(pipeline.nodes) || pipeline.nodes.length === 0) {
        sendJson(res, 422, { error: 'Pipeline must have at least one node', raw: rawResponse });
        return true;
      }

      // Map type strings to workflowId and ID prefixes
      const typeToWorkflowId: Record<string, string> = {
        script: '__script__', text: '__text__', file_op: '__file_op__',
        image_viewer: '__image_viewer__', media: '__media__', asset: '__asset__',
      };
      const typeToPrefix: Record<string, string> = {
        script: 'script', text: 'text', file_op: 'fileop',
        image_viewer: 'node', asset: 'asset',
      };

      const realNodes: any[] = [];
      const idByIndex: string[] = [];

      for (let i = 0; i < pipeline.nodes.length; i++) {
        const pNode = pipeline.nodes[i];
        const nodeType = pNode.type || 'script';
        const workflowId = typeToWorkflowId[nodeType] || '__script__';
        const prefix = typeToPrefix[nodeType] || 'script';
        const id = prefix + '-' + Math.random().toString(36).slice(2, 9);
        idByIndex.push(id);

        const node: any = {
          id,
          workflowId,
          position: { x: 0, y: 0 },
          label: pNode.label || `Step ${i + 1}`,
        };

        if (workflowId === '__script__') {
          const code = pNode.code || '';
          const ports = parseScriptPorts(code);
          node.script = {
            description: pNode.description || pNode.label || '',
            code,
            inputs: ports.inputs.length > 0 ? ports.inputs : (pNode.inputs || []),
            outputs: ports.outputs.length > 0 ? ports.outputs : (pNode.outputs || []),
            chatHistory: [],
          };
        } else if (workflowId === '__text__') {
          node.textNode = { value: pNode.textNode?.value || pNode.value || '' };
        } else if (workflowId === '__file_op__') {
          node.fileOp = { operation: pNode.fileOp?.operation || 'copy' };
        } else if (workflowId === '__image_viewer__') {
          node.imageViewer = pNode.imageViewer || { filePath: '', width: 300, height: 300 };
        } else if (workflowId === '__media__') {
          node.mediaPlayer = pNode.mediaPlayer || { sourceMode: 'file_path', filePath: '', url: '', assetId: '', mediaType: 'auto', width: 320, height: 240, title: '', autoPlay: false, defaultVolume: 0.8, loop: false, playbackRate: 1.0, imageFit: 'contain' };
        } else if (workflowId === '__asset__') {
          node.asset = pNode.asset || { mode: 'pick' };
        }

        realNodes.push(node);
      }

      // Build edges from connections
      const realEdges: any[] = [];
      if (Array.isArray(pipeline.connections)) {
        for (const conn of pipeline.connections) {
          const srcId = idByIndex[conn.from];
          const tgtId = idByIndex[conn.to];
          if (!srcId || !tgtId) continue;

          // Auto-correct text node output port
          const srcNode = realNodes.find((n: any) => n.id === srcId);
          let sourcePort = conn.fromPort;
          if (srcNode?.workflowId === '__text__' && sourcePort !== 'text') {
            sourcePort = 'text';
          }

          realEdges.push({
            id: 'edge-' + Math.random().toString(36).slice(2, 9),
            sourceNodeId: srcId,
            sourcePort,
            targetNodeId: tgtId,
            targetPort: conn.toPort,
          });
        }
      }

      debugLog.info('dashboard', 'Pipeline generated', {
        model: pipelineModel,
        nodeCount: realNodes.length,
        edgeCount: realEdges.length,
        description: description.slice(0, 100),
      });

      sendJson(res, 200, {
        success: true,
        name: pipeline.name || 'Generated Pipeline',
        nodes: realNodes,
        edges: realEdges,
      });
    } catch (err) {
      debugLog.error('dashboard', 'Pipeline generation failed', { error: String(err) });
      sendJson(res, 500, { error: `Pipeline generation failed: ${(err as Error).message}` });
    }
    return true;
  }

  return false;
};
