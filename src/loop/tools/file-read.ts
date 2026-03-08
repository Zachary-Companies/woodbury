import { promises as fs } from 'fs';
import { resolve } from 'path';
import { ToolDefinition, ToolHandler } from '../types.js';

export const fileReadDefinition: ToolDefinition = {
  name: 'file_read',
  description: 'Read the contents of a file. Returns the file content as text.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file (relative to working directory or absolute)'
      },
      encoding: {
        type: 'string',
        description: 'File encoding (default: utf-8)',
        default: 'utf-8'
      }
    },
    required: ['path']
  },
  dangerous: false
};

export const fileReadHandler: ToolHandler = async (params, context) => {
  const { path, encoding = 'utf-8' } = params;
  
  if (!path) {
    throw new Error('path parameter is required');
  }
  
  if (typeof path !== 'string') {
    throw new Error('path must be a string');
  }
  
  const workingDirectory = context?.workingDirectory || process.cwd();
  const fullPath = resolve(workingDirectory, path as string);
  
  // Basic security check - prevent directory traversal outside working directory
  if (!fullPath.startsWith(resolve(workingDirectory))) {
    throw new Error('Access denied: path is outside working directory');
  }
  
  try {
    const content = await fs.readFile(fullPath, encoding as BufferEncoding);
    return content;
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('ENOENT')) {
        throw new Error(`File not found: ${path}`);
      } else if (error.message.includes('EACCES')) {
        throw new Error(`Permission denied: ${path}`);
      } else {
        throw new Error(`Failed to read file: ${error.message}`);
      }
    }
    throw new Error(`Failed to read file: ${String(error)}`);
  }
};
