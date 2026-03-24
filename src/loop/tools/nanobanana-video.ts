/**
 * Nano Banana Video - Google Veo 3.1 Video Generation Tool
 *
 * Generate video clips using Google's Veo 3.1 model.
 * Supports text-to-video and image-to-video generation.
 * Requires GEMINI_API_KEY environment variable or extension config.
 */

import { z } from 'zod';
import { ToolDefinition } from './index.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const nanobananaVideoSchema = z.object({
  action: z.enum(['image-to-video', 'text-to-video']).describe(
    'Action: "text-to-video" generates video from a text prompt, "image-to-video" animates a source image'
  ),
  prompt: z.string().describe(
    'Scene description and camera movement instructions for the video'
  ),
  image: z.string().optional().describe(
    'Source image for image-to-video: file path, URL, or data URL'
  ),
  duration: z.number().optional().default(6).describe(
    'Video duration in seconds (4-8)'
  ),
  aspectRatio: z.enum(['16:9', '9:16']).optional().default('16:9').describe(
    'Aspect ratio for generated video. Default: 16:9'
  ),
  model: z.enum(['veo-3.1']).optional().default('veo-3.1').describe(
    'Model to use. Default: veo-3.1'
  ),
  outputPath: z.string().optional().describe(
    'Where to save the video file. If not provided, saves to working directory with auto-generated name.'
  ),
});

export type NanoBananaVideoParams = z.infer<typeof nanobananaVideoSchema>;

/**
 * Get the Gemini API key from environment or extension config
 */
function getApiKey(): string | undefined {
  // First check process environment
  if (process.env.GEMINI_API_KEY) {
    return process.env.GEMINI_API_KEY;
  }

  // Then check the extension's .env file
  const extensionEnvPaths = [
    path.join(os.homedir(), '.woodbury', 'extensions', 'woodbury-ext-nanobanana', '.env'),
    path.join(os.homedir(), '.woodbury', 'extensions', 'nanobanana', '.env'),
  ];

  for (const envPath of extensionEnvPaths) {
    if (fs.existsSync(envPath)) {
      try {
        const content = fs.readFileSync(envPath, 'utf-8');
        const match = content.match(/^GEMINI_API_KEY=(.+)$/m);
        if (match && match[1]) {
          return match[1].trim();
        }
      } catch {
        // Continue to next path
      }
    }
  }

  return undefined;
}

/**
 * Get the default output directory from extension config
 */
function getOutputDir(): string | undefined {
  const extensionEnvPaths = [
    path.join(os.homedir(), '.woodbury', 'extensions', 'woodbury-ext-nanobanana', '.env'),
    path.join(os.homedir(), '.woodbury', 'extensions', 'nanobanana', '.env'),
  ];

  for (const envPath of extensionEnvPaths) {
    if (fs.existsSync(envPath)) {
      try {
        const content = fs.readFileSync(envPath, 'utf-8');
        const match = content.match(/^IMAGE_OUTPUT_DIR=(.+)$/m);
        if (match && match[1]) {
          return match[1].trim();
        }
      } catch {
        // Continue to next path
      }
    }
  }

  return undefined;
}

