// This file runs BEFORE Jest's test framework is installed
// We use it to set up module mocks that need to be in place before any imports happen

// Helper to create a chainable chalk function
function createChainable(prefix = '') {
  const fn = function(str) {
    return prefix ? `[${prefix}]${str}` : str;
  };
  
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
  fn.hex = (hexCode) => {
    const newPrefix = prefix ? `${prefix}.HEX(${hexCode})` : `HEX(${hexCode})`;
    return createChainable(newPrefix);
  };
  
  // Add bgHex method - returns a chainable with the bgHex code as prefix
  fn.bgHex = (hexCode) => {
    const newPrefix = prefix ? `${prefix}.BGHEX(${hexCode})` : `BGHEX(${hexCode})`;
    return createChainable(newPrefix);
  };
  
  // Add rgb method - returns a chainable with the rgb values as prefix
  fn.rgb = (r, g, b) => {
    const newPrefix = prefix ? `${prefix}.RGB(${r},${g},${b})` : `RGB(${r},${g},${b})`;
    return createChainable(newPrefix);
  };
  
  // Add bgRgb method - returns a chainable with the bgRgb values as prefix
  fn.bgRgb = (r, g, b) => {
    const newPrefix = prefix ? `${prefix}.BGRGB(${r},${g},${b})` : `BGRGB(${r},${g},${b})`;
    return createChainable(newPrefix);
  };
  
  return fn;
}

// Create the mock chalk object
const mockChalk = createChainable();
mockChalk.default = mockChalk;

// Override the require cache for chalk
const Module = require('module');
const originalRequire = Module.prototype.require;

Module.prototype.require = function(id) {
  if (id === 'chalk') {
    return mockChalk;
  }
  return originalRequire.apply(this, arguments);
};
