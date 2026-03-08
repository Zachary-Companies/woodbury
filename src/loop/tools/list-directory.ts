import { promises as fs, Stats } from 'fs';
import { resolve, join } from 'path';
import { ToolDefinition, ToolHandler } from '../types.js';

export const listDirectoryDefinition: ToolDefinition = {
  name: 'list_directory',
  description: 'List contents of a directory, showing files and subdirectories with their sizes.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory path (relative to working directory or absolute). Default: current directory',
        default: '.'
      },
      recursive: {
        type: 'boolean',
        description: 'Whether to list recursively (default: false)',
        default: false
      }
    },
    required: []
  },
  dangerous: false
};

async function formatSize(size: number): Promise<string> {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / (1024 * 1024)).toFixed(1)}MB`;
}

async function listDirectory(dirPath: string, recursive: boolean = false, prefix: string = ''): Promise<string> {
  try {
    const entries = await fs.readdir(dirPath);
    let output = '';
    
    for (const entry of entries.sort()) {
      const fullPath = join(dirPath, entry);
      const stat = await fs.stat(fullPath);
      
      if (stat.isDirectory()) {
        output += `${prefix}[DIR]  ${entry}/\n`;
        if (recursive) {
          const subOutput = await listDirectory(fullPath, recursive, prefix + '  ');
          output += subOutput;
        }
      } else {
        const size = await formatSize(stat.size);
        output += `${prefix}[FILE] ${entry} (${size})\n`;
      }
    }
    
    return output;
  } catch (error) {
    throw new Error(`Failed to list directory: ${error}`);
  }
}

export const listDirectoryHandler: ToolHandler = async (params, context) => {
  const { path = '.', recursive = false } = params;
  
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
    const stat = await fs.stat(fullPath);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${path}`);
    }
    
    return await listDirectory(fullPath, recursive as boolean);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('ENOENT')) {
        throw new Error(`Directory not found: ${path}`);
      } else if (error.message.includes('EACCES')) {
        throw new Error(`Permission denied: ${path}`);
      } else {
        throw new Error(`Failed to list directory: ${error.message}`);
      }
    }
    throw new Error(`Failed to list directory: ${String(error)}`);
  }
};
