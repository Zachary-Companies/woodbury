import { spawn } from 'child_process';
import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const gitDefinition: ToolDefinition = {
  name: 'git',
  description:
    'Run a git command. Executes git subcommands directly without a shell for safety. Returns stdout on success, or exit code with stdout and stderr on failure.',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      subcommand: {
        type: 'string',
        description: 'Git subcommand to run (e.g. "status", "log", "diff", "add", "commit")'
      },
      args: {
        type: 'array',
        description: 'Additional arguments for the git subcommand (e.g. ["--oneline", "-n", "10"])'
      }
    },
    required: ['subcommand']
  }
};

export const gitHandler: ToolHandler = async (params: any, context?: ToolContext) => {
  const subcommand = params.subcommand as string;
  const args = (params.args as string[]) || [];

  if (!subcommand) {
    throw new Error('subcommand parameter is required');
  }

  return new Promise((resolve, reject) => {
    const proc = spawn('git', [subcommand, ...args], {
      cwd: context?.workingDirectory,
      timeout: context?.toolTimeout,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    if (context?.signal) {
      context.signal.addEventListener('abort', () => {
        proc.kill('SIGTERM');
      });
    }

    proc.on('close', (exitCode) => {
      if (exitCode === 0) {
        resolve(stdout || '(no output)');
      } else {
        const parts: string[] = [`Exit code: ${exitCode}`];
        if (stdout) parts.push(`stdout:\n${stdout}`);
        if (stderr) parts.push(`stderr:\n${stderr}`);
        resolve(parts.join('\n'));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
};
