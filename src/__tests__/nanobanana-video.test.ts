/**
 * Tests for nanobanana-video (Veo 3.1) video generation tool
 *
 * Verifies API request structure, image loading, video saving,
 * long-running operation polling, error handling, and parameter passing.
 */

import { nanobananaVideo, NanoBananaVideoParams } from '../loop/tools/nanobanana-video';

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

const mockFs = jest.requireMock('fs');

// Track fetch calls to inspect request bodies
let fetchCalls: Array<{ url: string; options: RequestInit; body: any }> = [];

// Mock fetch globally
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

function makeVeoResponse(videoData = 'ZmFrZXZpZGVvZGF0YQ==') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [
              { inlineData: { data: videoData, mimeType: 'video/mp4' } },
            ],
          },
        },
      ],
    }),
    text: async () => '',
  };
}

function makeOperationResponse(operationName: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      name: operationName,
      done: false,
    }),
    text: async () => '',
  };
}

function makeCompletedOperationResponse(videoData = 'ZmFrZXZpZGVvZGF0YQ==') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      name: 'operations/abc123',
      done: true,
      response: {
        candidates: [
          {
            content: {
              parts: [
                { inlineData: { data: videoData, mimeType: 'video/mp4' } },
              ],
            },
          },
        ],
      },
    }),
    text: async () => '',
  };
}

