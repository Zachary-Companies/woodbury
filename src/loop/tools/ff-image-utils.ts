import { resolve } from 'path';
import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const ffImageUtilsDefinition: ToolDefinition = {
  name: 'image_utils',
  description: 'Image utility operations: convert image files to base64 data URLs (for passing to vision_analyze), crop regions from images, or get image dimensions. Useful as a preprocessing step before vision analysis.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'The action to perform: "to_data_url" converts an image file to base64, "crop" extracts a region and returns base64, "size" returns image dimensions',
        enum: ['to_data_url', 'crop', 'size']
      },
      path: {
        type: 'string',
        description: 'Path to the image file (relative to working directory or absolute)'
      },
      bbox: {
        type: 'array',
        description: 'Only for action="crop": Normalized bounding box [x1, y1, x2, y2] where values are 0-1 fractions of image dimensions',
        items: { type: 'number' }
      }
    },
    required: ['action', 'path']
  }
};

export const ffImageUtilsHandler: ToolHandler = async (params: any, context?: ToolContext) => {
  const action = params.action as string;
  const imagePath = params.path as string;

  if (!action) {
    throw new Error('action parameter is required');
  }
  if (!imagePath) {
    throw new Error('path parameter is required');
  }

  const workingDirectory = context?.workingDirectory || process.cwd();
  const fullPath = resolve(workingDirectory, imagePath);

  // Security check
  if (!fullPath.startsWith(resolve(workingDirectory))) {
    throw new Error('Access denied: path is outside working directory');
  }

  let imageModule: any;
  try {
    imageModule = await import('flow-frame-core/dist/services/self-learning/image.js');
  } catch (err: any) {
    throw new Error(`Failed to load image utilities module: ${err.message}`);
  }

  try {
    if (action === 'to_data_url') {
      const fileToDataUrl = imageModule.fileToDataUrl;
      if (!fileToDataUrl) {
        throw new Error('fileToDataUrl not available in the loaded module');
      }
      const dataUrl = fileToDataUrl(fullPath);

      const base64Part = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
      const sizeKB = Math.round(base64Part.length * 0.75 / 1024);

      const lines: string[] = [];
      lines.push('# Image Converted to Data URL');
      lines.push('');
      lines.push(`- Source: ${imagePath}`);
      lines.push(`- Approximate size: ${sizeKB} KB`);
      lines.push('');
      lines.push('## Data URL');
      lines.push(dataUrl);
      return lines.join('\n');

    } else if (action === 'crop') {
      if (!params.bbox || !Array.isArray(params.bbox) || params.bbox.length !== 4) {
        throw new Error('bbox parameter is required for crop action: [x1, y1, x2, y2] with normalized 0-1 values');
      }
      const cropToDataUrl = imageModule.cropToDataUrl;
      if (!cropToDataUrl) {
        throw new Error('cropToDataUrl not available in the loaded module');
      }
      const dataUrl = await cropToDataUrl({
        imagePath: fullPath,
        bbox: params.bbox
      });

      const base64Part = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
      const sizeKB = Math.round(base64Part.length * 0.75 / 1024);

      const lines: string[] = [];
      lines.push('# Image Cropped');
      lines.push('');
      lines.push(`- Source: ${imagePath}`);
      lines.push(`- Bounding box: [${params.bbox.join(', ')}]`);
      lines.push(`- Approximate size: ${sizeKB} KB`);
      lines.push('');
      lines.push('## Data URL');
      lines.push(dataUrl);
      return lines.join('\n');

    } else if (action === 'size') {
      const getImageSize = imageModule.getImageSize;
      if (!getImageSize) {
        throw new Error('getImageSize not available in the loaded module');
      }
      const size = await getImageSize(fullPath);

      const lines: string[] = [];
      lines.push('# Image Size');
      lines.push('');
      lines.push(`- File: ${imagePath}`);
      lines.push(`- Width: ${size.width} px`);
      lines.push(`- Height: ${size.height} px`);
      return lines.join('\n');

    } else {
      throw new Error(`Unknown action: "${action}". Valid actions: to_data_url, crop, size`);
    }
  } catch (err: any) {
    if (err.message.startsWith('Unknown action')) throw err;
    throw new Error(`Image utility operation failed: ${err.message}`);
  }
};
