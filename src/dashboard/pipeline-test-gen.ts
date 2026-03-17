/**
 * Pipeline Test Generation & Execution
 *
 * Generates real .test.ts files for v2 file-backed pipeline nodes,
 * runs them with vitest, and returns structured results.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { existsSync } from 'fs';
import { execSync, spawn } from 'child_process';
import type { PortDeclaration } from '../workflow/types.js';
import { parsePortAnnotations } from './pipeline-sync.js';
import { debugLog } from '../debug-log.js';

// ── Types ────────────────────────────────────────────────────

export interface PipelineTestResult {
  success: boolean;
  totalTests: number;
  passed: number;
  failed: number;
  errors: number;
  testFiles: Array<{
    file: string;
    tests: Array<{
      name: string;
      status: 'pass' | 'fail' | 'skip';
      duration: number;
      error?: string;
    }>;
  }>;
  stdout: string;
  stderr: string;
  duration: number;
}

// ── Test helpers file content ────────────────────────────────

const TEST_HELPERS_CONTENT = `/**
 * Woodbury Pipeline Test Helpers
 * Provides mock ScriptContext for testing execute() functions.
 * Auto-generated — safe to customize.
 */

interface MockContextOverrides {
  /** Mock return value or function for context.llm.generate() */
  llmGenerate?: string | ((prompt: string) => string | Promise<string>);
  /** Mock return value or function for context.llm.generateJSON() */
  llmGenerateJSON?: unknown | ((prompt: string) => unknown | Promise<unknown>);
  /** Mock tool implementations keyed by tool name */
  tools?: Record<string, (params: any) => Promise<any>>;
}

interface ProgressState {
  started: boolean;
  completed: number;
  total?: number;
  label?: string;
}

/**
 * Create a mock ScriptContext for testing pipeline nodes.
 *
 * @example
 * const { context, logs, progressState } = createMockContext({
 *   llmGenerate: 'mocked response',
 * });
 * const result = await execute({ query: 'test' }, context);
 * expect(result.output).toBeDefined();
 */
