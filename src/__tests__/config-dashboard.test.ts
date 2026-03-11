/**
 * Tests for config-dashboard.ts and writeEnvFile in extension-loader.ts
 *
 * Verifies:
 * - writeEnvFile() serializes to .env format correctly
 * - writeEnvFile() round-trips with parseEnvFile()
 * - maskValue() masks API keys correctly
 * - Dashboard server starts and stops cleanly
 * - API routes return correct responses
 * - PUT route writes .env files and merges correctly
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';

// Stable test directories
const TEST_HOME = join(tmpdir(), `woodbury-dashboard-test-${process.pid}-${Date.now()}`);
const TEST_EXT_DIR = join(TEST_HOME, '.woodbury', 'extensions');

// Mock node:os so homedir() returns our test home
jest.mock('node:os', () => ({
  ...jest.requireActual('node:os'),
  homedir: () => TEST_HOME,
}));

import { parseEnvFile, writeEnvFile } from '../extension-loader';
import { maskValue, startDashboard, type DashboardHandle } from '../config-dashboard';

// ── Helper: HTTP fetch (lightweight, no external deps) ──────────

function httpGet(url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode!, body: raw });
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function httpPut(url: string, data: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode!, body: raw });
          }
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Helper: create a test extension with optional .env ──────────

async function createTestExtension(
  name: string,
  opts?: {
    envDeclarations?: Record<string, { required: boolean; description: string }>;
    envFile?: Record<string, string>;
  }
) {
  const dir = join(TEST_EXT_DIR, name);
  await fs.mkdir(dir, { recursive: true });

  const pkg: any = {
    name: `woodbury-ext-${name}`,
    version: '1.0.0',
    main: 'index.js',
    woodbury: {
      name,
      displayName: name.charAt(0).toUpperCase() + name.slice(1),
      description: `Test extension: ${name}`,
      provides: ['tools'],
    },
  };

  if (opts?.envDeclarations) {
    pkg.woodbury.env = opts.envDeclarations;
  }

  await fs.writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  await fs.writeFile(
    join(dir, 'index.js'),
    'module.exports = { async activate() {} };'
  );

  if (opts?.envFile) {
    const content = writeEnvFile(opts.envFile);
    await fs.writeFile(join(dir, '.env'), content);
  }

  return dir;
}

// ── Setup / Teardown ────────────────────────────────────────────

beforeAll(async () => {
  await fs.mkdir(TEST_EXT_DIR, { recursive: true });
});

afterAll(async () => {
  try {
    await fs.rm(TEST_HOME, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

// ── writeEnvFile tests ──────────────────────────────────────────

describe('writeEnvFile', () => {
  it('should serialize simple key=value pairs', () => {
    const result = writeEnvFile({ FOO: 'bar', BAZ: 'qux' });
    expect(result).toContain('FOO=bar');
    expect(result).toContain('BAZ=qux');
    expect(result.endsWith('\n')).toBe(true);
  });

  it('should quote values containing spaces', () => {
    const result = writeEnvFile({ KEY: 'hello world' });
    expect(result).toContain('KEY="hello world"');
  });

  it('should quote values containing # character', () => {
    const result = writeEnvFile({ KEY: 'value#comment' });
    expect(result).toContain('KEY="value#comment"');
  });

  it('should quote values containing = character', () => {
    const result = writeEnvFile({ KEY: 'a=b' });
    expect(result).toContain('KEY="a=b"');
  });

  it('should skip empty values', () => {
    const result = writeEnvFile({ FOO: 'bar', EMPTY: '', BAZ: 'qux' });
    expect(result).toContain('FOO=bar');
    expect(result).toContain('BAZ=qux');
    expect(result).not.toContain('EMPTY');
  });

  it('should round-trip with parseEnvFile', () => {
    const original = {
      API_KEY: 'sk-1234567890abcdef',
      SECRET: 'my-secret-value',
      URL: 'https://example.com/api',
    };
    const serialized = writeEnvFile(original);
    const parsed = parseEnvFile(serialized);
    expect(parsed).toEqual(original);
  });

  it('should round-trip values with special characters', () => {
    const original = {
      SPACED: 'hello world',
      HASHED: 'value#with#hash',
      EQUALS: 'key=val',
    };
    const serialized = writeEnvFile(original);
    const parsed = parseEnvFile(serialized);
    expect(parsed).toEqual(original);
  });

  it('should escape double quotes in values', () => {
    const result = writeEnvFile({ KEY: 'say "hello"' });
    expect(result).toContain('KEY="say \\"hello\\""');
    // And round-trip
    const parsed = parseEnvFile(result);
    expect(parsed.KEY).toBe('say \\"hello\\"');
  });
});

// ── maskValue tests ─────────────────────────────────────────────

describe('maskValue', () => {
  it('should mask long values showing first 4 and last 4', () => {
    const result = maskValue('sk-proj-1234567890abcdef');
    expect(result.startsWith('sk-p')).toBe(true);
    expect(result.endsWith('cdef')).toBe(true);
    expect(result).toContain('*');
    expect(result.length).toBe('sk-proj-1234567890abcdef'.length);
  });

  it('should fully mask short values (≤8 chars)', () => {
    const result = maskValue('12345678');
    expect(result).toBe('********');
  });

  it('should fully mask very short values', () => {
    const result = maskValue('abc');
    expect(result).toBe('***');
  });

  it('should return empty string for empty input', () => {
    expect(maskValue('')).toBe('');
  });
});

// ── Dashboard server tests ──────────────────────────────────────

describe('startDashboard', () => {
  let dashboard: DashboardHandle | null = null;

  afterEach(async () => {
    if (dashboard) {
      await dashboard.close();
      dashboard = null;
    }
  });

  it('should start and bind to 127.0.0.1', async () => {
    dashboard = await startDashboard(false);
    expect(dashboard.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(dashboard.port).toBeGreaterThan(0);
  });

  it('should stop cleanly with close()', async () => {
    dashboard = await startDashboard(false);
    const port = dashboard.port;
    await dashboard.close();
    dashboard = null;

    // Verify the server is actually closed by trying to connect
    await expect(
      httpGet(`http://127.0.0.1:${port}/api/extensions`)
    ).rejects.toThrow();
  });
});

// ── API route tests ─────────────────────────────────────────────

describe('Dashboard API', () => {
  let dashboard: DashboardHandle;

  beforeAll(async () => {
    // Clean and recreate extensions dir
    try {
      await fs.rm(TEST_EXT_DIR, { recursive: true, force: true });
    } catch {}
    await fs.mkdir(TEST_EXT_DIR, { recursive: true });

    dashboard = await startDashboard(false);
  });

  afterAll(async () => {
    await dashboard.close();
  });

  beforeEach(async () => {
    // Clean extensions dir between tests
    try {
      await fs.rm(TEST_EXT_DIR, { recursive: true, force: true });
    } catch {}
    await fs.mkdir(TEST_EXT_DIR, { recursive: true });
  });

  describe('GET /api/extensions', () => {
    it('should return empty list when no extensions exist', async () => {
      const { status, body } = await httpGet(
        `${dashboard.url}/api/extensions`
      );
      expect(status).toBe(200);
      // Filter out bundled extensions (shipped with Woodbury) — we only test user-installed ones
      const userExtensions = body.extensions.filter((e: any) => e.source !== 'bundled');
      expect(userExtensions).toEqual([]);
    });

    it('should return extensions with env var status', async () => {
      await createTestExtension('social', {
        envDeclarations: {
          API_KEY: { required: true, description: 'Social API key' },
          WEBHOOK: { required: false, description: 'Webhook URL' },
        },
        envFile: { API_KEY: 'sk-1234567890abcdef' },
      });

      const { status, body } = await httpGet(
        `${dashboard.url}/api/extensions`
      );
      expect(status).toBe(200);
      // Filter to just user-installed extensions for test assertions
      const userExtensions = body.extensions.filter((e: any) => e.source !== 'bundled');
      expect(userExtensions).toHaveLength(1);

      const ext = userExtensions[0];
      expect(ext.name).toBe('social');
      expect(ext.vars).toHaveLength(2);

      const apiKeyVar = ext.vars.find((v: any) => v.name === 'API_KEY');
      expect(apiKeyVar.isSet).toBe(true);
      expect(apiKeyVar.required).toBe(true);
      expect(apiKeyVar.maskedValue).toContain('*');
      // Should NOT contain the full key
      expect(apiKeyVar.maskedValue).not.toBe('sk-1234567890abcdef');

      const webhookVar = ext.vars.find((v: any) => v.name === 'WEBHOOK');
      expect(webhookVar.isSet).toBe(false);
      expect(webhookVar.maskedValue).toBeNull();
    });
  });

  describe('GET /api/extensions/:name/env', () => {
    it('should return env status for a specific extension', async () => {
      await createTestExtension('analytics', {
        envDeclarations: {
          TOKEN: { required: true, description: 'Analytics token' },
        },
        envFile: { TOKEN: 'tok_abcdef1234567890' },
      });

      const { status, body } = await httpGet(
        `${dashboard.url}/api/extensions/analytics/env`
      );
      expect(status).toBe(200);
      expect(body.name).toBe('analytics');
      expect(body.vars).toHaveLength(1);
      expect(body.vars[0].name).toBe('TOKEN');
      expect(body.vars[0].isSet).toBe(true);
    });

    it('should return 404 for nonexistent extension', async () => {
      const { status, body } = await httpGet(
        `${dashboard.url}/api/extensions/nonexistent/env`
      );
      expect(status).toBe(404);
      expect(body.error).toContain('not found');
    });
  });

  describe('PUT /api/extensions/:name/env', () => {
    it('should write env vars to .env file', async () => {
      const dir = await createTestExtension('writer', {
        envDeclarations: {
          MY_KEY: { required: true, description: 'A key' },
        },
      });

      const { status, body } = await httpPut(
        `${dashboard.url}/api/extensions/writer/env`,
        { vars: { MY_KEY: 'new-secret-value-12345' } }
      );
      expect(status).toBe(200);
      expect(body.success).toBe(true);

      // Verify .env was written
      const envContent = await fs.readFile(join(dir, '.env'), 'utf-8');
      const parsed = parseEnvFile(envContent);
      expect(parsed.MY_KEY).toBe('new-secret-value-12345');
    });

    it('should merge with existing .env (not destroy unmentioned vars)', async () => {
      const dir = await createTestExtension('merger', {
        envDeclarations: {
          KEY_A: { required: true, description: 'Key A' },
          KEY_B: { required: false, description: 'Key B' },
        },
        envFile: { KEY_A: 'original-a', KEY_B: 'original-b' },
      });

      // Only update KEY_A, leave KEY_B untouched
      const { status } = await httpPut(
        `${dashboard.url}/api/extensions/merger/env`,
        { vars: { KEY_A: 'updated-a' } }
      );
      expect(status).toBe(200);

      const envContent = await fs.readFile(join(dir, '.env'), 'utf-8');
      const parsed = parseEnvFile(envContent);
      expect(parsed.KEY_A).toBe('updated-a');
      expect(parsed.KEY_B).toBe('original-b');
    });

    it('should delete a var when value is empty string', async () => {
      const dir = await createTestExtension('deleter', {
        envDeclarations: {
          KEEP: { required: true, description: 'Keep this' },
          REMOVE: { required: false, description: 'Remove this' },
        },
        envFile: { KEEP: 'keep-val', REMOVE: 'remove-val' },
      });

      const { status } = await httpPut(
        `${dashboard.url}/api/extensions/deleter/env`,
        { vars: { REMOVE: '' } }
      );
      expect(status).toBe(200);

      const envContent = await fs.readFile(join(dir, '.env'), 'utf-8');
      const parsed = parseEnvFile(envContent);
      expect(parsed.KEEP).toBe('keep-val');
      expect(parsed.REMOVE).toBeUndefined();
    });

    it('should return 404 for nonexistent extension', async () => {
      const { status, body } = await httpPut(
        `${dashboard.url}/api/extensions/ghost/env`,
        { vars: { FOO: 'bar' } }
      );
      expect(status).toBe(404);
      expect(body.error).toContain('not found');
    });

    it('should return 400 for invalid env var name', async () => {
      await createTestExtension('badname', {
        envDeclarations: {},
      });

      const { status, body } = await httpPut(
        `${dashboard.url}/api/extensions/badname/env`,
        { vars: { '123BAD': 'value' } }
      );
      expect(status).toBe(400);
      expect(body.error).toContain('Invalid env var name');
    });

    it('should return 400 for missing vars object', async () => {
      await createTestExtension('nobody', {
        envDeclarations: {},
      });

      const { status, body } = await httpPut(
        `${dashboard.url}/api/extensions/nobody/env`,
        { notVars: {} }
      );
      expect(status).toBe(400);
      expect(body.error).toContain('vars');
    });

    it('should return updated status after write', async () => {
      await createTestExtension('status-check', {
        envDeclarations: {
          KEY: { required: true, description: 'Test key' },
        },
      });

      const { status, body } = await httpPut(
        `${dashboard.url}/api/extensions/status-check/env`,
        { vars: { KEY: 'new-value-1234567890' } }
      );
      expect(status).toBe(200);
      expect(body.success).toBe(true);

      // Response should include updated var status
      const keyVar = body.vars.find((v: any) => v.name === 'KEY');
      expect(keyVar.isSet).toBe(true);
      expect(keyVar.maskedValue).toContain('*');
    });
  });
});
