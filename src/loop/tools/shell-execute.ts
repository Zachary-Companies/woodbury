import { spawn } from 'child_process';
import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const shellExecuteDefinition: ToolDefinition = {
  name: 'shell_execute',
  description: 'Execute a shell command. Returns the exit code, stdout, and stderr.',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Shell command to execute'
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the command (default: agent working directory)'
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: uses agent tool timeout)'
      }
    },
    required: ['command']
  }
};

export const shellExecuteHandler: ToolHandler = async (params: any, context?: ToolContext) => {
  const command = params.command as string;
  const cwd = params.cwd as string | undefined;
  const timeout = params.timeout as number | undefined;
  
  if (!command) {
    throw new Error('command parameter is required');
  }
  
  if (typeof command !== 'string') {
    throw new Error('command must be a string');
  }
  
  const workingDirectory = cwd ? cwd : (context?.workingDirectory || process.cwd());
  const commandTimeout = timeout || context?.toolTimeout || 30000;
  
  return new Promise((resolve, reject) => {
    // Use shell execution for complex commands
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/bash';
    const shellFlag = isWindows ? '/c' : '-c';
    
    const proc = spawn(shell, [shellFlag, command], {
      cwd: workingDirectory,
      timeout: commandTimeout,
      shell: false
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
      const parts: string[] = [`Exit code: ${exitCode || 0}`];
      if (stdout) parts.push(`stdout:\n${stdout}`);
      if (stderr) parts.push(`stderr:\n${stderr}`);
      resolve(parts.join('\n'));
    });
    
    proc.on('error', (err) => {
      reject(err);
    });
  });
};
