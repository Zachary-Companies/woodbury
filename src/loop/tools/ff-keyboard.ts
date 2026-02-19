import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const ffKeyboardDefinition: ToolDefinition = {
  name: 'keyboard',
  description: 'Control the keyboard: type text, press individual keys, or use keyboard shortcuts (Ctrl+C, Cmd+V, etc.). Use with screenshot/vision_analyze to interact with focused UI elements. Requires robotjs.',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Keyboard action: "type" types a string of text, "press" presses a single key with optional modifiers, "hotkey" presses a keyboard shortcut',
        enum: ['type', 'press', 'hotkey']
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

  let robot: any;
  try {
    robot = (await import('robotjs')).default || (await import('robotjs'));
  } catch (err: any) {
    throw new Error(`Failed to load robotjs. Make sure robotjs is installed: ${err.message}`);
  }

  const delayMs = params.delayMs ?? 300;
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  // Build modifiers array for robotjs
  const buildModifiers = (): string[] => {
    const mods: string[] = [];
    const os = require('os');
    const isMac = os.platform() === 'darwin';

    if (params.ctrl) {
      mods.push(isMac ? 'command' : 'control');
    }
    if (params.shift) {
      mods.push('shift');
    }
    if (params.alt) {
      mods.push(isMac ? 'option' : 'alt');
    }
    return mods;
  };

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
      const modifiers = buildModifiers();
      const repeat = params.repeat || 1;

      for (let i = 0; i < repeat; i++) {
        if (modifiers.length > 0) {
          robot.keyTap(params.key.toLowerCase(), modifiers);
        } else {
          robot.keyTap(params.key.toLowerCase());
        }
        if (repeat > 1 && i < repeat - 1) {
          await wait(50);
        }
      }
      await wait(delayMs);

      const modStr = modifiers.length > 0 ? modifiers.join('+') + '+' : '';
      const repeatStr = repeat > 1 ? ` (×${repeat})` : '';
      return `# Keyboard: Pressed\n\n- Key: ${modStr}${params.key}${repeatStr}`;

    } else if (action === 'hotkey') {
      if (!params.key) {
        throw new Error('key parameter is required for action="hotkey"');
      }
      const modifiers = buildModifiers();
      if (modifiers.length === 0) {
        // If no modifiers specified for hotkey, default to Ctrl/Cmd
        const os = require('os');
        modifiers.push(os.platform() === 'darwin' ? 'command' : 'control');
      }
      robot.keyTap(params.key.toLowerCase(), modifiers);
      await wait(delayMs);

      return `# Keyboard: Hotkey\n\n- Shortcut: ${modifiers.join('+')}+${params.key}`;

    } else {
      throw new Error(`Unknown action: "${action}". Valid: type, press, hotkey`);
    }
  } catch (err: any) {
    if (err.message.startsWith('Unknown action') || err.message.includes('required')) throw err;
    throw new Error(`Keyboard action "${action}" failed: ${err.message}`);
  }
};
