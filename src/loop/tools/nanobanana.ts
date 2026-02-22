/**
 * Nano Banana - Google Gemini Image Generation Tool
 * 
 * Generate and edit images using Google's Gemini image models.
 * Requires GEMINI_API_KEY environment variable or extension config.
 */

import { z } from 'zod';
import { ToolDefinition } from './index.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const MODELS = {
  flash: 'gemini-2.0-flash-exp-image-generation',
  pro: 'gemini-2.5-flash-image',
} as const;

const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] as const;
const IMAGE_SIZES = ['1K', '2K', '4K'] as const;

export const nanobananaSchema = z.object({
  action: z.enum(['generate', 'edit']).describe(
    'Action: "generate" creates an image from text prompt, "edit" modifies an existing image'
  ),
  prompt: z.string().describe(
    'Text prompt describing the image to generate or the edit to make. Be descriptive - use paragraph-style descriptions rather than keyword lists.'
  ),
  image: z.string().optional().describe(
    'For action="edit": Path to the image file to edit, or base64 data URL. Required for editing.'
  ),
  model: z.enum(['flash', 'pro']).optional().default('flash').describe(
    'Model to use: "flash" (gemini-2.0-flash-exp, fast/cheap ~$0.04/image) or "pro" (gemini-2.5-flash, higher quality ~$0.13-0.24/image). Default: flash'
  ),
  aspectRatio: z.enum(ASPECT_RATIOS).optional().default('1:1').describe(
    'Aspect ratio for generated image. Options: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9. Default: 1:1'
  ),
  imageSize: z.enum(IMAGE_SIZES).optional().describe(
    'Image size (Pro model only): "1K" (~1024px), "2K" (~2048px), "4K" (~4096px). Default: 1K'
  ),
  outputPath: z.string().optional().describe(
    'Path to save the generated image. If not provided, saves to working directory with auto-generated name.'
  ),
});

export type NanoBananaParams = z.infer<typeof nanobananaSchema>;

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

  // Read file from disk
  const absolutePath = path.isAbsolute(imagePath) ? imagePath : path.resolve(process.cwd(), imagePath);
  
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Image file not found: ${absolutePath}`);
  }

  const buffer = fs.readFileSync(absolutePath);
  const base64 = buffer.toString('base64');
  
  // Determine MIME type from extension
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

// Response types from Gemini API
interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: {
    data: string;
    mimeType?: string;
  };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[];
    };
  }>;
}

export async function nanobanana(
  params: NanoBananaParams,
  workingDirectory: string
): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return JSON.stringify({
      success: false,
      error: 'GEMINI_API_KEY not found. Set it in environment or in ~/.woodbury/extensions/woodbury-ext-nanobanana/.env. Get an API key at https://aistudio.google.com/app/apikey',
    });
  }

  const { action, prompt, image, model = 'flash', aspectRatio = '1:1', imageSize, outputPath } = params;

  // Validate edit action has image
  if (action === 'edit' && !image) {
    return JSON.stringify({
      success: false,
      error: 'Image path or data URL required for edit action',
    });
  }

  // Build the request
  const modelId = MODELS[model];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;

  // Build parts array
  const parts: Array<{ text: string } | { inline_data: { mime_type: string; data: string } }> = [];
  
  parts.push({ text: prompt });

  // Add image for edit action
  if (action === 'edit' && image) {
    try {
      const imageContent = await loadImageAsBase64(image);
      parts.push({
        inline_data: {
          mime_type: imageContent.mimeType,
          data: imageContent.data,
        },
      });
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: `Failed to load image: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Build generation config
  const generationConfig: Record<string, unknown> = {
    responseModalities: ['TEXT', 'IMAGE'],
  };

  const requestBody = {
    contents: [{ parts }],
    generationConfig,
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

    const responseData = (await response.json()) as GeminiResponse;

    // Extract response parts
    const candidate = responseData.candidates?.[0];
    if (!candidate?.content?.parts) {
      return JSON.stringify({
        success: false,
        error: 'No content in API response',
        rawResponse: responseData,
      });
    }

    let textResponse = '';
    let imageData: string | null = null;
    let imageMimeType = 'image/png';
    let thoughtProcess = '';

    for (const part of candidate.content.parts) {
      if (part.text) {
        if (part.thought) {
          thoughtProcess += part.text + '\n';
        } else {
          textResponse += part.text + '\n';
        }
      } else if (part.inlineData) {
        imageData = part.inlineData.data;
        imageMimeType = part.inlineData.mimeType || 'image/png';
      }
    }

    // Save image if generated
    let savedPath = '';
    if (imageData) {
      // Determine output path
      const ext = imageMimeType === 'image/jpeg' ? '.jpg' : '.png';
      const defaultOutputDir = getOutputDir();
      let filename: string;
      
      if (outputPath) {
        filename = outputPath;
      } else if (defaultOutputDir) {
        filename = path.join(defaultOutputDir, `nanobanana_${Date.now()}${ext}`);
      } else {
        filename = `nanobanana_${Date.now()}${ext}`;
      }
      
      const fullPath = path.isAbsolute(filename) 
        ? filename 
        : path.resolve(workingDirectory, filename);

      // Ensure directory exists
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Write image
      const buffer = Buffer.from(imageData, 'base64');
      fs.writeFileSync(fullPath, buffer);
      savedPath = fullPath;
    }

    return JSON.stringify({
      success: true,
      action,
      model: modelId,
      prompt,
      aspectRatio,
      imageSize: model === 'pro' ? (imageSize || '1K') : undefined,
      imagePath: savedPath || undefined,
      textResponse: textResponse.trim() || undefined,
      thoughtProcess: thoughtProcess.trim() || undefined,
    });

  } catch (err) {
    return JSON.stringify({
      success: false,
      error: `Request failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

export const nanobananaTool: ToolDefinition = {
  name: 'nanobanana',
  description: `Generate or edit images using Google's Gemini image models (Nano Banana). Supports text-to-image generation and image editing with natural language.

**Models:**
- "flash" (default): Fast and cheap (~$0.04/image), good for most tasks
- "pro": Higher quality, 4K support, complex prompts (~$0.13-0.24/image)

**Actions:**
- "generate": Create an image from a text description
- "edit": Modify an existing image with a text prompt

**Prompting tips:**
- Write paragraph-style descriptions, not keyword lists
- Include style terms: "photorealistic", "3D render", "watercolor", etc.
- Specify camera details for photos: "85mm lens", "golden hour lighting"
- For text in images, be explicit: "with the text 'Hello World' in bold sans-serif"

Requires GEMINI_API_KEY environment variable.`,
  parameters: nanobananaSchema,
  execute: async (params, context) => {
    return nanobanana(params as NanoBananaParams, context?.workingDirectory || process.cwd());
  },
  dangerous: true,
};
