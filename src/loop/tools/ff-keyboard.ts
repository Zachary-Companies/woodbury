import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const ffKeyboardDefinition: ToolDefinition = {
  name: 'keyboard',
  description: 'Control the keyboard: type text, press individual keys, or use keyboard shortcuts (Ctrl+C, Cmd+V, etc.). Use with screenshot/vision_analyze to interact with focused UI elements. Uses flow-frame-core for cross-platform keyboard control.',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Keyboard action: "type" types a string of text, "press" presses a single key with optional modifiers, "hotkey" presses a keyboard shortcut, "clear" selects all and deletes (Cmd/Ctrl+A then Delete)',
        enum: ['type', 'press', 'hotkey', 'clear']
      },
      text: {
        type: 'string',
        description: 'Text to type (for action="type"). Types each character sequentially.'
      },
      key: {
        type: 'string',
        description: 'Key to press (for action="press" or "hotkey"). Examples: "enter", "tab", "escape", "space", "backspace", "delete", "up", "down", "left", "right", "home", "end", "pageup", "pagedown", "f1"-"f12", or any letter/number.'
      },
      ctrl: {
        type: 'boolean',
        description: 'Hold Ctrl (or Cmd on macOS) while pressing the key. For action="press" or "hotkey".',
        default: false
      },
      shift: {
        type: 'boolean',
        description: 'Hold Shift while pressing the key.',
        default: false
      },
      alt: {
        type: 'boolean',
        description: 'Hold Alt (or Option on macOS) while pressing the key.',
        default: false
      },
      repeat: {
        type: 'number',
        description: 'Number of times to repeat the key press (for action="press"). Default: 1.',
        default: 1
      },
      delayMs: {
        type: 'number',
        description: 'Milliseconds to wait after the action (default: 300).',
        default: 300
      }
    },
    required: ['action']
  }
};

export const ffKeyboardHandler: ToolHandler = async (params: any, context?: ToolContext) => {
  const action = params.action as string;
  if (!action) {
    throw new Error('action parameter is required');
  }

  // Import flow-frame-core operations
  let flowFrameOps: any;
  let robot: any;
  try {
    flowFrameOps = await import('flow-frame-core/dist/operations.js');
  } catch (err: any) {
    throw new Error(`Failed to load flow-frame-core operations: ${err.message}`);
  }

  try {
    robot = (await import('robotjs')).default || (await import('robotjs'));
  } catch (err: any) {
    throw new Error(`Failed to load robotjs: ${err.message}`);
  }

  const delayMs = params.delayMs ?? 300;
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  // Check if we're on Windows using flow-frame's isWindows
  const isWindows = flowFrameOps.isWindows();
  const isMac = process.platform === 'darwin';

  try {
    if (action === 'type') {
      if (!params.text) {
        throw new Error('text parameter is required for action="type"');
      }
      robot.typeString(params.text);
      await wait(delayMs);

      const preview = params.text.length > 50
        ? params.text.slice(0, 47) + '...'
        : params.text;
      return `# Keyboard: Typed\n\n- Text: "${preview}"\n- Length: ${params.text.length} characters`;

    } else if (action === 'press') {
      if (!params.key) {
        throw new Error('key parameter is required for action="press"');
      }
      
      // Use flow-frame's typeText/pressKey for key presses with modifiers
      const repeat = params.repeat || 1;
      
      for (let i = 0; i < repeat; i++) {
        if (params.ctrl || params.shift || params.alt) {
          // Use flow-frame's pressKey which handles modifier toggling properly
          await flowFrameOps.pressKey({
            keys: params.key.toLowerCase(),
            ctrl: params.ctrl || false,
            shift: params.shift || false,
            alt: params.alt || false
          });
        } else {
          // Simple key tap without modifiers
          robot.keyTap(params.key.toLowerCase());
        }
        if (repeat > 1 && i < repeat - 1) {
          await wait(50);
        }
      }
      await wait(delayMs);

      const modifiers: string[] = [];
      if (params.ctrl) modifiers.push(isMac ? 'Cmd' : 'Ctrl');
      if (params.shift) modifiers.push('Shift');
      if (params.alt) modifiers.push(isMac ? 'Option' : 'Alt');
      const modStr = modifiers.length > 0 ? modifiers.join('+') + '+' : '';
      const repeatStr = repeat > 1 ? ` (×${repeat})` : '';
      return `# Keyboard: Pressed\n\n- Key: ${modStr}${params.key}${repeatStr}`;

    } else if (action === 'hotkey') {
      if (!params.key) {
        throw new Error('key parameter is required for action="hotkey"');
      }
      
      // Use flow-frame's typeText for hotkeys (it handles Cmd/Ctrl properly)
      await flowFrameOps.typeText({
        keys: params.key.toLowerCase(),
        ctrl: params.ctrl !== false, // Default to true for hotkeys
        shift: params.shift || false,
        alt: params.alt || false
      });
      await wait(delayMs);

      const modifiers: string[] = [];
      if (params.ctrl !== false) modifiers.push(isMac ? 'Cmd' : 'Ctrl');
      if (params.shift) modifiers.push('Shift');
      if (params.alt) modifiers.push(isMac ? 'Option' : 'Alt');
      return `# Keyboard: Hotkey\n\n- Shortcut: ${modifiers.join('+')}+${params.key}`;

    } else if (action === 'clear') {
      // Use flow-frame pattern: Cmd/Ctrl+A to select all, then Delete
      const modifier = isMac ? 'command' : 'control';
      robot.setKeyboardDelay(50);
      robot.keyTap('a', modifier);
      await wait(50);
      robot.keyTap('delete');
      await wait(delayMs);
      return `# Keyboard: Cleared\n\n- Action: Selected all text (${isMac ? 'Cmd' : 'Ctrl'}+A) and deleted`;

    } else {
      throw new Error(`Unknown action: "${action}". Valid: type, press, hotkey, clear`);
    }
  } catch (err: any) {
    if (err.message.startsWith('Unknown action') || err.message.includes('required')) throw err;
    throw new Error(`Keyboard action "${action}" failed: ${err.message}`);
  }
};
