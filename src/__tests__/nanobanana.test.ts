/**
 * Tests for nanobanana image generation tool — aspectRatio fix
 *
 * Verifies that the aspectRatio parameter is correctly included in the
 * Gemini API request body under generationConfig.imageConfig.aspectRatio.
 */

import { nanobanana, NanoBananaParams } from '../loop/tools/nanobanana';

// Mock fs to suppress file system operations
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  existsSync: jest.fn((p: string) => {
    // Return false for extension env file lookups so getApiKey() falls through to process.env
    if (typeof p === 'string' && p.includes('.woodbury')) return false;
    // Return true for output directory checks
    return true;
  }),
  readFileSync: jest.fn(),
}));

// Track fetch calls to inspect request bodies
let fetchCalls: Array<{ url: string; options: RequestInit; body: any }> = [];

// Mock fetch globally
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

function makeGeminiResponse(imageData = 'fakebase64imagedata') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [
              { inlineData: { data: imageData, mimeType: 'image/png' } },
              { text: 'Generated image' },
            ],
          },
        },
      ],
    }),
    text: async () => '',
  };
}

describe('nanobanana aspectRatio', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    fetchCalls = [];
    mockFetch.mockReset();
    process.env = { ...originalEnv, GEMINI_API_KEY: 'test-api-key' };

    mockFetch.mockImplementation(async (url: string, options: RequestInit) => {
      const body = JSON.parse(options.body as string);
      fetchCalls.push({ url, options, body });
      return makeGeminiResponse();
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('includes default aspectRatio (1:1) in generationConfig.imageConfig', async () => {
    const params: NanoBananaParams = {
      action: 'generate',
      prompt: 'A beautiful sunset over mountains',
      model: 'flash',
      aspectRatio: '1:1',
    };

    await nanobanana(params, '/tmp');

    expect(fetchCalls).toHaveLength(1);
    const { body } = fetchCalls[0];
    expect(body.generationConfig).toBeDefined();
    expect(body.generationConfig.imageConfig).toBeDefined();
    expect(body.generationConfig.imageConfig.aspectRatio).toBe('1:1');
  });

  it('passes custom aspectRatio (9:16) through to generationConfig.imageConfig', async () => {
    const params: NanoBananaParams = {
      action: 'generate',
      prompt: 'A tall skyscraper in portrait orientation',
      model: 'flash',
      aspectRatio: '9:16',
    };

    await nanobanana(params, '/tmp');

    expect(fetchCalls).toHaveLength(1);
    const { body } = fetchCalls[0];
    expect(body.generationConfig.imageConfig.aspectRatio).toBe('9:16');
  });

  it('passes custom aspectRatio (16:9) through to generationConfig.imageConfig', async () => {
    const params: NanoBananaParams = {
      action: 'generate',
      prompt: 'A wide cinematic landscape',
      model: 'flash',
      aspectRatio: '16:9',
    };

    await nanobanana(params, '/tmp');

    expect(fetchCalls).toHaveLength(1);
    const { body } = fetchCalls[0];
    expect(body.generationConfig.imageConfig.aspectRatio).toBe('16:9');
  });

  it('includes aspectRatio in the full request body sent to the API', async () => {
    const params: NanoBananaParams = {
      action: 'generate',
      prompt: 'Test prompt',
      model: 'flash',
      aspectRatio: '4:3',
    };

    await nanobanana(params, '/tmp');

    expect(fetchCalls).toHaveLength(1);
    const { body } = fetchCalls[0];

    // Verify the complete structure
    expect(body).toEqual(
      expect.objectContaining({
        contents: expect.any(Array),
        generationConfig: expect.objectContaining({
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: {
            aspectRatio: '4:3',
          },
        }),
      })
    );
  });

  it('includes aspectRatio in the response JSON', async () => {
    const params: NanoBananaParams = {
      action: 'generate',
      prompt: 'Test prompt',
      model: 'flash',
      aspectRatio: '21:9',
    };

    const result = await nanobanana(params, '/tmp');
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.aspectRatio).toBe('21:9');
  });

  it('uses 1:1 when aspectRatio is omitted from params (schema default)', async () => {
    // Simulate what happens when Zod applies the default
    const params: NanoBananaParams = {
      action: 'generate',
      prompt: 'Test prompt',
      model: 'flash',
      aspectRatio: '1:1', // Zod default
    };

    await nanobanana(params, '/tmp');

    expect(fetchCalls).toHaveLength(1);
    const { body } = fetchCalls[0];
    expect(body.generationConfig.imageConfig.aspectRatio).toBe('1:1');
  });

  it('includes aspectRatio for edit actions too', async () => {
    // Mock loading an image from a data URL
    const params: NanoBananaParams = {
      action: 'edit',
      prompt: 'Make it brighter',
      image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
      model: 'flash',
      aspectRatio: '3:2',
    };

    await nanobanana(params, '/tmp');

    expect(fetchCalls).toHaveLength(1);
    const { body } = fetchCalls[0];
    expect(body.generationConfig.imageConfig.aspectRatio).toBe('3:2');
  });
});
