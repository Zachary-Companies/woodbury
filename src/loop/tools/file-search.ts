import { promises as fs, Stats } from 'fs';
import { resolve, join, relative } from 'path';
import { glob } from 'glob';
import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const fileSearchDefinition: ToolDefinition = {
  name: 'file_search',
  description: 'Search for files matching a glob pattern. Recursively walks directories, skipping node_modules, .git, and dist.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern to match file paths (e.g. "**/*.ts", "src/**/*.json")'
      },
      path: {
        type: 'string',
        description: 'Directory to search in (relative to working directory or absolute). Default: "."',
        default: '.'
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results to return (default: 50)',
        default: 50
      }
    },
    required: ['pattern']
  }
};

export const fileSearchHandler: ToolHandler = async (params: any, context?: ToolContext) => {
  const pattern = params.pattern as string;
  const searchPath = (params.path as string) || '.';
  const maxResults = (params.maxResults as number) || 50;
  
  if (!pattern) {
    throw new Error('pattern parameter is required');
  }
  
  if (typeof pattern !== 'string') {
    throw new Error('pattern must be a string');
  }
  
  const workingDirectory = context?.workingDirectory || process.cwd();
  const fullPath = resolve(workingDirectory, searchPath);
  
  // Basic security check - prevent directory traversal outside working directory
  if (!fullPath.startsWith(resolve(workingDirectory))) {
    throw new Error('Access denied: path is outside working directory');
  }
  
  try {
    const files = await glob(pattern, {
      cwd: fullPath,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.next/**', '**/build/**'],
      absolute: false,
      nodir: true
    });

    if (files.length === 0) {
      return 'No files found matching the pattern.';
    }

    const limitedFiles = files.slice(0, maxResults);
    const results = limitedFiles.map((file: string) => {
      const absolutePath = resolve(fullPath, file);
      const relativePath = relative(workingDirectory, absolutePath).replace(/\\/g, '/');
      return {
        path: relativePath,
        absolutePath
      };
    });
    
    let output = `Found ${files.length} files${files.length > maxResults ? ` (showing first ${maxResults})` : ''}:\n`;
    output += results.map((result: any) => result.path).join('\n');
    
    return output;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to search files: ${error.message}`);
    }
    throw new Error(`Failed to search files: ${String(error)}`);
  }
};
