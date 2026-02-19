import { spawn } from 'child_process';
import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const codeExecuteDefinition: ToolDefinition = {
  name: 'code_execute',
  description: 'Execute code in a specified language. Supports Node.js (JavaScript/TypeScript) and Python.',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      language: {
        type: 'string',
        description: 'Programming language: "node", "javascript", "typescript", or "python"'
      },
      code: {
        type: 'string',
        description: 'Code to execute'
      }
    },
    required: ['language', 'code']
  }
};

export const codeExecuteHandler: ToolHandler = async (params: any, context?: ToolContext) => {
  const language = params.language as string;
  const code = params.code as string;

  if (!language) {
    throw new Error('language parameter is required');
  }
  if (!code) {
    throw new Error('code parameter is required');
  }

  let command: string;
  let args: string[];

  switch (language.toLowerCase()) {
    case 'node':
    case 'javascript':
      command = 'node';
      args = ['-e', code];
      break;
    case 'typescript':
      command = 'npx';
      args = ['ts-node', '-e', code];
      break;
    case 'python':
      command = 'python';
      args = ['-c', code];
      break;
    default:
      throw new Error(`Unsupported language: ${language}. Supported: node, javascript, typescript, python`);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: context?.workingDirectory,
      timeout: context?.toolTimeout,
      shell: true,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // Handle abort signal
    if (context?.signal) {
      context.signal.addEventListener('abort', () => {
        proc.kill('SIGTERM');
      });
    }

    proc.on('close', (exitCode) => {
      if (exitCode === 0) {
        resolve(stdout || '(no output)');
      } else {
        resolve(`Exit code: ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
};
