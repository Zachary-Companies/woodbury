import { promises as fs } from 'fs';
import { resolve } from 'path';
import { ToolDefinition, ToolHandler } from '../types.js';

export const fileExistsDefinition: ToolDefinition = {
  name: 'file_exists',
  description: 'Check whether a file or directory exists at the given path. Returns { exists: boolean, isFile: boolean, isDirectory: boolean, size: number }.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to check (relative to working directory or absolute)'
      }
    },
    required: ['path']
  },
  dangerous: false
};

export const fileExistsHandler: ToolHandler = async (params, context) => {
  const { path } = params;

  if (!path || typeof path !== 'string') {
    throw new Error('path parameter is required and must be a string');
  }

  const workingDirectory = context?.workingDirectory || process.cwd();
  const fullPath = resolve(workingDirectory, path as string);

  try {
    const stat = await fs.stat(fullPath);
    return JSON.stringify({
      exists: true,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      size: stat.size,
    });
  } catch {
    return JSON.stringify({
      exists: false,
      isFile: false,
      isDirectory: false,
      size: 0,
    });
  }
};