async function loadImageAsBase64(imagePath: string): Promise<{ data: string; mimeType: string }> {
  // Check if it's already a data URL
  if (imagePath.startsWith('data:')) {
    const match = imagePath.match(/^data:([^;]+);base64,(.+)$/s);
    if (match) {
      return { mimeType: match[1], data: match[2] };
    }
    throw new Error('Invalid data URL format');
  }

  // Check if it's a URL — fetch and convert to base64
  if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
    const response = await fetch(imagePath);
    if (!response.ok) {
      throw new Error(`Failed to fetch image from URL (${response.status}): ${imagePath}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || 'image/png';
    const mimeType = contentType.split(';')[0].trim();
    return { data: buffer.toString('base64'), mimeType };
  }

  // Read file from disk
  const absolutePath = path.isAbsolute(imagePath) ? imagePath : path.resolve(process.cwd(), imagePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Image file not found: ${absolutePath}`);
  }

  const buffer = fs.readFileSync(absolutePath);
  const base64 = buffer.toString('base64');

  const ext = path.extname(absolutePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  const mimeType = mimeTypes[ext] || 'image/png';

  return { data: base64, mimeType };
}

// Response types
interface VeoVideoPart {
  text?: string;
  inlineData?: {
    data: string;
    mimeType?: string;
  };
}

interface VeoResponse {
  candidates?: Array<{
    content?: {
      parts?: VeoVideoPart[];
    };
  }>;
  // Long-running operation fields
  name?: string;
  done?: boolean;
  error?: { code: number; message: string };
  response?: {
    candidates?: Array<{
      content?: {
        parts?: VeoVideoPart[];
      };
    }>;
  };
}

const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 120; // 10 minutes max

/**
 * Poll a long-running operation until it completes
 */
async function pollOperation(operationName: string, apiKey: string): Promise<VeoResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/${operationName}`;

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-goog-api-key': apiKey,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Poll error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as VeoResponse;

    if (data.done) {
      if (data.error) {
        throw new Error(`Operation failed: ${data.error.message}`);
      }
      return data;
    }
  }

  throw new Error('Operation timed out after maximum poll attempts');
}

/**
 * Extract video data from a Veo API response.
 *
 * Veo predictLongRunning returns:
 * { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "..." } }] } } }
 *
 * The video.uri is a GCS URI that needs to be fetched with the API key.
 */
function extractVideoUri(responseData: VeoResponse): string | null {
  // Primary: Veo predictLongRunning format
  const resp = (responseData as any).response;
  if (resp?.generateVideoResponse?.generatedSamples) {
    const samples = resp.generateVideoResponse.generatedSamples;
    if (samples[0]?.video?.uri) {
      return samples[0].video.uri;
    }
  }

  // Fallback: check for direct video URI in response
  if ((responseData as any).generateVideoResponse?.generatedSamples) {
    const samples = (responseData as any).generateVideoResponse.generatedSamples;
    if (samples[0]?.video?.uri) {
      return samples[0].video.uri;
    }
  }

  return null;
}

/**
 * Download video from a URI (may be a GCS URI served via the API)
 */
async function downloadVideo(uri: string, apiKey: string): Promise<Buffer> {
  // The URI from Veo is typically a generativelanguage.googleapis.com URL
  // that requires the API key as a query parameter
  const separator = uri.includes('?') ? '&' : '?';
  const fetchUrl = uri.startsWith('http') ? `${uri}${separator}key=${apiKey}` : uri;

  const response = await fetch(fetchUrl);
  if (!response.ok) {
    throw new Error(`Failed to download video (${response.status}): ${await response.text().catch(() => 'unknown')}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function nanobananaVideo(
  params: NanoBananaVideoParams,
  workingDirectory: string
): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return JSON.stringify({
      success: false,
      error: 'GEMINI_API_KEY not found. Set it in environment or in ~/.woodbury/extensions/woodbury-ext-nanobanana/.env. Get an API key at https://aistudio.google.com/app/apikey',
    });
  }

  const {
    action,
    prompt,
    image,
    duration = 6,
    aspectRatio = '16:9',
    model = 'veo-3.1',
    outputPath,
  } = params;

  // Validate image-to-video action has image
  if (action === 'image-to-video' && !image) {
    return JSON.stringify({
      success: false,
      error: 'Image path, URL, or data URL required for image-to-video action',
    });
  }

  // Veo uses predictLongRunning endpoint, NOT generateContent
  const modelId = model === 'veo-3.1' ? 'veo-3.1-generate-preview' : 'veo-3.0-generate-preview';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:predictLongRunning`;

  // Build the request body — Veo uses "instances" format, not "contents"
  const instance: Record<string, any> = {
    prompt,
  };

  // Add source image for image-to-video
  if (image) {
    try {
      const imageContent = await loadImageAsBase64(image);
      instance.image = {
        bytesBase64Encoded: imageContent.data,
        mimeType: imageContent.mimeType,
      };
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: `Failed to load image: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Build generation parameters
  const generationConfig: Record<string, unknown> = {
    aspectRatio,
    durationSeconds: duration,
  };

  // Veo predictLongRunning uses "instances" and "parameters" format
  const requestBody = {
    instances: [instance],
    parameters: generationConfig,
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return JSON.stringify({
        success: false,
        error: `API error (${response.status}): ${errorText}`,
      });
    }

    const responseData = (await response.json()) as VeoResponse;

    // Check if this is a long-running operation (Veo always returns one)
    let finalResponse: VeoResponse;

    if (responseData.name && !responseData.done) {
      // Long-running operation — poll until done
      finalResponse = await pollOperation(responseData.name, apiKey);
    } else {
      finalResponse = responseData;
    }

    // Extract video URI from the response
    const videoUri = extractVideoUri(finalResponse);

    if (!videoUri) {
      return JSON.stringify({
        success: false,
        error: 'No video data in API response',
        rawResponse: JSON.stringify(finalResponse).substring(0, 2000),
        responseKeys: Object.keys(finalResponse),
      });
    }

    // Download the video from the URI
    const videoBuffer = await downloadVideo(videoUri, apiKey);

    // Determine output path
    const defaultOutputDir = getOutputDir();
    let filename: string;

    if (outputPath) {
      filename = outputPath;
    } else if (defaultOutputDir) {
      filename = path.join(defaultOutputDir, `nanobanana_video_${Date.now()}.mp4`);
    } else {
      filename = `nanobanana_video_${Date.now()}.mp4`;
    }

    const fullPath = path.isAbsolute(filename)
      ? filename
      : path.resolve(workingDirectory, filename);

    // Ensure directory exists
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write video (already a Buffer from downloadVideo)
    fs.writeFileSync(fullPath, videoBuffer);

    return JSON.stringify({
      success: true,
      action,
      model,
      prompt,
      duration,
      aspectRatio,
      filePath: fullPath,
    });

  } catch (err) {
    return JSON.stringify({
      success: false,
      error: `Request failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

export const nanobananaVideoTool: ToolDefinition = {
  name: 'video_generate',
  description: `Generate video clips using Google's Veo 3.1 model. Supports text-to-video and image-to-video generation.

**Actions:**
- "text-to-video": Generate a video from a text description
- "image-to-video": Animate a source image into a video clip

**Parameters:**
- prompt: Scene description and camera movement instructions
- image: Source image for image-to-video (file path, URL, or data URL)
- duration: Video length in seconds (4-8, default: 6)
- aspectRatio: "16:9" (landscape) or "9:16" (portrait), default: 16:9
- outputPath: Where to save the .mp4 file

**Prompting tips:**
- Describe camera movements: "slow dolly forward", "pan left to right"
- Include scene details: lighting, atmosphere, character actions
- For image-to-video, describe how the scene should animate from the source image

Requires GEMINI_API_KEY environment variable.`,
  parameters: nanobananaVideoSchema,
  execute: async (params, context) => {
    return nanobananaVideo(params as NanoBananaVideoParams, context?.workingDirectory || process.cwd());
  },
  dangerous: true,
};
