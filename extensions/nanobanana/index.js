/**
 * Woodbury Nano Banana Extension
 *
 * Provides tools to generate and edit images using Google's Gemini image models.
 * Requires GEMINI_API_KEY in the extension's .env file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const MODELS = {
  flash: 'gemini-2.5-flash-image',
  pro: 'gemini-3-pro-image-preview',
};

const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const IMAGE_SIZES = ['1K', '2K', '4K'];

/**
 * Load image as base64 from file path, URL, or data URL
 */
async function loadImageAsBase64(imagePath, workingDirectory) {
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

  // Resolve file path
  const absolutePath = path.isAbsolute(imagePath)
    ? imagePath
    : path.resolve(workingDirectory, imagePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Image file not found: ${absolutePath}`);
  }

  const buffer = fs.readFileSync(absolutePath);
  const base64 = buffer.toString('base64');

  // Determine MIME type from extension
  const ext = path.extname(absolutePath).toLowerCase();
  const mimeTypes = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  const mimeType = mimeTypes[ext] || 'image/png';

  return { data: base64, mimeType };
}

/**
 * Generate or edit an image using Gemini API
 */
async function generateImage(params, apiKey, workingDirectory) {
  const {
    action,
    prompt,
    image,
    referenceImages = [],
    model = 'flash',
    aspectRatio = '1:1',
    imageSize,
    outputPath,
  } = params;

  // Validate edit action has image
  if (action === 'edit' && !image) {
    return {
      success: false,
      error: 'Image path or data URL required for edit action',
    };
  }

  // Build the request
  const modelId = MODELS[model];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;

  // Build parts array — images come BEFORE text so the model sees
  // the visual reference first, then applies the text instruction.
  const parts = [];

  // Add primary image first (for any action — enables image-to-image and editing)
  if (image) {
    try {
      const imageContent = await loadImageAsBase64(image, workingDirectory);
      parts.push({
        inline_data: {
          mime_type: imageContent.mimeType,
          data: imageContent.data,
        },
      });
    } catch (err) {
      return {
        success: false,
        error: `Failed to load image: ${err.message}`,
      };
    }
  }

  // Add reference images (for character consistency, style reference, etc.)
  for (const refImg of referenceImages) {
    try {
      const imageContent = await loadImageAsBase64(refImg, workingDirectory);
      parts.push({
        inline_data: {
          mime_type: imageContent.mimeType,
          data: imageContent.data,
        },
      });
    } catch (err) {
      return {
        success: false,
        error: `Failed to load reference image: ${err.message}`,
      };
    }
  }

  // Text prompt comes after images so the model interprets it as
  // an instruction about the preceding image(s)
  parts.push({ text: prompt });

  // Build generation config
  const generationConfig = {
    responseModalities: ['TEXT', 'IMAGE'],
    imageConfig: {
      aspectRatio: aspectRatio,
    },
  };

  // Add image size for Pro model
  if (model === 'pro' && imageSize) {
    generationConfig.imageConfig.imageSize = imageSize;
  }

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
      return {
        success: false,
        error: `API error (${response.status}): ${errorText}`,
      };
    }

    const responseData = await response.json();

    // Extract response parts
    const candidate = responseData.candidates?.[0];
    if (!candidate?.content?.parts) {
      return {
        success: false,
        error: 'No content in API response',
        rawResponse: responseData,
      };
    }

    let textResponse = '';
    let imageData = null;
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
      const ext = imageMimeType === 'image/jpeg' ? '.jpg' : '.png';
      const filename = outputPath || `nanobanana_${Date.now()}${ext}`;
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

    return {
      success: true,
      action,
      model: modelId,
      prompt,
      aspectRatio,
      imageSize: model === 'pro' ? imageSize || '1K' : undefined,
      imagePath: savedPath || undefined,
      textResponse: textResponse.trim() || undefined,
      thoughtProcess: thoughtProcess.trim() || undefined,
    };
  } catch (err) {
    return {
      success: false,
      error: `Request failed: ${err.message}`,
    };
  }
}

/**
 * @param {import('woodbury').ExtensionContext} ctx
 */
export async function activate(ctx) {
  ctx.log.info('Nano Banana extension activated');

  // Get config from extension's env
  const apiKey = ctx.env.GEMINI_API_KEY;
  const imageOutputDir = ctx.env.IMAGE_OUTPUT_DIR || '';

  // Register the nanobanana tool
  ctx.registerTool(
    {
      name: 'nanobanana',
      description: `Generate or edit images using Google's Gemini image models (Nano Banana).

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

Requires GEMINI_API_KEY in the extension's .env file.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['generate', 'edit'],
            description: 'Action: "generate" creates an image from text, "edit" modifies an existing image',
          },
          prompt: {
            type: 'string',
            description: 'Text prompt describing the image to generate or the edit to make',
          },
          image: {
            type: 'string',
            description: 'Path to an image file, a URL, or base64 data URL. For action="edit" this is the image to edit (required). For action="generate" this enables image-to-image generation.',
          },
          referenceImages: {
            type: 'array',
            items: { type: 'string' },
            description: 'Additional reference images (file paths, URLs, or base64 data URLs). Used for character consistency, style reference, or multi-image context.',
          },
          model: {
            type: 'string',
            enum: ['flash', 'pro'],
            description: 'Model: "flash" (fast/cheap) or "pro" (4K, complex). Default: flash',
          },
          aspectRatio: {
            type: 'string',
            enum: ASPECT_RATIOS,
            description: 'Aspect ratio. Default: 1:1',
          },
          imageSize: {
            type: 'string',
            enum: IMAGE_SIZES,
            description: 'Image size (Pro only): 1K, 2K, 4K. Default: 1K',
          },
          outputPath: {
            type: 'string',
            description: 'Where to save the image. Default: IMAGE_OUTPUT_DIR (if configured) or working directory with auto-generated name',
          },
        },
        required: ['action', 'prompt'],
      },
    },
    async (params) => {
      // Check for API key
      const key = apiKey || process.env.GEMINI_API_KEY;
      if (!key) {
        return JSON.stringify({
          success: false,
          error:
            'GEMINI_API_KEY not configured. Add it to ~/.woodbury/extensions/woodbury-ext-nanobanana/.env or set it as an environment variable. Get an API key at https://aistudio.google.com/app/apikey',
        });
      }

      // If no outputPath given and IMAGE_OUTPUT_DIR is configured, use it
      const effectiveParams = { ...params };
      if (!effectiveParams.outputPath && imageOutputDir) {
        const resolvedDir = path.isAbsolute(imageOutputDir)
          ? imageOutputDir
          : path.resolve(ctx.workingDirectory, imageOutputDir);
        effectiveParams.outputPath = path.join(resolvedDir, `nanobanana_${Date.now()}.png`);
      }

      const result = await generateImage(effectiveParams, key, ctx.workingDirectory);
      return JSON.stringify(result);
    }
  );

  // Register a command to check API key status
  ctx.registerCommand({
    name: 'nanobanana-status',
    description: 'Check Nano Banana API key status',
    handler: async (args, cmdCtx) => {
      const key = apiKey || process.env.GEMINI_API_KEY;
      if (key) {
        cmdCtx.print(`✅ GEMINI_API_KEY configured (${key.slice(0, 8)}...)`);
      } else {
        cmdCtx.print('❌ GEMINI_API_KEY not configured');
        cmdCtx.print('   Add to ~/.woodbury/extensions/woodbury-ext-nanobanana/.env');
        cmdCtx.print('   Or set GEMINI_API_KEY environment variable');
        cmdCtx.print('   Get API key at: https://aistudio.google.com/app/apikey');
      }
      if (imageOutputDir) {
        const resolvedDir = path.isAbsolute(imageOutputDir)
          ? imageOutputDir
          : path.resolve(cmdCtx.workingDirectory, imageOutputDir);
        cmdCtx.print(`📁 Image output: ${resolvedDir}`);
      } else {
        cmdCtx.print('📁 Image output: working directory (no IMAGE_OUTPUT_DIR set)');
      }
    },
  });

  // Add system prompt section
  const outputDirNote = imageOutputDir
    ? `Images are saved to: ${imageOutputDir}`
    : 'Images are saved to the working directory by default. Configure IMAGE_OUTPUT_DIR in the dashboard to set a custom folder.';

  ctx.addSystemPrompt(`## Nano Banana Extension (Image Generation)

You have access to the Nano Banana extension for AI image generation.

### Tool: nanobanana
- Generate images from text prompts
- Edit existing images with natural language
- Models: "flash" (fast, ~$0.04) or "pro" (4K, ~$0.13-0.24)
- Aspect ratios: 1:1, 16:9, 9:16, etc.
- ${outputDirNote}

### Command: /nanobanana-status
- Check if GEMINI_API_KEY is configured and see output directory

### Example usage:
\`\`\`
nanobanana({
  action: "generate",
  prompt: "A serene mountain lake at sunset, photorealistic, 85mm lens",
  aspectRatio: "16:9"
})
\`\`\``);
}

export function deactivate() {
  // Cleanup if needed
}
