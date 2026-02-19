import { spawn } from 'child_process';
import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const testRunnerDefinition: ToolDefinition = {
  name: 'test_run',
  description: 'Run tests using a test framework. Supports Jest, Vitest, and pytest.',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      framework: {
        type: 'string',
        description: 'Test framework: "jest", "vitest", or "pytest"'
      },
      testFile: {
        type: 'string',
        description: 'Path to specific test file (optional, runs all tests if not specified)'
      },
      testPattern: {
        type: 'string',
        description: 'Pattern to filter tests by name (optional)'
      }
    },
    required: ['framework']
  }
};

export const testRunnerHandler: ToolHandler = async (params: any, context?: ToolContext) => {
  const framework = params.framework as string;
  const testFile = params.testFile as string | undefined;
  const testPattern = params.testPattern as string | undefined;

  if (!framework) {
    throw new Error('framework parameter is required');
  }

  let command: string;
  let args: string[];

  switch (framework.toLowerCase()) {
    case 'jest':
      command = 'npx';
      args = ['jest', '--no-coverage'];
      if (testFile) args.push(testFile);
      if (testPattern) args.push('-t', testPattern);
      break;
    case 'vitest':
      command = 'npx';
      args = ['vitest', 'run'];
      if (testFile) args.push(testFile);
      if (testPattern) args.push('-t', testPattern);
      break;
    case 'pytest':
      command = 'python';
      args = ['-m', 'pytest', '-v'];
      if (testFile) args.push(testFile);
      if (testPattern) args.push('-k', testPattern);
      break;
    default:
      throw new Error(`Unsupported test framework: ${framework}. Supported: jest, vitest, pytest`);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: context?.workingDirectory,
      timeout: context?.toolTimeout,
      shell: true,
    });

    let output = '';

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr.on('data', (data) => {
      output += data.toString();
    });

    if (context?.signal) {
      context.signal.addEventListener('abort', () => {
        proc.kill('SIGTERM');
      });
    }

    proc.on('close', (exitCode) => {
      resolve(`Exit code: ${exitCode}\n\n${output}`);
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
};
