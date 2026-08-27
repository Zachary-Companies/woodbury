/**
 * Tests for nanobanana-video (Veo 3.1) video generation tool
 *
 * Verifies API request structure, image loading, video saving,
 * long-running operation polling, error handling, and parameter passing.
 *
 * NOTE ON API SHAPE: Veo uses the `:predictLongRunning` endpoint with
 * `{instances, parameters}` — NOT `generateContent` with `{contents,
 * generationConfig}`. An earlier revision of this file asserted the
 * generateContent shape and only compiled because a type error masked it.
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

const VIDEO_URI = 'https://generativelanguage.googleapis.com/v1beta/files/vid123:download';
const VIDEO_BYTES = 'fakevideodata';

/** The operation Veo returns from :predictLongRunning before it has finished. */
function makePendingOperation(operationName = 'operations/abc123') {
  return {
    ok: true,
    status: 200,
    json: async () => ({ name: operationName, done: false }),
    text: async () => '',
  };
}

/** A finished operation carrying the generated sample's video URI. */
function makeCompletedOperation(uri = VIDEO_URI) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      name: 'operations/abc123',
      done: true,
      response: {
        generateVideoResponse: {
          generatedSamples: [{ video: { uri } }],
        },
      },
    }),
    text: async () => '',
  };
}

/** The binary download of the finished video. */
function makeVideoDownload(bytes = VIDEO_BYTES) {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => {
      const buf = Buffer.from(bytes);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
    json: async () => ({}),
    text: async () => '',
  };
}

/** True for the generate request (POST with a body), false for polls/downloads. */
function isGenerateRequest(url: string, options?: RequestInit): boolean {
  return url.includes(':predictLongRunning') && !!options?.body;
}

