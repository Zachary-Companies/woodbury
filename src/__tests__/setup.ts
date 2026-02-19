// Jest setup file

// Helper to create a chainable chalk function
function createChainable(prefix = ''): any {
  const fn: any = (str: string) => prefix ? `[${prefix}]${str}` : str;
  
  // Add color methods that return new chainable functions
  const colors = ['red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'white', 'gray', 'grey', 'whiteBright', 'visible',
                  'bgRed', 'bgGreen', 'bgBlue', 'bgYellow', 'bgCyan', 'bgMagenta', 'bgWhite', 'bgGray', 'bgGrey'];
  const modifiers = ['bold', 'dim', 'italic', 'underline', 'inverse', 'hidden', 'strikethrough'];
  
  const allMethods = [...colors, ...modifiers];
  
  allMethods.forEach(method => {
    const newPrefix = prefix ? `${prefix}.${method.toUpperCase()}` : method.toUpperCase();
    Object.defineProperty(fn, method, {
      get: () => createChainable(newPrefix),
      enumerable: true,
      configurable: true
    });
  });
  
  // Add hex method - returns a chainable with the hex code as prefix
  fn.hex = (hexCode: string) => {
    const newPrefix = prefix ? `${prefix}.HEX(${hexCode})` : `HEX(${hexCode})`;
    return createChainable(newPrefix);
  };
  
  // Add bgHex method - returns a chainable with the bgHex code as prefix
  fn.bgHex = (hexCode: string) => {
    const newPrefix = prefix ? `${prefix}.BGHEX(${hexCode})` : `BGHEX(${hexCode})`;
    return createChainable(newPrefix);
  };
  
  // Add rgb method - returns a chainable with the rgb values as prefix
  fn.rgb = (r: number, g: number, b: number) => {
    const newPrefix = prefix ? `${prefix}.RGB(${r},${g},${b})` : `RGB(${r},${g},${b})`;
    return createChainable(newPrefix);
  };
  
  // Add bgRgb method - returns a chainable with the bgRgb values as prefix
  fn.bgRgb = (r: number, g: number, b: number) => {
    const newPrefix = prefix ? `${prefix}.BGRGB(${r},${g},${b})` : `BGRGB(${r},${g},${b})`;
    return createChainable(newPrefix);
  };
  
  return fn;
}

// Create the main chalk object with chaining support
const mockChalk = createChainable();
mockChalk.default = mockChalk;

// Mock chalk to avoid ES module issues with full chaining support
jest.mock('chalk', () => mockChalk);

// Mock marked-terminal
jest.mock('marked-terminal', () => {
  return function TerminalRenderer() {
    return {
      heading: (text: string) => text,
      code: (text: string) => text,
      paragraph: (text: string) => text,
      list: (body: string) => body,
      listitem: (text: string) => `- ${text}\n`,
      table: (header: string, body: string) => `${header}${body}`,
      tablerow: (content: string) => `${content}\n`,
      tablecell: (content: string) => `${content} | `,
      strong: (text: string) => `**${text}**`,
      em: (text: string) => `*${text}*`,
      codespan: (text: string) => `\`${text}\``,
      br: () => '\n',
      del: (text: string) => `~~${text}~~`,
      link: (href: string, _title: string, text: string) => `[${text}](${href})`,
      image: (href: string, _title: string, text: string) => `![${text}](${href})`,
      text: (text: string) => text
    };
  };
});

// Mock ora to avoid ES module issues
jest.mock('ora', () => ({
  default: () => ({
    start: jest.fn().mockReturnThis(),
    stop: jest.fn().mockReturnThis(),
    succeed: jest.fn().mockReturnThis(),
    fail: jest.fn().mockReturnThis(),
    text: '',
    color: 'cyan'
  })
}));

// Mock process.exit to prevent tests from actually exiting
const originalExit = process.exit;
beforeEach(() => {
  process.exit = jest.fn() as never;
});

afterEach(() => {
  process.exit = originalExit;
});

// Increase timeout for integration tests
jest.setTimeout(10000);
