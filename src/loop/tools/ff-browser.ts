import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';
import { focusAndMaximizeChrome } from '../../browser-utils.js';

export const ffBrowserDefinition: ToolDefinition = {
  name: 'browser',
  description: 'Control the system browser (Chrome). Can open a URL in Chrome, close Chrome, close a specific tab by domain, or bring an application window to the foreground. Use this with the screenshot and vision_analyze tools to navigate the web visually.',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action to perform: "open" opens a URL in Chrome, "close" closes Chrome entirely, "close_tab" closes tabs matching a domain, "focus" brings an app window to the foreground',
        enum: ['open', 'close', 'close_tab', 'focus']
      },
      url: {
        type: 'string',
        description: 'URL to open (required for action="open")'
      },
      domain: {
        type: 'string',
        description: 'Domain to close tabs for (required for action="close_tab", e.g. "youtube.com")'
      },
      appName: {
        type: 'string',
        description: 'Application name to bring to foreground (for action="focus", defaults to "Google Chrome")'
      },
      waitMs: {
        type: 'number',
        description: 'Milliseconds to wait after the action for the page/app to load (default: 3000)',
        default: 3000
      }
    },
    required: ['action']
  }
};

export const ffBrowserHandler: ToolHandler = async (params: any, context?: ToolContext) => {
  const action = params.action as string;
  if (!action) {
    throw new Error('action parameter is required');
  }

  let BrowserController: any;
  try {
    const mod = await import('flow-frame-core/dist/controllers/browserController.js');
    BrowserController = mod.BrowserController;
  } catch (err: any) {
    throw new Error(`Failed to load browser controller module: ${err.message}`);
  }

  const waitMs = params.waitMs || 3000;

  try {
    if (action === 'open') {
      if (!params.url) {
        throw new Error('url parameter is required for action="open"');
      }
      await BrowserController.openChrome({ url: params.url });
      // Wait for the page to load
      await new Promise(resolve => setTimeout(resolve, waitMs));
      // Bring Chrome to front and maximise
      focusAndMaximizeChrome();
      await new Promise(resolve => setTimeout(resolve, 500));

      return `# Browser: Opened URL\n\n- URL: ${params.url}\n- Waited: ${waitMs}ms for page load\n- Chrome brought to foreground\n\nUse the \`screenshot\` tool to capture what's on screen, then \`vision_analyze\` to understand the page.`;

    } else if (action === 'close') {
      await BrowserController.closeChrome();
      return '# Browser: Chrome Closed\n\nGoogle Chrome has been terminated.';

    } else if (action === 'close_tab') {
      if (!params.domain) {
        throw new Error('domain parameter is required for action="close_tab"');
      }
      await BrowserController.closeChromeTab({ domain: params.domain });
      return `# Browser: Tab Closed\n\n- Domain: ${params.domain}\n- Tabs matching this domain have been closed.`;

    } else if (action === 'focus') {
      const appName = params.appName || 'Google Chrome';
      if (appName === 'Google Chrome') {
        focusAndMaximizeChrome();
      } else {
        await BrowserController.bringAppToFront({ appName });
      }
      await new Promise(resolve => setTimeout(resolve, 500));
      return `# Browser: App Focused\n\n- Application "${appName}" brought to foreground.\n\nUse the \`screenshot\` tool to see the current state.`;

    } else {
      throw new Error(`Unknown action: "${action}". Valid actions: open, close, close_tab, focus`);
    }
  } catch (err: any) {
    if (err.message.startsWith('Unknown action') || err.message.includes('parameter is required')) throw err;
    throw new Error(`Browser action "${action}" failed: ${err.message}`);
  }
};
