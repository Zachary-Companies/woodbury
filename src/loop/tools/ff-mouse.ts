import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

// Cached Chrome offset — fetched from bridge server on first use, then reused
let cachedChromeOffset: { x: number; y: number } | null = null;
let lastOffsetFetchTime = 0;
const OFFSET_CACHE_TTL = 30000; // Re-fetch every 30s in case window moves/resizes

async function getDynamicChromeOffset(): Promise<{ x: number; y: number } | null> {
  const now = Date.now();
  if (cachedChromeOffset && (now - lastOffsetFetchTime) < OFFSET_CACHE_TTL) {
    return cachedChromeOffset;
  }

  try {
    const { bridgeServer } = await import('../../bridge-server.js');
    if (!bridgeServer.isConnected) return null;

    const result = await bridgeServer.send('ping', {});
    if (result?.chromeOffset) {
      cachedChromeOffset = {
        x: result.chromeOffset.chromeUIWidth ?? 1,
        y: result.chromeOffset.chromeUIHeight ?? 125
      };
      lastOffsetFetchTime = now;
      return cachedChromeOffset;
    }
  } catch {
    // Bridge not available — fall through to null
  }
  return null;
}

export const ffMouseDefinition: ToolDefinition = {
  name: 'mouse',
  description: 'Control the mouse cursor: move to coordinates, click, double-click, scroll, or drag. Use with the screenshot and vision_analyze tools to interact with GUI elements — take a screenshot, identify element positions with vision, then click/type at those coordinates. Uses flow-frame-core for cross-platform mouse control.',
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
      },
      // For element-based positioning (flow-frame style)
      position: {
        type: 'object',
        description: 'Element position object with {left, top, width, height}. If provided, clicks center of element. Alternative to x/y coordinates.',
        properties: {
          left: { type: 'number' },
          top: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' }
        }
      },
      forDesktop: {
        type: 'boolean',
        description: 'If true, use desktop mode (no Chrome offset compensation). Default: false (assumes Chrome browser).',
        default: false
      },
      chromeOffsetY: {
        type: 'number',
        description: 'Override the Chrome UI offset Y value (default: 125). Set this to chromeOffset.chromeUIHeight from browser_query for accurate positioning. Only used with position parameter when forDesktop=false.'
      },
      chromeOffsetX: {
        type: 'number',
        description: 'Override the Chrome UI offset X value (default: 1). Set this to chromeOffset.chromeUIWidth from browser_query for accurate positioning. Only used with position parameter when forDesktop=false.'
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

  const delayMs = params.delayMs ?? 500;
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  try {
    const screenSize = robot.getScreenSize();

    // Handle element position object (flow-frame style)
    if (params.position && (action === 'move' || action === 'click' || action === 'double_click' || action === 'right_click')) {
      const { left, top, width, height } = params.position;
      if (typeof left !== 'number' || typeof top !== 'number' || typeof width !== 'number' || typeof height !== 'number') {
        throw new Error('position object must have left, top, width, height as numbers');
      }

      // Determine Chrome offset: explicit param > auto-detected > hardcoded fallback
      let offsetSource = 'hardcoded (y=125)';
      let offsetX = 1;
      let offsetY = 125;

      if (params.forDesktop) {
        // Desktop mode: no Chrome offset, click center of element
        await flowFrameOps.moveMouseDesktop(params.position);
        offsetSource = 'desktop (no offset)';
      } else {
        // Try to get accurate offset: explicit params first, then auto-detect from bridge
        if (params.chromeOffsetY !== undefined || params.chromeOffsetX !== undefined) {
          offsetX = params.chromeOffsetX ?? 1;
          offsetY = params.chromeOffsetY ?? 125;
          offsetSource = `explicit (y=${offsetY})`;
        } else {
          // Auto-detect from bridge server
          const dynamicOffset = await getDynamicChromeOffset();
          if (dynamicOffset) {
            offsetX = dynamicOffset.x;
            offsetY = dynamicOffset.y;
            offsetSource = `auto-detected (y=${offsetY})`;
          }
          // else: fall through with hardcoded defaults
        }

        // Calculate target position: element center + chrome offset
        const targetX = left + offsetX + (width / 2);
        const targetY = top + offsetY + (height / 2);
        if (flowFrameOps.isWindows()) {
          robot.moveMouse(targetX, targetY);
        } else {
          robot.moveMouseSmooth(targetX, targetY);
        }
      }

      if (action === 'click') {
        await flowFrameOps.mouseClick();
      } else if (action === 'double_click') {
        robot.mouseClick();
        await wait(100);
        robot.mouseClick();
      } else if (action === 'right_click') {
        robot.mouseClick('right');
      }

      await wait(delayMs);
      const pos = robot.getMousePos();
      const actionLabel = action === 'move' ? 'Moved' : action === 'click' ? 'Clicked' : action === 'double_click' ? 'Double-Clicked' : 'Right-Clicked';
      return `# Mouse: ${actionLabel} (element position)\n\n- Element bounds: left=${left}, top=${top}, width=${width}, height=${height}\n- Current position: (${pos.x}, ${pos.y})\n- Chrome offset: ${offsetSource}`;
    }

    // Handle x/y coordinate-based actions
    if (action === 'move') {
      if (params.x === undefined || params.y === undefined) {
        throw new Error('x and y coordinates are required for action="move" (or provide a position object)');
      }
      
      // Use flow-frame's isWindows check for platform-specific behavior
      if (flowFrameOps.isWindows()) {
        robot.moveMouse(params.x, params.y);
      } else {
        if (params.smooth === false) {
          robot.moveMouse(params.x, params.y);
        } else {
          robot.moveMouseSmooth(params.x, params.y);
        }
      }
      await wait(delayMs);
      const pos = robot.getMousePos();
      return `# Mouse: Moved\n\n- Target: (${params.x}, ${params.y})\n- Current: (${pos.x}, ${pos.y})\n- Screen: ${screenSize.width}x${screenSize.height}`;

    } else if (action === 'click') {
      if (params.x !== undefined && params.y !== undefined) {
        if (flowFrameOps.isWindows()) {
          robot.moveMouse(params.x, params.y);
        } else {
          robot.moveMouseSmooth(params.x, params.y);
        }
        await wait(100);
      }
      // Use flow-frame's mouseClick which has a built-in delay for safety
      await flowFrameOps.mouseClick();
      await wait(delayMs);
      const pos = robot.getMousePos();
      return `# Mouse: Clicked\n\n- Position: (${pos.x}, ${pos.y})\n- Button: left`;

    } else if (action === 'double_click') {
      if (params.x !== undefined && params.y !== undefined) {
        if (flowFrameOps.isWindows()) {
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
        if (flowFrameOps.isWindows()) {
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
      // Use flow-frame's scroll function
      flowFrameOps.scroll(scrollX, scrollY);
      await wait(delayMs);
      return `# Mouse: Scrolled\n\n- Horizontal: ${scrollX}\n- Vertical: ${scrollY}`;

    } else if (action === 'drag') {
      if (params.x === undefined || params.y === undefined) {
        throw new Error('x and y (target) coordinates are required for action="drag"');
      }
      const startPos = robot.getMousePos();
      robot.mouseToggle('down');
      await wait(200);
      if (flowFrameOps.isWindows()) {
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
