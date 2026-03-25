/**
 * View Scaffolding — templates and generation logic for pipeline React views.
 *
 * When a new v2 pipeline is generated, this module:
 * 1. Creates the views/ directory with a shared esbuild build script
 * 2. Scaffolds a generic Overview view that works for any pipeline
 * 3. Optionally generates additional views tailored to the pipeline's output data
 * 4. Compiles all view bundles via esbuild
 */
import { mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { debugLog } from '../debug-log.js';

const execFileAsync = promisify(execFile);

// ── Template: build.mjs ──────────────────────────────────────────────────────
// Shared esbuild build script — identical for every pipeline.
// Scans views/<name>/entry.tsx and produces IIFE bundles with React externalized.

const BUILD_MJS = `#!/usr/bin/env node
/**
 * Build script for pipeline React view bundles.
 *
 * Scans views/<name>/entry.tsx for view entry points and produces
 * views/<name>/view.bundle.js IIFE bundles. React/ReactDOM are externalized
 * and resolved at runtime from window.__WoodburyViewSDK.
 */
import { build } from 'esbuild';
import { readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const woodburyExternalsPlugin = {
  name: 'woodbury-externals',
  setup(build) {
    build.onResolve(
      { filter: /^react$|^react-dom$|^react\\/jsx-runtime$|^react-dom\\/client$/ },
      (args) => ({ path: args.path, namespace: 'woodbury-sdk' })
    );
    build.onLoad({ filter: /.*/, namespace: 'woodbury-sdk' }, (args) => {
      const mapping = {
        'react': 'window.__WoodburyViewSDK.React',
        'react-dom': 'window.__WoodburyViewSDK.ReactDOM',
        'react-dom/client': 'window.__WoodburyViewSDK.ReactDOM',
        'react/jsx-runtime': 'window.__WoodburyViewSDK.jsxRuntime',
      };
      const global = mapping[args.path] || 'window.__WoodburyViewSDK.React';
      return { contents: \`module.exports = \${global};\`, loader: 'js' };
    });
  },
};

const viewsDir = __dirname;
const dirs = readdirSync(viewsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .filter((d) => existsSync(join(viewsDir, d.name, 'entry.tsx')));

if (dirs.length === 0) {
  console.log('build:views — no entry.tsx files found, skipping.');
  process.exit(0);
}

console.log(\`build:views — building \${dirs.length} view bundle(s)...\`);

for (const dir of dirs) {
  const entry = join(viewsDir, dir.name, 'entry.tsx');
  const outfile = join(viewsDir, dir.name, 'view.bundle.js');

  await build({
    entryPoints: [entry],
    bundle: true,
    outfile,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    jsx: 'automatic',
    jsxImportSource: 'react',
    plugins: [woodburyExternalsPlugin],
    define: { 'process.env.NODE_ENV': '"production"' },
    minify: false,
    sourcemap: 'inline',
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
  });

  console.log(\`  ✓ \${dir.name}/view.bundle.js\`);
}

console.log('build:views — done.');
`;

// ── Template: sdk.ts ─────────────────────────────────────────────────────────
// Standard SDK shim — resolves hooks/components at runtime from the host app.

const SDK_TS = `/**
 * SDK shim — resolves PipelineProvider/ImageZoom imports at runtime
 * from the host app's window.__WoodburyViewSDK global.
 * React imports are handled by the esbuild externals plugin.
 */
const SDK = (window as any).__WoodburyViewSDK as any;

export const usePipeline = SDK.usePipeline;
export const usePipelineIdentity = SDK.usePipelineIdentity;
export const useProjectData = SDK.useProjectData;
export const useAIOperations = SDK.useAIOperations;
export const ImageZoom = SDK.ImageZoom;
export const PipelineProvider = SDK.PipelineProvider;

// Generic type aliases
export type ProjectData = any;
`;

// ── Template helpers ─────────────────────────────────────────────────────────

function makeEntryTsx(viewName: string, componentName: string): string {
  return `import { ${componentName} } from './${componentName}';
const sdk = (window as any).__WoodburyViewSDK;
sdk.registerReactView({ name: '${viewName}', component: ${componentName} });
`;
}

function makeManifest(name: string, label: string, icon: string, order: number): string {
  return JSON.stringify({ name, label, icon, type: 'react', bundle: 'view.bundle.js', order }, null, 2);
}

// ── Generic Overview component ───────────────────────────────────────────────
// Works for ANY pipeline — shows name, description, node stats, output summaries.

function makeGenericOverviewTsx(pipelineName: string): string {
  return `/**
 * OverviewView — generic pipeline dashboard.
 * Shows pipeline info, node stats, and output data summaries.
 */
import React, { useMemo } from 'react';
import { usePipeline, usePipelineIdentity } from './sdk';

interface OverviewViewProps {
  schema: any | null;
  appState: any | null;
}

export function OverviewView({ schema, appState }: OverviewViewProps) {
  const { project: projectData, pipelineName } = usePipeline();
  const { pipelineId } = usePipelineIdentity();

  const title = projectData?.metadata?.title || pipelineName || ${JSON.stringify(pipelineName)};
  const description = projectData?.metadata?.description || projectData?.metadata?.logline || '';

  // Node stats from app state
  const nodeData = appState?.nodeData || {};
  const staleNodes = appState?.staleNodes || [];
  const schemaSections = schema?.sections || [];

  const totalNodes = schemaSections.length;
  const nodesWithData = schemaSections.filter((s: any) => s.nodeId && nodeData[s.nodeId]).length;
  const staleCount = staleNodes.length;

  // Collect output summaries from all nodes
  const outputSummaries = useMemo(() => {
    const summaries: { nodeLabel: string; keys: { name: string; type: string; count?: number }[] }[] = [];
    for (const section of schemaSections) {
      const nd = section.nodeId && nodeData[section.nodeId];
      if (!nd?.outputs) continue;
      const keys: { name: string; type: string; count?: number }[] = [];
      for (const [key, value] of Object.entries(nd.outputs)) {
        if (key.startsWith('_')) continue;
        if (Array.isArray(value)) {
          keys.push({ name: key, type: 'array', count: (value as any[]).length });
        } else if (value && typeof value === 'object') {
          keys.push({ name: key, type: 'object' });
        } else if (typeof value === 'string') {
          keys.push({ name: key, type: 'string', count: (value as string).length });
        } else {
          keys.push({ name: key, type: typeof value });
        }
      }
      if (keys.length > 0) {
        summaries.push({ nodeLabel: section.label || section.nodeId, keys });
      }
    }
    return summaries;
  }, [schemaSections, nodeData]);

  return (
    <div className="h-full overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
      {/* Hero */}
      <div className="relative overflow-hidden" style={{ minHeight: 200 }}>
        <div className="absolute inset-0" style={{
          background: 'linear-gradient(135deg, rgba(124,58,237,0.15) 0%, rgba(56,189,248,0.08) 50%, transparent 100%)',
        }} />
        <div className="relative z-10 px-8 pt-10 pb-8">
          <h1 style={{
            fontSize: 32, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.15,
            background: 'linear-gradient(135deg, #fff 20%, #c4b5fd 60%, #7dd3fc 100%)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
            backgroundClip: 'text', marginBottom: 8,
          }}>{title}</h1>
          {description && (
            <p style={{ fontSize: 14, color: '#94a3b8', maxWidth: 640, lineHeight: 1.6 }}>
              {description}
            </p>
          )}
        </div>
      </div>

      {/* Stats Row */}
      <div className="px-8 -mt-2 mb-8">
        <div className="grid grid-cols-3 gap-3">
          <StatCard value={totalNodes} label="Nodes" icon="⚡" color="#a78bfa" />
          <StatCard value={nodesWithData} label="With Data" icon="✅" color="#34d399" />
          <StatCard value={staleCount} label="Stale" icon="🔄" color="#fbbf24" />
        </div>
      </div>

      {/* Output Summaries */}
      {outputSummaries.length > 0 && (
        <div className="px-8 mb-8">
          <div className="flex items-center gap-3 mb-4">
            <h2 style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0' }}>Node Outputs</h2>
            <div style={{ flex: 1, height: 1, background: 'rgba(139,92,246,0.1)' }} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            {outputSummaries.map((summary) => (
              <OutputCard key={summary.nodeLabel} summary={summary} />
            ))}
          </div>
        </div>
      )}

      {/* Pipeline Nodes Status */}
      {schemaSections.length > 0 && (
        <div className="px-8 mb-8">
          <div className="flex items-center gap-3 mb-4">
            <h2 style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0' }}>Pipeline Nodes</h2>
            <div style={{ flex: 1, height: 1, background: 'rgba(139,92,246,0.1)' }} />
          </div>
          <div className="grid grid-cols-4 gap-2">
            {schemaSections.map((section: any) => {
              const hasData = !!(section.nodeId && nodeData[section.nodeId]);
              const isStale = staleNodes.includes(section.nodeId);
              const dotColor = isStale ? '#fbbf24' : hasData ? '#34d399' : '#334155';
              return (
                <div key={section.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 12px', borderRadius: 8,
                  background: hasData ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.01)',
                  border: \`1px solid \${isStale ? 'rgba(251,191,36,0.15)' : 'rgba(255,255,255,0.04)'}\`,
                  opacity: hasData ? 1 : 0.5,
                }}>
                  <div style={{
                    width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                    background: dotColor,
                    boxShadow: hasData && !isStale ? '0 0 6px rgba(52,211,153,0.4)' : undefined,
                  }} />
                  <span style={{
                    fontSize: 11, color: '#94a3b8', fontWeight: 500,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{section.label}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="h-8" />
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ value, label, icon, color }: { value: number; label: string; icon: string; color: string }) {
  return (
    <div style={{
      position: 'relative', overflow: 'hidden',
      padding: '16px', borderRadius: 14,
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(255,255,255,0.06)',
    }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 2,
        background: \`linear-gradient(90deg, transparent, \${color}88, transparent)\`,
        opacity: 0.6,
      }} />
      <div className="flex items-center gap-3">
        <span style={{ fontSize: 22 }}>{icon}</span>
        <div>
          <div style={{ fontSize: 26, fontWeight: 800, color: '#f8fafc', letterSpacing: '-0.02em', lineHeight: 1 }}>
            {value}
          </div>
          <div style={{ fontSize: 10, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 2 }}>
            {label}
          </div>
        </div>
      </div>
    </div>
  );
}

function OutputCard({ summary }: { summary: { nodeLabel: string; keys: { name: string; type: string; count?: number }[] } }) {
  return (
    <div style={{
      padding: '14px 16px', borderRadius: 12,
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(255,255,255,0.06)',
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>
        {summary.nodeLabel}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {summary.keys.slice(0, 6).map((k) => (
          <div key={k.name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
            <span style={{
              padding: '1px 6px', borderRadius: 4, fontSize: 9, fontWeight: 600,
              background: k.type === 'array' ? 'rgba(139,92,246,0.15)' :
                k.type === 'string' ? 'rgba(56,189,248,0.12)' :
                k.type === 'object' ? 'rgba(52,211,153,0.12)' : 'rgba(100,116,139,0.15)',
              color: k.type === 'array' ? '#c4b5fd' :
                k.type === 'string' ? '#7dd3fc' :
                k.type === 'object' ? '#6ee7b7' : '#94a3b8',
            }}>{k.type}{k.count !== undefined ? \` (\${k.count})\` : ''}</span>
            <span style={{ color: '#94a3b8' }}>{k.name}</span>
          </div>
        ))}
        {summary.keys.length > 6 && (
          <div style={{ fontSize: 10, color: '#475569' }}>+{summary.keys.length - 6} more</div>
        )}
      </div>
    </div>
  );
}
`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create the views/ directory and write the shared build.mjs script.
 */
export async function scaffoldViewsDirectory(pipelineDir: string): Promise<void> {
  const viewsDir = join(pipelineDir, 'views');
  await mkdir(viewsDir, { recursive: true });
  await writeFile(join(viewsDir, 'build.mjs'), BUILD_MJS, 'utf-8');
  debugLog.info('view-scaffolding', `Created views/build.mjs in ${pipelineDir}`);
}

/**
 * Scaffold a generic Overview view that works for any pipeline.
 */
export async function scaffoldGenericOverview(pipelineDir: string, pipelineName: string): Promise<void> {
  const viewDir = join(pipelineDir, 'views', 'overview');
  await mkdir(viewDir, { recursive: true });

  await Promise.all([
    writeFile(join(viewDir, 'manifest.json'), makeManifest('overview', 'Overview', '📋', 10), 'utf-8'),
    writeFile(join(viewDir, 'sdk.ts'), SDK_TS, 'utf-8'),
    writeFile(join(viewDir, 'entry.tsx'), makeEntryTsx('overview', 'OverviewView'), 'utf-8'),
    writeFile(join(viewDir, 'OverviewView.tsx'), makeGenericOverviewTsx(pipelineName), 'utf-8'),
  ]);

  debugLog.info('view-scaffolding', `Created views/overview/ in ${pipelineDir}`);
}

/**
 * Write a custom React view from generated code.
 */
async function writeViewFiles(
  pipelineDir: string,
  viewName: string,
  label: string,
  icon: string,
  order: number,
  componentName: string,
  componentCode: string,
): Promise<void> {
  const viewDir = join(pipelineDir, 'views', viewName);
  await mkdir(viewDir, { recursive: true });

  await Promise.all([
    writeFile(join(viewDir, 'manifest.json'), makeManifest(viewName, label, icon, order), 'utf-8'),
    writeFile(join(viewDir, 'sdk.ts'), SDK_TS, 'utf-8'),
    writeFile(join(viewDir, 'entry.tsx'), makeEntryTsx(viewName, componentName), 'utf-8'),
    writeFile(join(viewDir, `${componentName}.tsx`), componentCode, 'utf-8'),
  ]);
}

/**
 * Compile all view bundles by running the build.mjs script.
 */
async function buildViews(pipelineDir: string): Promise<boolean> {
  const buildScript = join(pipelineDir, 'views', 'build.mjs');
  if (!existsSync(buildScript)) return false;

  try {
    await execFileAsync('node', [buildScript], {
      cwd: join(pipelineDir, 'views'),
      timeout: 30000,
      env: { ...process.env, NODE_PATH: join(pipelineDir, '..', '..', '..', 'Documents', 'GitHub', 'woodbury', 'node_modules') },
    });
    return true;
  } catch (err: any) {
    debugLog.warn('view-scaffolding', 'View build failed', { error: err.stderr || String(err) });
    return false;
  }
}

/**
 * Generate pipeline views: scaffold overview + LLM-generated views + build.
 *
 * @param pipelineDir - Absolute path to the pipeline directory
 * @param pipelineName - Human-readable pipeline name
 * @param pipelineDescription - What the pipeline does
 * @param nodes - Pipeline nodes array (with inputs/outputs/labels)
 * @returns Which views were created and whether the build succeeded
 */
export async function generatePipelineViews(
  pipelineDir: string,
  pipelineName: string,
  pipelineDescription: string,
  nodes: any[],
): Promise<{ viewsGenerated: string[]; buildSuccess: boolean }> {
  const viewsGenerated: string[] = [];

  // 1. Scaffold base directory + generic overview
  await scaffoldViewsDirectory(pipelineDir);
  await scaffoldGenericOverview(pipelineDir, pipelineName);
  viewsGenerated.push('overview');

  // 2. Analyze pipeline outputs to determine what additional views to generate
  const outputSchema = nodes
    .filter((n: any) => n.outputs && n.outputs.length > 0)
    .map((n: any) => ({
      label: n.label || n.id,
      outputs: (n.outputs || []).map((o: any) => ({
        name: o.name,
        type: o.type || 'any',
        description: o.description || '',
      })),
    }));

  // 3. Generate additional views via LLM if there's meaningful output data
  if (outputSchema.length > 0) {
    try {
      const additionalViews = await generateAdditionalViews(
        pipelineName,
        pipelineDescription,
        outputSchema,
      );

      for (const view of additionalViews) {
        try {
          await writeViewFiles(
            pipelineDir,
            view.name,
            view.label,
            view.icon,
            view.order,
            view.componentName,
            view.componentCode,
          );
          viewsGenerated.push(view.name);
        } catch (err) {
          debugLog.warn('view-scaffolding', `Failed to write view "${view.name}"`, { error: String(err) });
        }
      }
    } catch (err) {
      debugLog.warn('view-scaffolding', 'LLM view generation failed (overview still available)', { error: String(err) });
    }
  }

  // 4. Build all view bundles
  const buildSuccess = await buildViews(pipelineDir);

  debugLog.info('view-scaffolding', `Pipeline views generated`, {
    pipelineDir,
    viewsGenerated,
    buildSuccess,
  });

  return { viewsGenerated, buildSuccess };
}

// ── LLM-driven view generation ───────────────────────────────────────────────

interface GeneratedView {
  name: string;
  label: string;
  icon: string;
  order: number;
  componentName: string;
  componentCode: string;
}

async function generateAdditionalViews(
  pipelineName: string,
  pipelineDescription: string,
  outputSchema: { label: string; outputs: { name: string; type: string; description: string }[] }[],
): Promise<GeneratedView[]> {
  const { runPrompt } = await import('../loop/llm-service.js');

  const schemaText = outputSchema
    .map(n => `Node "${n.label}": ${n.outputs.map(o => `${o.name} (${o.type}${o.description ? ': ' + o.description : ''})`).join(', ')}`)
    .join('\n');

  const result = await runPrompt(
    [
      {
        role: 'system',
        content: `You generate React view components for a pipeline dashboard. Each view displays pipeline output data using hooks from the SDK.

AVAILABLE SDK HOOKS (import from './sdk'):
- usePipeline() → { project, pipelineName, pipelineId, projectFolder }
  project contains all pipeline output data merged together
- usePipelineIdentity() → { pipelineId, pipelineName, projectFolder }
- useProjectData() → { project, setProject, saveProject }
- ImageZoom — zoomable image component

RULES:
- Import React and hooks: import React, { useMemo } from 'react';
- Import SDK hooks: import { usePipeline } from './sdk';
- Export a named function component
- Access data via usePipeline().project — data is stored in nodeData outputs
- Also receive { schema, appState } as props — appState.nodeData has raw node outputs
- Style with inline styles (dark theme: backgrounds rgba(255,255,255,0.03), text colors #e2e8f0/#94a3b8/#64748b)
- Make views data-driven — handle missing/empty data gracefully
- DO NOT generate views for characters/scenes/screenplay data unless the pipeline explicitly produces that
- Generate 1-2 views that make sense for THIS pipeline's output data

RESPONSE FORMAT — JSON array (no markdown fences):
[
  {
    "name": "view-slug",
    "label": "View Label",
    "icon": "emoji",
    "order": 20,
    "componentName": "MyView",
    "componentCode": "import React from 'react';\\nimport { usePipeline } from './sdk';\\n..."
  }
]`,
      },
      {
        role: 'user',
        content: `Pipeline: "${pipelineName}"
Description: ${pipelineDescription || 'No description provided'}

Output schema:
${schemaText}

Generate 1-2 React view components that would be useful for viewing this pipeline's output data. Return ONLY the JSON array.`,
      },
    ],
    process.env.WOODBURY_SCRIPT_MODEL_GENERATION || 'claude-sonnet-4-20250514',
    {
      provider: (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai') as any,
      maxTokens: 4000,
      temperature: 0.3,
    },
  );

  const content = (result as any).content || result;
  if (!content || typeof content !== 'string') return [];

  // Parse JSON from response (strip markdown fences if present)
  const jsonStr = content.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();

  try {
    const views = JSON.parse(jsonStr);
    if (!Array.isArray(views)) return [];

    return views
      .filter((v: any) => v.name && v.componentName && v.componentCode)
      .slice(0, 3) // Max 3 additional views
      .map((v: any) => ({
        name: String(v.name).replace(/[^a-z0-9-]/gi, '-').toLowerCase(),
        label: String(v.label || v.name),
        icon: String(v.icon || '📊'),
        order: Number(v.order) || 30,
        componentName: String(v.componentName),
        componentCode: String(v.componentCode),
      }));
  } catch {
    debugLog.warn('view-scaffolding', 'Failed to parse LLM view generation response');
    return [];
  }
}
