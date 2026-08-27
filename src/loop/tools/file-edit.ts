import { promises as fs } from 'fs';
import { resolve } from 'path';
import { ToolDefinition, ToolHandler } from '../types.js';

export const fileEditDefinition: ToolDefinition = {
  name: 'file_edit',
  description: 'Make a targeted edit to a file by replacing an exact string match. You MUST read the file first using file_read to get the exact text to replace. Use this instead of file_write when modifying existing files — it only changes what you specify, leaving the rest of the file intact.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file (relative to working directory or absolute)',
        required: true
      },
      old_string: {
        type: 'string',
        description: 'The exact text to find in the file. Must match exactly, including whitespace and indentation.',
        required: true
      },
      new_string: {
        type: 'string',
        description: 'The replacement text. Can be empty string to delete the matched text.',
        required: true
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences of old_string. Default: false (fails if the match is not unique).',
        required: false,
        default: false
      }
    },
    required: ['path', 'old_string', 'new_string']
  },
  // Overwrites existing file contents, same blast radius as file_write —
  // must be gated by the same --safe / allowDangerousTools check.
  dangerous: true
};

export const fileEditHandler: ToolHandler = async (params, context) => {
  const { path, old_string, new_string, replace_all = false } = params;

  if (!path || typeof path !== 'string') {
    throw new Error('path parameter is required and must be a string');
  }

  if (typeof old_string !== 'string') {
    throw new Error('old_string parameter is required and must be a string');
  }

  if (old_string === '') {
    throw new Error('old_string must not be empty');
  }

  if (typeof new_string !== 'string') {
    throw new Error('new_string parameter is required and must be a string');
  }

  if (old_string === new_string) {
    throw new Error('old_string and new_string are identical — no edit needed');
  }

  const workingDirectory = context?.workingDirectory || process.cwd();
  const fullPath = resolve(workingDirectory, path as string);

  // Basic security check - prevent directory traversal outside working directory
  if (!fullPath.startsWith(resolve(workingDirectory))) {
    throw new Error('Access denied: path is outside working directory');
  }

  let content: string;
  try {
    content = await fs.readFile(fullPath, 'utf-8');
  } catch (error) {
    // Match on the errno `code`, not `instanceof Error`. Node's fs rejections
    // are not instanceof the *caller's* Error when they cross a VM realm
    // boundary (as they do under Jest), which silently disabled both friendly
    // messages below and left only the generic "Failed to read file".
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === 'ENOENT' || message.includes('ENOENT')) {
      throw new Error(`File not found: ${path}. Use file_write to create new files.`);
    }
    if (code === 'EACCES' || message.includes('EACCES')) {
      throw new Error(`Permission denied: ${path}`);
    }
    throw new Error(`Failed to read file: ${String(error)}`);
  }

  // Count occurrences
  const count = content.split(old_string as string).length - 1;

  if (count === 0) {
    throw new Error(
      'old_string not found in file. Read the file first with file_read to get the exact text to replace.'
    );
  }

  if (count > 1 && !replace_all) {
    throw new Error(
      `old_string found ${count} times in the file. Provide a longer, more specific match to be unique, or set replace_all: true to replace all occurrences.`
    );
  }

  // Perform replacement.
  // NOTE: never use String.replace() with a string replacement here — it expands
  // $&, $`, $', $1 and $$ inside new_string as replacement patterns, which
  // silently corrupts any edit whose replacement text contains a dollar sign
  // (shell scripts, regex code, template literals). split/join is literal.
  const parts = content.split(old_string as string);
  const newContent = replace_all
    ? parts.join(new_string as string)
    : [parts[0], parts.slice(1).join(old_string as string)].join(new_string as string);

  try {
    await fs.writeFile(fullPath, newContent, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === 'EACCES' || message.includes('EACCES')) {
      throw new Error(`Permission denied: ${path}`);
    }
    throw new Error(`Failed to write file: ${String(error)}`);
  }

  return `Successfully edited ${path}: replaced ${count} occurrence(s) (${(old_string as string).length} chars → ${(new_string as string).length} chars)`;
};
