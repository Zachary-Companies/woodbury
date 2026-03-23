/**
 * Tests for new workflow step types:
 *   http_request, eval, extract_structured, parallel
 *   and extended VariableSource types: json_parse, expression
 *
 * These test the execution logic in isolation by constructing
 * a WorkflowExecutor with a mock bridge.
 */

import { WorkflowExecutor } from '../workflow/executor.js';
import type {
  WorkflowDocument,
  HttpRequestStep,
  EvalStep,
  ExtractStructuredStep,
  ParallelStep,
  SetVariableStep,
  BridgeInterface,
} from '../workflow/types.js';

// ── Mock bridge (no-op for non-browser steps) ───────────────

function createMockBridge(): BridgeInterface {
  return {
    send: jest.fn().mockResolvedValue({}),
    isConnected: true,
  } as any;
}

function makeWorkflow(steps: any[], variables?: any[]): WorkflowDocument {
  return {
    version: '1.0',
    id: 'test-workflow',
    name: 'Test Workflow',
    description: 'Test',
    site: 'test.com',
    variables: variables || [],
    steps: steps.map((s, i) => ({ id: `step-${i}`, label: `Step ${i}`, ...s })),
    metadata: { createdAt: '', updatedAt: '', recordedBy: 'manual' as const },
  };
}

// ── http_request step ───────────────────────────────────────

describe('HttpRequestStep', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should make a GET request and store response body', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ data: 'hello' })),
    }) as any;

    const workflow = makeWorkflow([{
      type: 'http_request',
      method: 'GET',
      url: 'https://api.example.com/data',
      outputVariable: 'result',
    }]);

    const executor = new WorkflowExecutor(createMockBridge(), { variables: {} });
    const result = await executor.execute(workflow);
    expect(result.success).toBe(true);
    expect(result.variables?.result).toEqual({ data: 'hello' });
  });

  it('should store HTTP status code', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: () => Promise.resolve('created'),
    }) as any;

    const workflow = makeWorkflow([{
      type: 'http_request',
      method: 'POST',
      url: 'https://api.example.com/create',
      body: { name: 'test' },
      statusVariable: 'httpStatus',
      outputVariable: 'response',
    }]);

    const executor = new WorkflowExecutor(createMockBridge(), { variables: {} });
    const result = await executor.execute(workflow);
    expect(result.success).toBe(true);
    expect(result.variables?.httpStatus).toBe(201);
  });

  it('should fail when expectedStatus does not match', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('not found'),
    }) as any;

    const workflow = makeWorkflow([{
      type: 'http_request',
      method: 'GET',
      url: 'https://api.example.com/missing',
      expectedStatus: 200,
    }]);

    const executor = new WorkflowExecutor(createMockBridge(), { variables: {} });
    const result = await executor.execute(workflow);
    expect(result.success).toBe(false);
  });

  it('should store plain text when response is not JSON', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('plain text response'),
    }) as any;

    const workflow = makeWorkflow([{
      type: 'http_request',
      method: 'GET',
      url: 'https://example.com',
      outputVariable: 'body',
    }]);

    const executor = new WorkflowExecutor(createMockBridge(), { variables: {} });
    const result = await executor.execute(workflow);
    expect(result.success).toBe(true);
    expect(result.variables?.body).toBe('plain text response');
  });
});

// ── eval step ───────────────────────────────────────────────

describe('EvalStep', () => {
  it('should evaluate a simple expression', async () => {
    const workflow = makeWorkflow([
      { type: 'set_variable', variable: 'x', source: { type: 'literal', value: 10 } } as any,
      { type: 'eval', expression: 'variables.x * 2', outputVariable: 'doubled' },
    ]);

    const executor = new WorkflowExecutor(createMockBridge(), { variables: {} });
    const result = await executor.execute(workflow);
    expect(result.success).toBe(true);
    expect(result.variables?.doubled).toBe(20);
  });

  it('should evaluate array operations', async () => {
    const workflow = makeWorkflow([
      { type: 'set_variable', variable: 'items', source: { type: 'literal', value: [1, 2, 3, 4, 5] } } as any,
      { type: 'eval', expression: 'variables.items.filter(n => n > 3)', outputVariable: 'filtered' },
    ]);

    const executor = new WorkflowExecutor(createMockBridge(), { variables: {} });
    const result = await executor.execute(workflow);
    expect(result.success).toBe(true);
    expect(result.variables?.filtered).toEqual([4, 5]);
  });

  it('should fail on invalid expressions', async () => {
    const workflow = makeWorkflow([
      { type: 'eval', expression: 'undefined.property.deep', outputVariable: 'result' },
    ]);

    const executor = new WorkflowExecutor(createMockBridge(), { variables: {} });
    const result = await executor.execute(workflow);
    expect(result.success).toBe(false);
  });
});

// ── extract_structured step ─────────────────────────────────