export function createMockContext(overrides: MockContextOverrides = {}): {
  context: any;
  logs: string[];
  progressState: ProgressState;
} {
  const logs: string[] = [];
  const progressState: ProgressState = {
    started: false,
    completed: 0,
    total: undefined,
    label: undefined,
  };

  const context = {
    llm: {
      generate: async (prompt: string) => {
        if (typeof overrides.llmGenerate === 'function') return overrides.llmGenerate(prompt);
        return overrides.llmGenerate ?? '';
      },
      generateJSON: async (prompt: string) => {
        if (typeof overrides.llmGenerateJSON === 'function') return overrides.llmGenerateJSON(prompt);
        return overrides.llmGenerateJSON ?? {};
      },
    },
    log: (message: string) => { logs.push(String(message)); },
    tools: new Proxy({} as Record<string, any>, {
      get(_target, prop) {
        if (typeof prop === 'string' && overrides.tools && prop in overrides.tools) {
          return overrides.tools[prop];
        }
        return async () => {
          throw new Error(\`context.tools.\${String(prop)} is not mocked — add it to createMockContext({ tools: { \${String(prop)}: ... } })\`);
        };
      },
    }),
    progress: {
      start(total: number, label?: string) {
        progressState.started = true;
        progressState.completed = 0;
        progressState.total = total;
        progressState.label = label;
      },
      set(completed: number, total?: number, label?: string) {
        progressState.started = true;
        progressState.completed = completed;
        if (typeof total === 'number') progressState.total = total;
        if (label) progressState.label = label;
      },
      increment(label?: string) {
        progressState.started = true;
        progressState.completed += 1;
        if (label) progressState.label = label;
      },
      complete(label?: string) {
        progressState.started = true;
        if (typeof progressState.total === 'number') progressState.completed = progressState.total;
        if (label) progressState.label = label;
      },
    },
  };

  return { context, logs, progressState };
}
`;

// ── Sample value generators ──────────────────────────────────

function sampleValueForType(type: string): string {
  switch (type) {
    case 'string': return `'test-value'`;
    case 'number': return '42';
    case 'boolean': return 'true';
    case 'string[]': return `['item-1', 'item-2']`;
    case 'number[]': return '[1, 2, 3]';
    case 'object': return `{ key: 'value' }`;
    case 'object[]': return `[{ key: 'value' }]`;
    default: return `'test'`;
  }
}

function typeAssertionForType(type: string, accessor: string): string {
  switch (type) {
    case 'string': return `expect(typeof ${accessor}).toBe('string');`;
    case 'number': return `expect(typeof ${accessor}).toBe('number');`;
    case 'boolean': return `expect(typeof ${accessor}).toBe('boolean');`;
    case 'string[]': return `expect(Array.isArray(${accessor})).toBe(true);`;
    case 'number[]': return `expect(Array.isArray(${accessor})).toBe(true);`;
    case 'object': return `expect(typeof ${accessor}).toBe('object'); expect(${accessor}).not.toBeNull();`;
    case 'object[]': return `expect(Array.isArray(${accessor})).toBe(true);`;
    default: return `expect(${accessor}).toBeDefined();`;
  }
}

// ── Test file generation ─────────────────────────────────────

/**
 * Generate a .test.ts file for a pipeline node.
 */
export function generateNodeTestFile(
  nodeFileName: string,
  code: string,
  inputs: PortDeclaration[],
  outputs: PortDeclaration[],
  options?: {
    nodeLabel?: string;
    description?: string;
  },
): string {
  const moduleName = nodeFileName.replace(/\.ts$/, '');
  const label = options?.nodeLabel || moduleName;

  // Use provided ports, fall back to parsing annotations from code
  const ports = (inputs.length > 0 || outputs.length > 0)
    ? { inputs, outputs }
    : parsePortAnnotations(code);

  const sampleInputs = ports.inputs.map(p =>
    `    ${p.name}: ${sampleValueForType(p.type || 'string')},`
  ).join('\n');

  const outputKeyChecks = ports.outputs.map(p =>
    `    expect(result).toHaveProperty('${p.name}');`
  ).join('\n');

  const outputTypeChecks = ports.outputs.map(p =>
    `    ${typeAssertionForType(p.type || 'string', `result.${p.name}`)}`
  ).join('\n');

  // Determine if the code calls context.llm
  const usesLlm = /context\.llm\.(generate|generateJSON)/.test(code);
  const mockOverrides = usesLlm
    ? `{\n      llmGenerate: 'mock LLM response',\n      llmGenerateJSON: { result: 'mock' },\n    }`
    : '{}';

  const lines: string[] = [
    `import { describe, it, expect } from 'vitest';`,
    `import { createMockContext } from './_test-helpers.js';`,
    ``,
    `// Import the execute function from the node file`,
    `// Note: vitest resolves .ts files automatically`,
    `const { execute } = await import('./${moduleName}.js');`,
    ``,
    `describe('${label}', () => {`,
    `  it('should export an execute function', () => {`,
    `    expect(typeof execute).toBe('function');`,
    `  });`,
    ``,
    `  it('should return all declared output keys', async () => {`,
    `    const { context } = createMockContext(${mockOverrides});`,
    `    const result = await execute({`,
    sampleInputs || '    // no declared inputs',
    `    }, context);`,
    ``,
    `    expect(result).toBeDefined();`,
    `    expect(typeof result).toBe('object');`,
  ];

  if (outputKeyChecks) {
    lines.push(outputKeyChecks);
  }

  lines.push(`  });`);

  // Type assertion test
  if (ports.outputs.length > 0) {
    lines.push(``);
    lines.push(`  it('should return outputs with correct types', async () => {`);
    lines.push(`    const { context } = createMockContext(${mockOverrides});`);
    lines.push(`    const result = await execute({`);
    lines.push(sampleInputs || '    // no declared inputs');
    lines.push(`    }, context);`);
    lines.push(``);
    if (outputTypeChecks) {
      lines.push(outputTypeChecks);
    }
    lines.push(`  });`);
  }

  // Empty input resilience test
  lines.push(``);
  lines.push(`  it('should handle empty inputs without throwing', async () => {`);
  lines.push(`    const { context } = createMockContext(${mockOverrides});`);
  lines.push(`    // Should not throw — may return default/empty values`);
  lines.push(`    await expect(execute({}, context)).resolves.toBeDefined();`);
  lines.push(`  });`);

  // Progress tracking test if code uses progress
  if (/context\.progress\./.test(code)) {
    lines.push(``);
    lines.push(`  it('should report progress', async () => {`);
    lines.push(`    const { context, progressState } = createMockContext(${mockOverrides});`);
    lines.push(`    await execute({`);
    lines.push(sampleInputs || '    // no declared inputs');
    lines.push(`    }, context);`);
    lines.push(``);
    lines.push(`    expect(progressState.started).toBe(true);`);
    lines.push(`  });`);
  }

  lines.push(`});`);
  lines.push(``);

  return lines.join('\n');
}

// ── Ensure infrastructure ────────────────────────────────────

/**
 * Ensure _test-helpers.ts exists in the pipeline directory.
 */
export async function ensureTestHelpers(pipelineDir: string): Promise<void> {
  // Prefer src/ directory if it exists (new layout), fall back to root (legacy)
  const srcDir = join(pipelineDir, 'src');
  const useSrc = existsSync(srcDir);
  const targetDir = useSrc ? srcDir : pipelineDir;
  const helpersPath = join(targetDir, '_test-helpers.ts');
  if (!existsSync(helpersPath)) {
    await fs.writeFile(helpersPath, TEST_HELPERS_CONTENT, 'utf-8');
  }
}

/**
 * Ensure vitest.config.ts exists in the pipeline directory.
 */
export async function ensureVitestConfig(pipelineDir: string): Promise<void> {
  const configPath = join(pipelineDir, 'vitest.config.ts');
  if (!existsSync(configPath)) {
    const config = `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', '*.test.ts'],
    globals: false,
    testTimeout: 15000,
  },
});
`;
    await fs.writeFile(configPath, config, 'utf-8');
  }
}

/**
 * Ensure vitest is installed in the pipeline directory.
 * Adds to package.json devDependencies if missing and runs npm install.
 */
export async function ensureVitestInstalled(pipelineDir: string): Promise<boolean> {
  // Check if already installed
  const vitestBin = join(pipelineDir, 'node_modules', '.bin', 'vitest');
  if (existsSync(vitestBin)) return true;

  try {
    // Add vitest to package.json devDependencies if not present
    const pkgPath = join(pipelineDir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
      if (!pkg.devDependencies) pkg.devDependencies = {};
      if (!pkg.devDependencies.vitest) {
        pkg.devDependencies.vitest = '^3.0.0';
        if (!pkg.scripts) pkg.scripts = {};
        if (!pkg.scripts.test) pkg.scripts.test = 'vitest run';
        await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
      }
    }

    execSync('npm install', {
      cwd: pipelineDir,
      stdio: 'pipe',
      timeout: 120000,
    });
    debugLog.info('pipeline-tests', 'vitest installed', { dir: pipelineDir });
    return true;
  } catch (err) {
    debugLog.warn('pipeline-tests', 'Failed to install vitest', { error: String(err) });
    return false;
  }
}

// ── Test execution ───────────────────────────────────────────

/**
 * Run vitest in a pipeline directory and return structured results.
 */
export async function runPipelineTests(
  pipelineDir: string,
  options?: { timeout?: number; nodeFilter?: string },
): Promise<PipelineTestResult> {
  const timeout = options?.timeout || 60000;
  const startTime = Date.now();

  // Ensure infrastructure
  await ensureTestHelpers(pipelineDir);
  await ensureVitestConfig(pipelineDir);
  const installed = await ensureVitestInstalled(pipelineDir);
  if (!installed) {
    return {
      success: false,
      totalTests: 0,
      passed: 0,
      failed: 0,
      errors: 1,
      testFiles: [],
      stdout: '',
      stderr: 'Failed to install vitest',
      duration: Date.now() - startTime,
    };
  }

  return new Promise<PipelineTestResult>((resolve) => {
    const args = ['vitest', 'run', '--reporter=json'];
    if (options?.nodeFilter) {
      // Filter to a specific test file
      const filterFile = options.nodeFilter.replace(/\.ts$/, '.test.ts');
      if (!filterFile.endsWith('.test.ts')) {
        args.push(filterFile + '.test.ts');
      } else {
        args.push(filterFile);
      }
    }

    let stdout = '';
    let stderr = '';

    const child = spawn('npx', args, {
      cwd: pipelineDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout,
      env: { ...process.env, FORCE_COLOR: '0', NODE_NO_WARNINGS: '1' },
    });

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      const duration = Date.now() - startTime;
      try {
        const result = parseVitestJsonOutput(stdout, stderr, duration);
        resolve(result);
      } catch (err) {
        // If JSON parsing fails, still return what we can
        resolve({
          success: code === 0,
          totalTests: 0,
          passed: 0,
          failed: 0,
          errors: code !== 0 ? 1 : 0,
          testFiles: [],
          stdout,
          stderr: stderr || String(err),
          duration,
        });
      }
    });

    child.on('error', (err) => {
      resolve({
        success: false,
        totalTests: 0,
        passed: 0,
        failed: 0,
        errors: 1,
        testFiles: [],
        stdout,
        stderr: err.message,
        duration: Date.now() - startTime,
      });
    });
  });
}

/**
 * Parse vitest JSON reporter output into structured results.
 */
function parseVitestJsonOutput(stdout: string, stderr: string, duration: number): PipelineTestResult {
  // vitest --reporter=json outputs a JSON object to stdout
  // Try to find the JSON block in stdout (may have other text around it)
  let json: any = null;

  // Try parsing the entire stdout first
  try {
    json = JSON.parse(stdout);
  } catch {
    // Try to find a JSON block that starts with { and contains "testResults"
    const jsonMatch = stdout.match(/\{[\s\S]*"testResults"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        json = JSON.parse(jsonMatch[0]);
      } catch { /* fall through */ }
    }
  }

  if (!json || !json.testResults) {
    // Fallback: parse text output for pass/fail counts
    const passMatch = stdout.match(/(\d+)\s+passed/);
    const failMatch = stdout.match(/(\d+)\s+failed/);
    const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
    const failed = failMatch ? parseInt(failMatch[1], 10) : 0;
    return {
      success: failed === 0 && !stderr.includes('Error'),
      totalTests: passed + failed,
      passed,
      failed,
      errors: 0,
      testFiles: [],
      stdout,
      stderr,
      duration,
    };
  }

  // Parse vitest JSON reporter format
  const testFiles: PipelineTestResult['testFiles'] = [];
  let totalPassed = 0;
  let totalFailed = 0;
  let totalErrors = 0;
  let totalTests = 0;

  for (const suite of json.testResults || []) {
    const file = suite.name || suite.filepath || 'unknown';
    const tests: PipelineTestResult['testFiles'][0]['tests'] = [];

    for (const test of suite.assertionResults || []) {
      const status = test.status === 'passed' ? 'pass' as const
        : test.status === 'failed' ? 'fail' as const
        : 'skip' as const;

      tests.push({
        name: test.fullName || test.title || 'unnamed',
        status,
        duration: test.duration || 0,
        error: test.failureMessages?.join('\n') || undefined,
      });

      totalTests++;
      if (status === 'pass') totalPassed++;
      else if (status === 'fail') totalFailed++;
    }

    testFiles.push({ file, tests });
  }

  return {
    success: totalFailed === 0 && totalErrors === 0,
    totalTests,
    passed: totalPassed,
    failed: totalFailed,
    errors: totalErrors,
    testFiles,
    stdout,
    stderr,
    duration,
  };
}

/**
 * Generate test files for all script-file nodes in a pipeline directory.
 * Returns the list of test files created.
 */
export async function generateAllNodeTests(
  pipelineDir: string,
  nodes: Array<{ scriptFile?: { file: string; inputs?: PortDeclaration[]; outputs?: PortDeclaration[] }; label?: string; workflowId?: string }>,
): Promise<string[]> {
  const created: string[] = [];

  for (const node of nodes) {
    if (node.workflowId !== '__script_file__' || !node.scriptFile?.file) continue;

    try {
      const filePath = join(pipelineDir, node.scriptFile.file);
      const code = await fs.readFile(filePath, 'utf-8');
      // For test generation, use just the basename for module imports
      const nodeBaseName = node.scriptFile.file.includes('/')
        ? node.scriptFile.file.split('/').pop()!
        : node.scriptFile.file;
      const testFileName = node.scriptFile.file.replace(/\.ts$/, '.test.ts');
      const testCode = generateNodeTestFile(
        nodeBaseName,
        code,
        node.scriptFile.inputs || [],
        node.scriptFile.outputs || [],
        { nodeLabel: node.label },
      );
      // Write test file alongside source file
      await fs.writeFile(join(pipelineDir, testFileName), testCode, 'utf-8');
      created.push(testFileName);
    } catch (err) {
      debugLog.warn('pipeline-tests', 'Failed to generate test for node', {
        file: node.scriptFile.file,
        error: String(err),
      });
    }
  }

  return created;
}