describe('nanobanana-video', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    fetchCalls = [];
    mockFetch.mockReset();
    mockFs.writeFileSync.mockReset();
    mockFs.mkdirSync.mockReset();
    process.env = { ...originalEnv, GEMINI_API_KEY: 'test-api-key' };

    mockFetch.mockImplementation(async (url: string, options: RequestInit) => {
      if (options?.body) {
        const body = JSON.parse(options.body as string);
        fetchCalls.push({ url, options, body });
      }
      return makeVeoResponse();
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('text-to-video sends correct API request with responseModalities VIDEO and videoConfig', async () => {
    const params: NanoBananaVideoParams = {
      action: 'text-to-video',
      prompt: 'A sunset over the ocean with gentle waves',
      duration: 6,
      aspectRatio: '16:9',
      model: 'veo-3.1',
      outputPath: '/tmp/test-video.mp4',
    };

    await nanobananaVideo(params, '/tmp');

    expect(fetchCalls).toHaveLength(1);
    const { url, body } = fetchCalls[0];

    // Correct model URL
    expect(url).toContain('veo-3.1');
    expect(url).toContain('generateContent');

    // Correct generation config
    expect(body.generationConfig).toBeDefined();
    expect(body.generationConfig.responseModalities).toEqual(['VIDEO']);
    expect(body.generationConfig.videoConfig).toBeDefined();
    expect(body.generationConfig.videoConfig.aspectRatio).toBe('16:9');
    expect(body.generationConfig.videoConfig.durationSeconds).toBe(6);

    // Only text part (no image)
    expect(body.contents[0].parts).toHaveLength(1);
    expect(body.contents[0].parts[0].text).toBe('A sunset over the ocean with gentle waves');
  });

  it('image-to-video includes image as inlineData part before text', async () => {
    const params: NanoBananaVideoParams = {
      action: 'image-to-video',
      prompt: 'Slowly zoom into the scene',
      image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
      duration: 4,
      aspectRatio: '16:9',
      model: 'veo-3.1',
      outputPath: '/tmp/test-video.mp4',
    };

    await nanobananaVideo(params, '/tmp');

    expect(fetchCalls).toHaveLength(1);
    const { body } = fetchCalls[0];

    // Should have 2 parts: image + text
    expect(body.contents[0].parts).toHaveLength(2);

    // First part is image
    expect(body.contents[0].parts[0].inline_data).toBeDefined();
    expect(body.contents[0].parts[0].inline_data.mime_type).toBe('image/png');
    expect(body.contents[0].parts[0].inline_data.data).toBe('iVBORw0KGgoAAAANSUhEUg==');

    // Second part is text
    expect(body.contents[0].parts[1].text).toBe('Slowly zoom into the scene');
  });

  it('saves video bytes to outputPath', async () => {
    const params: NanoBananaVideoParams = {
      action: 'text-to-video',
      prompt: 'A flying bird',
      outputPath: '/tmp/output/my-video.mp4',
    };

    await nanobananaVideo(params, '/tmp');

    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
    const [writePath, writeBuffer] = mockFs.writeFileSync.mock.calls[0];
    expect(writePath).toBe('/tmp/output/my-video.mp4');
    expect(Buffer.isBuffer(writeBuffer)).toBe(true);
  });

  it('returns success with filePath', async () => {
    const params: NanoBananaVideoParams = {
      action: 'text-to-video',
      prompt: 'A running horse',
      outputPath: '/tmp/horse.mp4',
    };

    const result = await nanobananaVideo(params, '/tmp');
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.filePath).toBe('/tmp/horse.mp4');
    expect(parsed.action).toBe('text-to-video');
    expect(parsed.model).toBe('veo-3.1');
    expect(parsed.duration).toBe(6);
  });

  it('handles API error gracefully', async () => {
    mockFetch.mockImplementation(async () => ({
      ok: false,
      status: 400,
      text: async () => 'Bad Request: invalid prompt',
      json: async () => ({}),
    }));

    const params: NanoBananaVideoParams = {
      action: 'text-to-video',
      prompt: '',
      outputPath: '/tmp/test.mp4',
    };

    const result = await nanobananaVideo(params, '/tmp');
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('API error');
    expect(parsed.error).toContain('400');
  });

  it('handles missing API key', async () => {
    delete process.env.GEMINI_API_KEY;

    const params: NanoBananaVideoParams = {
      action: 'text-to-video',
      prompt: 'A test',
      outputPath: '/tmp/test.mp4',
    };

    const result = await nanobananaVideo(params, '/tmp');
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('GEMINI_API_KEY not found');
  });

  it('polls long-running operations until complete', async () => {
    let callCount = 0;

    mockFetch.mockImplementation(async (url: string, options: RequestInit) => {
      callCount++;

      if (callCount === 1) {
        // Initial POST returns an operation
        if (options?.body) {
          const body = JSON.parse(options.body as string);
          fetchCalls.push({ url, options, body });
        }
        return makeOperationResponse('operations/video-gen-123');
      } else if (callCount === 2) {
        // First poll — still in progress
        return {
          ok: true,
          status: 200,
          json: async () => ({ name: 'operations/video-gen-123', done: false }),
          text: async () => '',
        };
      } else {
        // Second poll — done
        return makeCompletedOperationResponse('cG9sbGVkdmlkZW9kYXRh');
      }
    });

    const params: NanoBananaVideoParams = {
      action: 'text-to-video',
      prompt: 'A long generation scene',
      outputPath: '/tmp/polled-video.mp4',
    };

    const result = await nanobananaVideo(params, '/tmp');
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.filePath).toBe('/tmp/polled-video.mp4');
    // Should have made 3 fetch calls: 1 initial + 2 polls
    expect(callCount).toBe(3);
  });

  it('passes aspect ratio correctly in videoConfig', async () => {
    const params: NanoBananaVideoParams = {
      action: 'text-to-video',
      prompt: 'A vertical phone video of rain',
      aspectRatio: '9:16',
      outputPath: '/tmp/vertical.mp4',
    };

    await nanobananaVideo(params, '/tmp');

    expect(fetchCalls).toHaveLength(1);
    const { body } = fetchCalls[0];
    expect(body.generationConfig.videoConfig.aspectRatio).toBe('9:16');
  });

  it('returns error when image-to-video is called without image', async () => {
    const params: NanoBananaVideoParams = {
      action: 'image-to-video',
      prompt: 'Animate this',
      outputPath: '/tmp/test.mp4',
    };

    const result = await nanobananaVideo(params, '/tmp');
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('image-to-video');
  });

  it('passes duration to videoConfig.durationSeconds', async () => {
    const params: NanoBananaVideoParams = {
      action: 'text-to-video',
      prompt: 'Quick clip',
      duration: 4,
      outputPath: '/tmp/short.mp4',
    };

    await nanobananaVideo(params, '/tmp');

    expect(fetchCalls).toHaveLength(1);
    const { body } = fetchCalls[0];
    expect(body.generationConfig.videoConfig.durationSeconds).toBe(4);
  });
});
