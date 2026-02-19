/**
 * Format output for display in the REPL
 */
export function formatOutput(response: string): string {
  // Add some basic formatting
  return `\n${response}\n`;
}

/**
 * Check if a path is safe to operate on
 */
export function isSafePath(path: string): boolean {
  // Basic safety checks
  const normalizedPath = path.toLowerCase();
  const dangerousPaths = [
    '/system',
    '/windows',
    'c:\\windows',
    '/usr/bin',
    '/bin',
    '/sbin'
  ];
  
  return !dangerousPaths.some(dangerous => 
    normalizedPath.startsWith(dangerous)
  );
}

/**
 * Simple input function for backwards compatibility
 */
export async function input(prompt: string): Promise<string> {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    rl.question(prompt, (answer: string) => {
      rl.close();
      resolve(answer);
    });
  });
}