describe('ExtractStructuredStep', () => {
  it('should parse JSON from a variable', async () => {
    const workflow = makeWorkflow([
      { type: 'set_variable', variable: 'raw', source: { type: 'literal', value: '{"a":1,"b":2}' } } as any,
      { type: 'extract_structured', source: 'json_parse', inputVariable: 'raw', outputVariable: 'parsed' },
    ]);

    const executor = new WorkflowExecutor(createMockBridge(), { variables: {} });
    const result = await executor.execute(workflow);
    expect(result.success).toBe(true);
    expect(result.variables?.parsed).toEqual({ a: 1, b: 2 });
  });

  it('should split a string by delimiter', async () => {
    const workflow = makeWorkflow([
      { type: 'set_variable', variable: 'csv', source: { type: 'literal', value: 'a,b,c' } } as any,
      { type: 'extract_structured', source: 'split', inputVariable: 'csv', pattern: ',', outputVariable: 'parts' },
    ]);

    const executor = new WorkflowExecutor(createMockBridge(), { variables: {} });
    const result = await executor.execute(workflow);
    expect(result.success).toBe(true);
    expect(result.variables?.parts).toEqual(['a', 'b', 'c']);
  });

  it('should extract regex groups', async () => {
    const workflow = makeWorkflow([
      { type: 'set_variable', variable: 'text', source: { type: 'literal', value: 'user@domain' } } as any,
      { type: 'extract_structured', source: 'regex_groups', inputVariable: 'text', pattern: '(\\w+)@(\\w+)', outputVariable: 'groups' },
    ]);

    const executor = new WorkflowExecutor(createMockBridge(), { variables: {} });
    const result = await executor.execute(workflow);
    expect(result.success).toBe(true);
    expect(result.variables?.groups).toEqual(['user', 'domain']);
  });

  it('should fail on invalid JSON', async () => {
    const workflow = makeWorkflow([
      { type: 'set_variable', variable: 'bad', source: { type: 'literal', value: 'not json' } } as any,
      { type: 'extract_structured', source: 'json_parse', inputVariable: 'bad', outputVariable: 'parsed' },
    ]);

    const executor = new WorkflowExecutor(createMockBridge(), { variables: {} });
    const result = await executor.execute(workflow);
    expect(result.success).toBe(false);
  });
});

// ── Extended VariableSource types ───────────────────────────

describe('Extended VariableSource', () => {
  it('should parse JSON via set_variable json_parse source', async () => {
    const workflow = makeWorkflow([
      { type: 'set_variable', variable: 'raw', source: { type: 'literal', value: '[1,2,3]' } } as any,
      { type: 'set_variable', variable: 'arr', source: { type: 'json_parse', input: 'raw' } } as any,
    ]);

    const executor = new WorkflowExecutor(createMockBridge(), { variables: {} });
    const result = await executor.execute(workflow);
    expect(result.success).toBe(true);
    expect(result.variables?.arr).toEqual([1, 2, 3]);
  });

  it('should evaluate expression via set_variable expression source', async () => {
    const workflow = makeWorkflow([
      { type: 'set_variable', variable: 'a', source: { type: 'literal', value: 5 } } as any,
      { type: 'set_variable', variable: 'b', source: { type: 'expression', expression: 'variables.a + 10' } } as any,
    ]);

    const executor = new WorkflowExecutor(createMockBridge(), { variables: {} });
    const result = await executor.execute(workflow);
    expect(result.success).toBe(true);
    expect(result.variables?.b).toBe(15);
  });

  it('should return null for json_parse on invalid input', async () => {
    const workflow = makeWorkflow([
      { type: 'set_variable', variable: 'raw', source: { type: 'literal', value: 'not json' } } as any,
      { type: 'set_variable', variable: 'parsed', source: { type: 'json_parse', input: 'raw' } } as any,
    ]);

    const executor = new WorkflowExecutor(createMockBridge(), { variables: {} });
    const result = await executor.execute(workflow);
    expect(result.success).toBe(true);
    expect(result.variables?.parsed).toBeNull();
  });
});

// ── parallel step ───────────────────────────────────────────

describe('ParallelStep', () => {
  it('should execute branches concurrently', async () => {
    const workflow = makeWorkflow([
      {
        type: 'parallel',
        branches: [
          [{ id: 'a1', label: 'A', type: 'set_variable', variable: 'a', source: { type: 'literal', value: 1 } }],
          [{ id: 'b1', label: 'B', type: 'set_variable', variable: 'b', source: { type: 'literal', value: 2 } }],
        ],
      },
    ]);

    const executor = new WorkflowExecutor(createMockBridge(), { variables: {} });
    const result = await executor.execute(workflow);
    expect(result.success).toBe(true);
    expect(result.variables?.a).toBe(1);
    expect(result.variables?.b).toBe(2);
  });

  it('should collect failures from all branches when failFast is false', async () => {
    const workflow = makeWorkflow([
      {
        type: 'parallel',
        failFast: false,
        branches: [
          [{ id: 'ok', label: 'OK', type: 'set_variable', variable: 'x', source: { type: 'literal', value: 1 } }],
          [{ id: 'bad', label: 'Bad', type: 'eval', expression: 'undefined.x', outputVariable: 'y' }],
        ],
      },
    ]);

    const executor = new WorkflowExecutor(createMockBridge(), { variables: {} });
    const result = await executor.execute(workflow);
    expect(result.success).toBe(false);
  });
});

// ── End-to-end: chained data steps ──────────────────────────

describe('Chained data steps', () => {
  it('should chain http_request → eval → extract_structured', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({
        users: [
          { name: 'Alice', active: true },
          { name: 'Bob', active: false },
          { name: 'Carol', active: true },
        ]
      })),
    }) as any;

    const workflow = makeWorkflow([
      {
        type: 'http_request',
        method: 'GET',
        url: 'https://api.example.com/users',
        outputVariable: 'apiData',
      },
      {
        type: 'eval',
        expression: 'variables.apiData.users.filter(u => u.active).map(u => u.name).join(",")',
        outputVariable: 'activeNames',
      },
      {
        type: 'extract_structured',
        source: 'split',
        inputVariable: 'activeNames',
        pattern: ',',
        outputVariable: 'nameList',
      },
    ]);

    const executor = new WorkflowExecutor(createMockBridge(), { variables: {} });
    const result = await executor.execute(workflow);
    expect(result.success).toBe(true);
    expect(result.variables?.nameList).toEqual(['Alice', 'Carol']);
  });
});
