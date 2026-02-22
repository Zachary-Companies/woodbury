import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const ffFileDialogDefinition: ToolDefinition = {
  name: 'file_dialog',
  description: 'Navigate the OS file selection dialog (macOS Finder / Windows Explorer) to select a file. Use this AFTER clicking a file input or "Upload" button that opened the native OS file dialog. Provide the full absolute file path — the tool handles the "Go to Folder" shortcut (⌘⇧G on macOS), pasting the path, and confirming. Do NOT use ~ (tilde) in the path — always expand to full /Users/username/... path.',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Full absolute path to the file to select (e.g., "/Users/name/Documents/photo.jpg"). Must be an absolute path — do NOT use ~ or relative paths.'
      },
      delayMs: {
        type: 'number',
        description: 'Milliseconds to wait between steps (default: 3000). Increase if the file dialog is slow to respond.',
        default: 3000
      }
    },
    required: ['filePath']
  }
};

export const ffFileDialogHandler: ToolHandler = async (params: any, context?: ToolContext) => {
  const filePath = params.filePath as string;
  if (!filePath) {
    throw new Error('filePath parameter is required');
  }

  // Validate it's an absolute path
  if (!filePath.startsWith('/') && !filePath.match(/^[A-Z]:\\/)) {
    throw new Error(`filePath must be an absolute path. Got: "${filePath}". Use full paths like /Users/name/file.txt or C:\\Users\\name\\file.txt`);
  }

  // Warn about tilde usage
  if (filePath.startsWith('~')) {
    throw new Error(`Do not use ~ in file paths. Expand to full path like /Users/${process.env.USER || 'username'}/...`);
  }

  const delayMs = params.delayMs ?? 3000;

  // Import flow-frame-core operations
  let flowFrameOps: any;
  try {
    flowFrameOps = await import('flow-frame-core/dist/operations.js');
  } catch (err: any) {
    throw new Error(`Failed to load flow-frame-core operations: ${err.message}`);
  }

  const isMac = process.platform === 'darwin';
  const isWindows = process.platform === 'win32';

  try {
    // Use flow-frame-core's fileModalOperate which handles the full sequence:
    // macOS: Cmd+Shift+G → wait → paste path → Enter → Enter
    // Windows: paste path → Enter
    await flowFrameOps.fileModalOperate(filePath);

    const platform = isMac ? 'macOS' : isWindows ? 'Windows' : 'Linux';
    return `# File Dialog: Selected\n\n- File: ${filePath}\n- Platform: ${platform}\n- Method: ${isMac ? 'Go to Folder (⌘⇧G) → paste path → confirm' : 'Direct path entry → confirm'}\n\n> The OS file dialog should now be closed and the file selected. Use \`vision_analyze\` or \`browser_query\` to verify the file was accepted by the page.`;
  } catch (err: any) {
    throw new Error(`File dialog operation failed: ${err.message}. Ensure the OS file dialog is open and focused before calling this tool.`);
  }
};
