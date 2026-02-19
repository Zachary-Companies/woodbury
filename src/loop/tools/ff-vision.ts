import { resolve } from 'path';
import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';
import { getLastScreenshot, setLastScreenshot } from './ff-screenshot.js';

export const ffVisionDefinition: ToolDefinition = {
  name: 'vision_analyze',
  description: 'SEE THE SCREEN: This is your primary tool for looking at the screen. It captures a screenshot and sends it to a vision AI model that describes what is visible. Use this tool whenever you need to see what is on screen — it handles screenshot capture automatically. Ask questions like "What is on screen?", "Where is the Create button? Give x,y pixel coordinates.", "What text is visible?". You can also pass an existing image file path instead of capturing the screen.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'What to look for or ask about the screen. Be specific. For clicking, ask for pixel coordinates: "Where is the Create button? Give approximate x,y pixel coordinates." For general awareness: "Describe what is on screen." For verification: "Did the login form appear?"'
      },
      image: {
        type: 'string',
        description: 'Optional: file path to an existing image to analyze instead of capturing a live screenshot. Usually omit this to auto-capture the screen.'
      },
      mode: {
        type: 'string',
        description: 'Analysis mode: "prompt" for general Q&A (default), "classify" for structured answer+confidence+reason, "find" to locate one image inside another',
        enum: ['prompt', 'classify', 'find'],
        default: 'prompt'
      },
      findImage: {
        type: 'string',
        description: 'Only for mode="find": the second image (base64 data URL or file path) to search for within the primary image'
      },
      model: {
        type: 'string',
        description: 'Vision model to use. Default: "gpt-4o". Alternatives: "llama-3.2-90b-vision-preview" (Groq)'
      },
      captureRegion: {
        type: 'object',
        description: 'If no image is provided, capture only this region of the screen: {x, y, width, height}. Omit for full screen.',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' }
        }
      }
    },
    required: ['prompt']
  }
};

