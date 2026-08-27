import { promises as fs } from 'fs';
import { resolve, dirname } from 'path';
import { ToolDefinition, ToolHandler } from '../types.js';

export const fileWriteDefinition: ToolDefinition = {
  name: 'file_write',
  description: 'Write content to a file. Creates the file if it does not exist, or overwrites if it does.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file (relative to working directory or absolute)',
        required: true
      },
      content: {
        type: 'string',
        description: 'Content to write to the file',
        required: true
      },
      createDirectories: {
        type: 'boolean',
        description: 'Create parent directories if they do not exist (default: true)',
        required: false,
        default: true
      }
    },
    required: ['path', 'content']
  },
  dangerous: true
};

export const fileWriteHandler: ToolHandler = async (params, context) => {
  const { path, content, createDirectories = true } = params;
  
  if (!path) {
    throw new Error('path parameter is required');
  }
  
  if (content === undefined || content === null) {
    throw new Error('content parameter is required');
  }
  
  if (typeof path !== 'string') {
    throw new Error('path must be a string');
  }
  
  if (typeof content !== 'string') {
    throw new Error('content must be a string');
  }
  
  const workingDirectory = context?.workingDirectory || process.cwd();
  const fullPath = resolve(workingDirectory, path as string);
  
  // Basic security check - prevent directory traversal outside working directory
  if (!fullPath.startsWith(resolve(workingDirectory))) {
    throw new Error('Access denied: path is outside working directory');
  }
  
  try {
    if (createDirectories) {
      const dir = dirname(fullPath);
      await fs.mkdir(dir, { recursive: true });
    }
    
    await fs.writeFile(fullPath, content as string, 'utf-8');
    return `Successfully wrote ${(content as string).length} characters to ${path}`;
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('EACCES')) {
        throw new Error(`Permission denied: ${path}`);
      } else if (error.message.includes('ENOTDIR')) {
        throw new Error(`Invalid path: ${path}`);
      } else {
        throw new Error(`Failed to write file: ${error.message}`);
      }
    }
    throw new Error(`Failed to write file: ${String(error)}`);
  }
};
