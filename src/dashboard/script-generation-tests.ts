import { runInNewContext } from 'node:vm';

export interface ScriptGenerationTestCase {
  name: string;
  inputs?: Record<string, unknown>;
  llmGenerate?: string;
  llmGenerateJSON?: unknown;
  expectedOutputSubset?: Record<string, unknown>;
  requiredOutputKeys?: string[];
  expectedOutputTypes?: Record<string, string>;
  requireProgressCalls?: boolean;
  requireProgressCompletion?: boolean;
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

interface MockAssetCollection {
  id: string;
  name: string;
  slug: string;
  description: string;
  tags: string[];
  rootPath: string | null;
  created_at: string;
}

interface MockAssetRecord {
  id: string;
  name: string;
  file_path: string;
  file_path_absolute: string;
  collections: string[];
  tags: string[];
  created_at: string;
}

function slugifyAssetCollectionName(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function createMockAssetToolContext() {
  let nextCollectionId = 1;
  let nextAssetId = 1;
  const collections: MockAssetCollection[] = [];
  const assets: MockAssetRecord[] = [];

  function ensureCollectionRecord(params: Record<string, unknown>): MockAssetCollection {
    const requestedName = String(params.name || params.collection || '').trim();
    const slug = slugifyAssetCollectionName(String(params.slug || requestedName || 'collection')) || `collection-${nextCollectionId}`;
    const existing = collections.find((collection) => collection.slug === slug);
    if (existing) return existing;
    const created: MockAssetCollection = {
      id: `col_${String(nextCollectionId++).padStart(4, '0')}`,
      name: requestedName || slug,
      slug,
      description: String(params.description || ''),
      tags: Array.isArray(params.tags) ? params.tags.map((tag) => String(tag)) : [],
      rootPath: typeof params.rootPath === 'string' && params.rootPath.trim() ? params.rootPath : null,
      created_at: '2026-03-14T00:00:00.000Z',
    };
    collections.push(created);
    return created;
  }

  return {
    asset_collection_list: async (params: Record<string, unknown> = {}) => {
      const query = String(params.collection || params.slug || params.name || '').trim().toLowerCase();
      const filtered = query
        ? collections.filter((collection) => {
          return collection.slug.toLowerCase() === query || collection.name.toLowerCase() === query;
        })
        : collections.slice();
      const response = filtered.slice() as MockAssetCollection[] & Record<string, unknown>;
      response.success = true;
      response.collections = filtered;
      response.items = filtered;
      response.results = filtered;
      response.count = filtered.length;
      response.collection = filtered[0] || null;
      response.result = { collections: filtered, collection: filtered[0] || null };
      return response;
    },
    asset_collection_get: async (params: Record<string, unknown> = {}) => {
      const query = String(params.slug || params.collection || params.name || params.id || '').trim().toLowerCase();
      const collection = collections.find((candidate) => {
        return candidate.slug.toLowerCase() === query
          || candidate.name.toLowerCase() === query
          || candidate.id.toLowerCase() === query;
      }) || null;
      return {
        success: Boolean(collection),
        id: collection?.id || '',
        slug: collection?.slug || '',
        name: collection?.name || '',
        collection,
        result: { collection },
      };
    },
    asset_collection_create: async (params: Record<string, unknown> = {}) => {
      const collection = ensureCollectionRecord(params);
      return {
        success: true,
        created: collection.id === `col_${String(nextCollectionId - 1).padStart(4, '0')}`,
        id: collection.id,
        slug: collection.slug,
        name: collection.name,
        collection,
        result: { collection },
      };
    },
    asset_save: async (params: Record<string, unknown> = {}) => {
      const collectionSlug = typeof params.collection === 'string' && params.collection.trim()
        ? ensureCollectionRecord({ collection: params.collection, name: params.collection }).slug
        : undefined;
      const name = String(params.name || 'Generated Asset').trim() || 'Generated Asset';
      const filePath = String(params.file_path || `${name}.json`).trim() || `${name}.json`;
      const asset: MockAssetRecord = {
        id: `ast_${String(nextAssetId++).padStart(4, '0')}`,
        name,
        file_path: filePath,
        file_path_absolute: filePath.startsWith('/') ? filePath : `/mock-assets/${filePath}`,
        collections: collectionSlug ? [collectionSlug] : [],
        tags: Array.isArray(params.tags) ? params.tags.map((tag) => String(tag)) : [],
        created_at: '2026-03-14T00:00:00.000Z',
      };
      assets.push(asset);
      return {
        success: true,
        id: asset.id,
        asset_id: asset.id,
        file_path: asset.file_path,
        file_path_absolute: asset.file_path_absolute,
        asset,
        result: { asset },
      };
    },
    asset_list: async (params: Record<string, unknown> = {}) => {
      const collection = typeof params.collection === 'string' ? params.collection.trim().toLowerCase() : '';
      const filtered = collection
        ? assets.filter((asset) => asset.collections.some((slug) => slug.toLowerCase() === collection))
        : assets.slice();
      return {
        success: true,
        assets: filtered,
        result: { assets: filtered },
      };
    },
    asset_get: async (params: Record<string, unknown> = {}) => {
      const query = String(params.id || '').trim().toLowerCase();
      const asset = assets.find((candidate) => candidate.id.toLowerCase() === query) || null;
      return {
        success: Boolean(asset),
        asset,
        result: { asset },
      };
    },
  };
}

function createScriptTestExecutionContext(testCase: ScriptGenerationTestCase) {
  const progressState: ScriptTestProgressState = {
    started: false,
    completed: 0,
    total: undefined,
    label: undefined,
  };
  const logs: string[] = [];
  const assetTools = createMockAssetToolContext();

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
          if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(assetTools, prop)) {
            return (assetTools as Record<string, unknown>)[prop];
          }
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

function valueMatchesDeclaredType(value: unknown, declaredType: string): boolean {
  switch (declaredType) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    case 'string[]':
      return Array.isArray(value) && value.every((item) => typeof item === 'string');
    case 'number[]':
      return Array.isArray(value) && value.every((item) => typeof item === 'number' && Number.isFinite(item));
    case 'object[]':
      return Array.isArray(value) && value.every((item) => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
    default:
      return true;
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

      if (testCase.expectedOutputTypes) {
        const outputRecord = output && typeof output === 'object' ? output as Record<string, unknown> : {};
        for (const [key, declaredType] of Object.entries(testCase.expectedOutputTypes)) {
          if (!(key in outputRecord)) continue;
          if (!valueMatchesDeclaredType(outputRecord[key], declaredType)) {
            failures.push(`output key ${key} does not match declared type ${declaredType}`);
          }
        }
      }

      if (progressState.started && typeof progressState.total === 'number' && progressState.completed > progressState.total) {
        failures.push(`progress completed value ${progressState.completed} exceeds total ${progressState.total}`);
      }

      if (testCase.requireProgressCalls && !progressState.started) {
        failures.push('expected script to report progress but no progress calls were observed');
      }

      if (testCase.requireProgressCompletion) {
        if (!progressState.started) {
          failures.push('expected script to complete progress reporting but no progress calls were observed');
        } else if (typeof progressState.total !== 'number') {
          failures.push('expected script to provide a finite progress total');
        } else if (progressState.completed !== progressState.total) {
          failures.push(`expected progress to complete at ${progressState.total} but received ${progressState.completed}`);
        }
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