export const ffVisionHandler: ToolHandler = async (params: any, context?: ToolContext) => {
  const prompt = params.prompt as string;
  if (!prompt) {
    throw new Error('prompt parameter is required');
  }

  // Bridge standard env var names to flow-frame-core's expected names
  // flow-frame-core uses OPEN_AI_KEY (not OPENAI_API_KEY) and GROK_API_KEY (not GROQ_API_KEY)
  if (process.env.OPENAI_API_KEY && !process.env.OPEN_AI_KEY) {
    process.env.OPEN_AI_KEY = process.env.OPENAI_API_KEY;
  }
  if (process.env.GROQ_API_KEY && !process.env.GROK_API_KEY) {
    process.env.GROK_API_KEY = process.env.GROQ_API_KEY;
  }

  const workingDirectory = context?.workingDirectory || process.cwd();
  const model = params.model || 'gpt-4o';
  const mode = params.mode || 'prompt';

  // Step 1: Resolve image to a base64 data URL
  let imageDataUrl: string;

  if (params.image) {
    if (params.image.startsWith('data:')) {
      // Already a data URL
      imageDataUrl = params.image;
    } else {
      // File path — convert to data URL
      let fileToDataUrl: any;
      try {
        const imgMod = await import('flow-frame-core/dist/services/self-learning/image.js');
        fileToDataUrl = imgMod.fileToDataUrl;
      } catch (err: any) {
        throw new Error(`Failed to load image utility module: ${err.message}`);
      }
      const fullPath = resolve(workingDirectory, params.image);
      try {
        imageDataUrl = fileToDataUrl(fullPath);
      } catch (err: any) {
        throw new Error(`Failed to read image file "${fullPath}": ${err.message}`);
      }
    }
  } else {
    // No image provided — check if we have a recent cached screenshot first
    const cached = getLastScreenshot();
    if (cached && !params.captureRegion) {
      imageDataUrl = cached.dataUrl;
    } else {
      // Capture a live screenshot
      let captureScreenshotBase64: any;
      try {
        const capMod = await import('flow-frame-core/dist/inference/capturescreenshot.js');
        captureScreenshotBase64 = capMod.captureScreenshotBase64;
      } catch (err: any) {
        throw new Error(`Failed to load screenshot module. Make sure robotjs and sharp are installed: ${err.message}`);
      }
      try {
        imageDataUrl = await captureScreenshotBase64(params.captureRegion || undefined);
        // Cache for potential reuse
        setLastScreenshot(imageDataUrl);
      } catch (err: any) {
        throw new Error(`Screenshot capture failed: ${err.message}`);
      }
    }
  }

  // Step 2: Run the appropriate vision analysis
  let runPromptMod: any;
  try {
    runPromptMod = await import('flow-frame-core/dist/services/runPrompt.js');
  } catch (err: any) {
    throw new Error(`Failed to load vision/prompt module: ${err.message}`);
  }

  try {
    if (mode === 'classify') {
      // Structured classification: returns {answer, confidence, reason}
      const classifyImageQuery = runPromptMod.classifyImageQuery;
      if (!classifyImageQuery) {
        throw new Error('classifyImageQuery not available in the loaded module');
      }
      const result = await classifyImageQuery(model, prompt, { url: imageDataUrl });

      const lines: string[] = [];
      lines.push('# Vision Classification Result');
      lines.push('');
      lines.push(`**Question:** ${prompt}`);
      lines.push(`**Model:** ${model}`);
      lines.push('');
      if (result && typeof result === 'object') {
        lines.push(`**Answer:** ${result.answer || 'N/A'}`);
        lines.push(`**Confidence:** ${result.confidence || 'N/A'}`);
        lines.push(`**Reason:** ${result.reason || 'N/A'}`);
      } else {
        lines.push(`**Result:** ${JSON.stringify(result, null, 2)}`);
      }
      return lines.join('\n');

    } else if (mode === 'find') {
      // Find image within image
      if (!params.findImage) {
        throw new Error('findImage parameter is required when mode is "find"');
      }

      let findImageDataUrl: string;
      if (params.findImage.startsWith('data:')) {
        findImageDataUrl = params.findImage;
      } else {
        let fileToDataUrl: any;
        try {
          const imgMod = await import('flow-frame-core/dist/services/self-learning/image.js');
          fileToDataUrl = imgMod.fileToDataUrl;
        } catch (err: any) {
          throw new Error(`Failed to load image utility module: ${err.message}`);
        }
        const fullPath = resolve(workingDirectory, params.findImage);
        findImageDataUrl = fileToDataUrl(fullPath);
      }

      const findImageInImageQuery = runPromptMod.findImageInImageQuery;
      if (!findImageInImageQuery) {
        throw new Error('findImageInImageQuery not available in the loaded module');
      }
      const result = await findImageInImageQuery(
        model,
        { url: imageDataUrl },
        { url: findImageDataUrl }
      );

      const lines: string[] = [];
      lines.push('# Find Image Result');
      lines.push('');
      lines.push(`**Model:** ${model}`);
      lines.push('');
      if (result && typeof result === 'object') {
        lines.push(`**Found:** ${result.found || false}`);
        lines.push(`**Confidence:** ${result.confidence || 'N/A'}`);
        if (result.box) {
          lines.push(`**Location (box):** ${JSON.stringify(result.box)}`);
        }
        lines.push(`**Reason:** ${result.reason || 'N/A'}`);
      } else {
        lines.push(`**Result:** ${JSON.stringify(result, null, 2)}`);
      }
      return lines.join('\n');

    } else {
      // General prompt mode — free-form question about the image
      const runImagePromptGrok = runPromptMod.runImagePromptGrok;
      const runPrompt = runPromptMod.runPrompt;

      let response: string;

      // Try the Grok-specific path for Groq models, otherwise use general runPrompt
      if (model.includes('llama') || model.includes('groq') || model.includes('mixtral')) {
        if (!runImagePromptGrok) {
          throw new Error('runImagePromptGrok not available in the loaded module');
        }
        response = await runImagePromptGrok(prompt, imageDataUrl, model);
      } else {
        // Use the general runPrompt with images array (works with OpenAI)
        if (!runPrompt) {
          throw new Error('runPrompt not available in the loaded module');
        }
        const messages = [{ role: 'user', content: prompt }];
        response = await runPrompt(messages, model, [imageDataUrl], false, 60000);
      }

      const lines: string[] = [];
      lines.push('# Vision Analysis Result');
      lines.push('');
      lines.push(`**Prompt:** ${prompt}`);
      lines.push(`**Model:** ${model}`);
      lines.push('');
      lines.push('## Response');
      lines.push('');
      if (typeof response === 'string') {
        if (response.length > 50000) {
          lines.push(response.substring(0, 50000) + '\n[Response truncated at 50k chars...]');
        } else {
          lines.push(response);
        }
      } else {
        lines.push(JSON.stringify(response, null, 2));
      }

      let output = lines.join('\n');
      if (output.length > 100000) {
        output = output.substring(0, 100000) + '\n\n[Output truncated at 100k chars...]';
      }
      return output;
    }
  } catch (err: any) {
    throw new Error(`Vision analysis failed: ${err.message}`);
  }
};
