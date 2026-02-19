import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const ffMouseDefinition: ToolDefinition = {
  name: 'mouse',
  description: 'Control the mouse cursor: move to coordinates, click, double-click, scroll, or drag. Use with the screenshot and vision_analyze tools to interact with GUI elements — take a screenshot, identify element positions with vision, then click/type at those coordinates. Requires robotjs.',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Mouse action: "move" moves cursor to position, "click" left-clicks at position (or current), "double_click" double-clicks, "right_click" right-clicks, "scroll" scrolls the wheel, "drag" press-and-drag from current position to target',
        enum: ['move', 'click', 'double_click', 'right_click', 'scroll', 'drag']
      },
      x: {
        type: 'number',
        description: 'X coordinate (pixels from left edge of screen). Required for move, click, double_click, right_click, drag.'
      },
      y: {
        type: 'number',
        description: 'Y coordinate (pixels from top edge of screen). Required for move, click, double_click, right_click, drag.'
      },
      scrollX: {
        type: 'number',
        description: 'Horizontal scroll amount (positive=right, negative=left). For action="scroll".',
        default: 0
      },
      scrollY: {
        type: 'number',
        description: 'Vertical scroll amount (positive=down, negative=up). For action="scroll".',
        default: 0
      },
      smooth: {
        type: 'boolean',
        description: 'Use smooth mouse movement (default: true on macOS/Linux, false on Windows)',
      },
      delayMs: {
        type: 'number',
        description: 'Milliseconds to wait after the action (default: 500). Useful for letting UI respond.',
        default: 500
      }
    },
    required: ['action']
  }
};

export const ffMouseHandler: ToolHandler = async (params: any, context?: ToolContext) => {
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

  const delayMs = params.delayMs ?? 500;

  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  try {
    const screenSize = robot.getScreenSize();

    if (action === 'move') {
      if (params.x === undefined || params.y === undefined) {
        throw new Error('x and y coordinates are required for action="move"');
      }
      const os = await import('os');
      if (params.smooth === false || (params.smooth === undefined && os.platform() === 'win32')) {
        robot.moveMouse(params.x, params.y);
      } else {
        robot.moveMouseSmooth(params.x, params.y);
      }
      await wait(delayMs);
      const pos = robot.getMousePos();
      return `# Mouse: Moved\n\n- Target: (${params.x}, ${params.y})\n- Current: (${pos.x}, ${pos.y})\n- Screen: ${screenSize.width}x${screenSize.height}`;

    } else if (action === 'click') {
      if (params.x !== undefined && params.y !== undefined) {
        const os = await import('os');
        if (os.platform() === 'win32') {
          robot.moveMouse(params.x, params.y);
        } else {
          robot.moveMouseSmooth(params.x, params.y);
        }
        await wait(100);
      }
      robot.mouseClick();
      await wait(delayMs);
      const pos = robot.getMousePos();
      return `# Mouse: Clicked\n\n- Position: (${pos.x}, ${pos.y})\n- Button: left`;

    } else if (action === 'double_click') {
      if (params.x !== undefined && params.y !== undefined) {
        const os = await import('os');
        if (os.platform() === 'win32') {
          robot.moveMouse(params.x, params.y);
        } else {
          robot.moveMouseSmooth(params.x, params.y);
        }
        await wait(100);
      }
      robot.mouseClick();
      await wait(100);
      robot.mouseClick();
      await wait(delayMs);
      const pos = robot.getMousePos();
      return `# Mouse: Double-Clicked\n\n- Position: (${pos.x}, ${pos.y})`;

    } else if (action === 'right_click') {
      if (params.x !== undefined && params.y !== undefined) {
        const os = await import('os');
        if (os.platform() === 'win32') {
          robot.moveMouse(params.x, params.y);
        } else {
          robot.moveMouseSmooth(params.x, params.y);
        }
        await wait(100);
      }
      robot.mouseClick('right');
      await wait(delayMs);
      const pos = robot.getMousePos();
      return `# Mouse: Right-Clicked\n\n- Position: (${pos.x}, ${pos.y})\n- Button: right`;

    } else if (action === 'scroll') {
      const scrollX = params.scrollX || 0;
      const scrollY = params.scrollY || 0;
      if (scrollX === 0 && scrollY === 0) {
        throw new Error('At least one of scrollX or scrollY must be non-zero for action="scroll"');
      }
      robot.scrollMouse(scrollX, scrollY);
      await wait(delayMs);
      return `# Mouse: Scrolled\n\n- Horizontal: ${scrollX}\n- Vertical: ${scrollY}`;

    } else if (action === 'drag') {
      if (params.x === undefined || params.y === undefined) {
        throw new Error('x and y (target) coordinates are required for action="drag"');
      }
      const startPos = robot.getMousePos();
      robot.mouseToggle('down');
      await wait(200);
      const os = await import('os');
      if (os.platform() === 'win32') {
        robot.moveMouse(params.x, params.y);
      } else {
        robot.moveMouseSmooth(params.x, params.y);
      }
      await wait(200);
      robot.mouseToggle('up');
      await wait(delayMs);
      return `# Mouse: Dragged\n\n- From: (${startPos.x}, ${startPos.y})\n- To: (${params.x}, ${params.y})`;

    } else {
      throw new Error(`Unknown action: "${action}". Valid: move, click, double_click, right_click, scroll, drag`);
    }
  } catch (err: any) {
    if (err.message.startsWith('Unknown action') || err.message.includes('required')) throw err;
    throw new Error(`Mouse action "${action}" failed: ${err.message}`);
  }
};
