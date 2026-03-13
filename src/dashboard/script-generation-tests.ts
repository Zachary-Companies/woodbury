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
      const context = {
        llm: {
          generate: async () => testCase.llmGenerate ?? '',
          generateJSON: async () => testCase.llmGenerateJSON ?? {},
        },
        log: () => {},
        tools: {},
      };
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