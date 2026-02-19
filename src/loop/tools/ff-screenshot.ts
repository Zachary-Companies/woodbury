import { resolve, join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

/**
 * Shared screenshot cache — holds the most recent base64 screenshot so that
 * vision_analyze can reuse it without recapturing. This avoids the agent
 * having to pass megabytes of base64 text through tool call parameters.
 */
let _lastScreenshotDataUrl: string | null = null;
let _lastScreenshotTimestamp: number = 0;

export function getLastScreenshot(): { dataUrl: string; timestamp: number } | null {
  if (_lastScreenshotDataUrl && Date.now() - _lastScreenshotTimestamp < 30000) {
    return { dataUrl: _lastScreenshotDataUrl, timestamp: _lastScreenshotTimestamp };
  }
  return null;
}

export function setLastScreenshot(dataUrl: string): void {
  _lastScreenshotDataUrl = dataUrl;
  _lastScreenshotTimestamp = Date.now();
}

export const ffScreenshotDefinition: ToolDefinition = {
  name: 'screenshot',
  description: 'Save a screenshot of the current screen to a PNG file. NOTE: This tool only saves images to disk — you CANNOT see the image contents from the result. To actually SEE what is on screen, use vision_analyze instead (it auto-captures and analyzes the screen). Use this tool only when you need to save a screenshot file for archival or reference.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      outputDir: {
        type: 'string',
        description: 'Directory to save the screenshot file. Defaults to working directory.'
      },
      filename: {
        type: 'string',
        description: 'Filename for the saved screenshot. Defaults to auto-generated UUID name.'
      },
      region: {
        type: 'object',
        description: 'Optional region to capture: {x: number, y: number, width: number, height: number}. If omitted, captures the full screen.',
        properties: {
          x: { type: 'number', description: 'X coordinate of top-left corner' },
          y: { type: 'number', description: 'Y coordinate of top-left corner' },
          width: { type: 'number', description: 'Width of the region in pixels' },
          height: { type: 'number', description: 'Height of the region in pixels' }
        }
      }
    },
    required: []
  }
};

export const ffScreenshotHandler: ToolHandler = async (params: any, context?: ToolContext) => {
  const workingDirectory = context?.workingDirectory || process.cwd();

  let captureScreenshotBase64: any;
  let captureScreenshot: any;
  let captureFullScreenshot: any;
  try {
    const mod = await import('flow-frame-core/dist/inference/capturescreenshot.js');
    captureScreenshotBase64 = mod.captureScreenshotBase64;
    captureScreenshot = mod.captureScreenshot;
    captureFullScreenshot = mod.captureFullScreenshot;
  } catch (err: any) {
    throw new Error(`Failed to load screenshot module. Make sure robotjs and sharp are installed: ${err.message}`);
  }

  try {
    // Always save to file
    const outputDir = params.outputDir
      ? resolve(workingDirectory, params.outputDir)
      : workingDirectory;

    // Ensure output directory exists
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    let filepath: string;
    if (params.filename) {
      filepath = await captureScreenshot(outputDir, params.filename, params.region || undefined);
    } else {
      filepath = await captureFullScreenshot(outputDir);
    }

    // Also capture base64 and cache it for vision_analyze to use
    try {
      const dataUrl = await captureScreenshotBase64(params.region || undefined);
      setLastScreenshot(dataUrl);
    } catch {
      // Non-critical — vision_analyze will capture its own if needed
    }

    const lines: string[] = [];
    lines.push('# Screenshot Saved');
    lines.push('');
    lines.push(`- File: ${filepath}`);
    lines.push(`- Directory: ${outputDir}`);
    if (params.region) {
      lines.push(`- Region: x=${params.region.x}, y=${params.region.y}, ${params.region.width}x${params.region.height}`);
    } else {
      lines.push('- Captured: Full screen');
    }
    lines.push('');
    lines.push('**To see what is on screen, use `vision_analyze` — it will capture and analyze the screen contents for you.**');
    return lines.join('\n');
  } catch (err: any) {
    throw new Error(`Screenshot capture failed: ${err.message}`);
  }
};
