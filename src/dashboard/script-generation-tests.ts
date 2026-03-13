import { runInNewContext } from 'node:vm';

export interface ScriptGenerationTestCase {
  name: string;
  inputs?: Record<string, unknown>;
  llmGenerate?: string;
  llmGenerateJSON?: unknown;
  expectedOutputSubset?: Record<string, unknown>;
  requiredOutputKeys?: string[];
}

export interface ScriptGenerationTestResult {
  name: string;
  passed: boolean;
  failures: string[];
  output?: unknown;
  error?: string;
}

interface ScriptTestProgressState {
  started: boolean;
  completed: number;
  total?: number;
  label?: string;
}

function createScriptTestExecutionContext(testCase: ScriptGenerationTestCase) {
  const progressState: ScriptTestProgressState = {
    started: false,
    completed: 0,
    total: undefined,
    label: undefined,
  };
  const logs: string[] = [];

  return {
    context: {
      llm: {
        generate: async () => testCase.llmGenerate ?? '',
        generateJSON: async () => testCase.llmGenerateJSON ?? {},
      },
      log: (message: unknown) => {
        logs.push(String(message));
      },
      tools: new Proxy({}, {
        get(_target, prop) {
          return async () => {
            throw new Error(`context.tools.${String(prop)} is not configured in generated-script unit tests`);
          };
        },
      }),
      progress: {
        start(total: number, label?: string) {
          progressState.started = true;
          progressState.completed = 0;
          progressState.total = Number.isFinite(total) ? total : undefined;
          progressState.label = label;
        },
        set(completed: number, total?: number, label?: string) {
          progressState.started = true;
          progressState.completed = Number.isFinite(completed) ? completed : progressState.completed;
          if (typeof total === 'number' && Number.isFinite(total)) {
            progressState.total = total;
          }
          if (label) progressState.label = label;
        },
        increment(label?: string) {
          progressState.started = true;
          progressState.completed += 1;
          if (label) progressState.label = label;
        },
        complete(label?: string) {
          progressState.started = true;
          if (typeof progressState.total === 'number') {
            progressState.completed = progressState.total;
          }
          if (label) progressState.label = label;
        },
      },
    },
    logs,
    progressState,
  };
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function collectSubsetMismatches(actual: unknown, expected: unknown, path: string): string[] {
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) {
    return Object.is(actual, expected)
      ? []
      : [`${path} expected ${describeValue(expected)} but received ${describeValue(actual)}`];
  }

  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
    return [`${path} expected object subset ${describeValue(expected)} but received ${describeValue(actual)}`];
  }

  const failures: string[] = [];
  for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
    failures.push(...collectSubsetMismatches((actual as Record<string, unknown>)[key], value, `${path}.${key}`));
  }
  return failures;
}

export async function runGeneratedScriptUnitTests(
  code: string,
  testCases: ScriptGenerationTestCase[],
): Promise<ScriptGenerationTestResult[]> {
  const executeFn = runInNewContext(
    `${code}\nif (typeof execute !== 'function') { throw new Error('execute function was not defined'); }\nexecute;`,
    {
      console: { log: () => {}, warn: () => {}, error: () => {} },
      require: () => {
        throw new Error('require is disabled in generated-script unit tests');
      },
      setTimeout,
      clearTimeout,
      Promise,
    },
    { timeout: 1000 },
  ) as (inputs: Record<string, unknown>, context: any) => Promise<unknown>;

  const results: ScriptGenerationTestResult[] = [];
  for (const testCase of testCases) {
    const failures: string[] = [];
    try {
      const { context, progressState } = createScriptTestExecutionContext(testCase);
      const output = await Promise.race([
        Promise.resolve(executeFn(testCase.inputs || {}, context)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Test execution timed out')), 1000)),
      ]);

      if (testCase.requiredOutputKeys) {
        const outputRecord = output && typeof output === 'object' ? output as Record<string, unknown> : {};
        for (const key of testCase.requiredOutputKeys) {
          if (!(key in outputRecord)) {
            failures.push(`output is missing required key ${key}`);
          }
        }
      }

      if (testCase.expectedOutputSubset) {
        failures.push(...collectSubsetMismatches(output, testCase.expectedOutputSubset, 'output'));
      }

      if (progressState.started && typeof progressState.total === 'number' && progressState.completed > progressState.total) {
        failures.push(`progress completed value ${progressState.completed} exceeds total ${progressState.total}`);
      }

      results.push({
        name: testCase.name,
        passed: failures.length === 0,
        failures,
        output,
      });
    } catch (err) {
      results.push({
        name: testCase.name,
        passed: false,
        failures: failures.length > 0 ? failures : [String((err as Error).message || err)],
        error: (err as Error).message,
      });
    }
  }

  return results;
}