describe('nanobanana-video', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    fetchCalls = [];
    mockFetch.mockReset();
    mockFs.writeFileSync.mockReset();
    mockFs.mkdirSync.mockReset();
    process.env = { ...originalEnv, GEMINI_API_KEY: 'test-api-key' };

    // Default happy path: generate → operation completes on first poll → download.
    mockFetch.mockImplementation(async (url: string, options: RequestInit) => {
      if (isGenerateRequest(url, options)) {
        fetchCalls.push({ url, options, body: JSON.parse(options.body as string) });
        return makePendingOperation();
      }
      if (url.includes('operations/')) {
        return makeCompletedOperation();
      }
      return makeVideoDownload();
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env = originalEnv;
  });

  /** Drive the tool to completion, advancing the 5s poll timers as they are set. */
  async function run(params: NanoBananaVideoParams, cwd = '/tmp'): Promise<any> {
    const promise = nanobananaVideo(params, cwd);
    // Let each awaited microtask settle, advancing any pending poll delay.
    for (let i = 0; i < 200; i++) {
      await Promise.resolve();
      if (jest.getTimerCount() > 0) jest.advanceTimersByTime(5000);
    }
    return JSON.parse(await promise);
  }

  it('text-to-video posts to predictLongRunning with instances and parameters', async () => {
    const parsed = await run({
      action: 'text-to-video',
      prompt: 'A sunset over the ocean with gentle waves',
      duration: 6,
      aspectRatio: '16:9',
      model: 'veo-3.1',
      outputPath: '/tmp/test-video.mp4',
    });

    expect(parsed.success).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    const { url, body, options } = fetchCalls[0];

    // Veo model + long-running endpoint (NOT generateContent)
    expect(url).toContain('veo-3.1-generate-preview');
    expect(url).toContain(':predictLongRunning');
    expect(url).not.toContain('generateContent');

    // API key travels in the header, not the query string
    expect((options.headers as Record<string, string>)['x-goog-api-key']).toBe('test-api-key');

    // instances/parameters shape
    expect(body.instances).toHaveLength(1);
    expect(body.instances[0].prompt).toBe('A sunset over the ocean with gentle waves');
    expect(body.instances[0].image).toBeUndefined();
    expect(body.parameters).toEqual({ aspectRatio: '16:9', durationSeconds: 6 });
  });

  it('image-to-video attaches the source image to the instance', async () => {
    mockFs.readFileSync.mockReturnValue(Buffer.from('imagebytes'));

    const parsed = await run({
      action: 'image-to-video',
      prompt: 'Slowly zoom into the scene',
      image: '/tmp/source.png',
      outputPath: '/tmp/out.mp4',
    });

    expect(parsed.success).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    const { body } = fetchCalls[0];

    expect(body.instances[0].prompt).toBe('Slowly zoom into the scene');
    expect(body.instances[0].image).toBeDefined();
    expect(body.instances[0].image.mimeType).toBe('image/png');
    expect(typeof body.instances[0].image.bytesBase64Encoded).toBe('string');
  });

  it('saves the downloaded video bytes to outputPath', async () => {
    const parsed = await run({
      action: 'text-to-video',
      prompt: 'A flying bird',
      outputPath: '/tmp/output/my-video.mp4',
    });

    expect(parsed.success).toBe(true);
    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
    const [writePath, writeBuffer] = mockFs.writeFileSync.mock.calls[0];
    expect(writePath).toBe('/tmp/output/my-video.mp4');
    expect(Buffer.isBuffer(writeBuffer)).toBe(true);
    expect((writeBuffer as Buffer).toString()).toBe(VIDEO_BYTES);
  });

  it('returns success with filePath', async () => {
    const parsed = await run({
      action: 'text-to-video',
      prompt: 'A running horse',
      outputPath: '/tmp/horse.mp4',
    });

    expect(parsed.success).toBe(true);
    expect(parsed.filePath).toBe('/tmp/horse.mp4');
    expect(parsed.action).toBe('text-to-video');
  });

  it('polls the operation until it reports done', async () => {
    let pollCount = 0;
    mockFetch.mockImplementation(async (url: string, options: RequestInit) => {
      if (isGenerateRequest(url, options)) {
        fetchCalls.push({ url, options, body: JSON.parse(options.body as string) });
        return makePendingOperation();
      }
      if (url.includes('operations/')) {
        pollCount += 1;
        // Stay pending for the first two polls, then complete.
        return pollCount < 3 ? makePendingOperation() : makeCompletedOperation();
      }
      return makeVideoDownload();
    });

    const parsed = await run({
      action: 'text-to-video',
      prompt: 'A long render',
      outputPath: '/tmp/long.mp4',
    });

    expect(parsed.success).toBe(true);
    expect(pollCount).toBe(3);
    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('fails when the finished operation carries no video', async () => {
    mockFetch.mockImplementation(async (url: string, options: RequestInit) => {
      if (isGenerateRequest(url, options)) {
        fetchCalls.push({ url, options, body: JSON.parse(options.body as string) });
        return makePendingOperation();
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ name: 'operations/abc123', done: true, response: {} }),
        text: async () => '',
      };
    });

    const parsed = await run({
      action: 'text-to-video',
      prompt: 'Nothing comes back',
      outputPath: '/tmp/none.mp4',
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('No video data');
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('surfaces an operation-level failure', async () => {
    mockFetch.mockImplementation(async (url: string, options: RequestInit) => {
      if (isGenerateRequest(url, options)) {
        fetchCalls.push({ url, options, body: JSON.parse(options.body as string) });
        return makePendingOperation();
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          name: 'operations/abc123',
          done: true,
          error: { message: 'content policy violation' },
        }),
        text: async () => '',
      };
    });

    const parsed = await run({
      action: 'text-to-video',
      prompt: 'Rejected',
      outputPath: '/tmp/rejected.mp4',
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('content policy violation');
  });

  it('handles API error gracefully', async () => {
    mockFetch.mockImplementation(async () => ({
      ok: false,
      status: 400,
      text: async () => 'Bad Request: invalid prompt',
      json: async () => ({}),
    }));

    const parsed = await run({
      action: 'text-to-video',
      prompt: '',
      outputPath: '/tmp/test.mp4',
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('API error');
    expect(parsed.error).toContain('400');
  });

  it('handles missing API key', async () => {
    delete process.env.GEMINI_API_KEY;

    const parsed = await run({
      action: 'text-to-video',
      prompt: 'A test',
      outputPath: '/tmp/test.mp4',
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('GEMINI_API_KEY not found');
  });

  it('returns error when image-to-video is called without image', async () => {
    const parsed = await run({
      action: 'image-to-video',
      prompt: 'Animate this',
      outputPath: '/tmp/test.mp4',
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('image-to-video');
  });

  it('passes aspect ratio through to parameters', async () => {
    await run({
      action: 'text-to-video',
      prompt: 'Portrait clip',
      aspectRatio: '9:16',
      outputPath: '/tmp/portrait.mp4',
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.parameters.aspectRatio).toBe('9:16');
  });

  it('passes duration through to parameters.durationSeconds', async () => {
    await run({
      action: 'text-to-video',
      prompt: 'Quick clip',
      duration: 4,
      outputPath: '/tmp/short.mp4',
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.parameters.durationSeconds).toBe(4);
  });

  it('defaults duration and aspect ratio when omitted', async () => {
    await run({
      action: 'text-to-video',
      prompt: 'Defaults please',
      outputPath: '/tmp/defaults.mp4',
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.parameters).toEqual({ aspectRatio: '16:9', durationSeconds: 6 });
  });
});
