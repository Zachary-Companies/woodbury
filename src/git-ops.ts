import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface GitCheckpoint {
  ref: string;
  message: string;
  timestamp: string;
}

export class GitOps {
  constructor(private workingDirectory: string) {}

  async createCheckpoint(message: string): Promise<string> {
    try {
      const { stdout, stderr } = await execAsync(
        `git stash push -u -m "[woodbury-checkpoint] ${message}"`,
        { cwd: this.workingDirectory }
      );

      if (stderr && stderr.includes('fatal')) {
        throw new Error(`Failed to create git checkpoint: ${stderr}`);
      }

      // Extract stash reference from output
      const match = stdout.match(/stash@\{(\d+)\}/);
      if (match) {
        return `stash@{${match[1]}}`;
      }

      // Fallback to stash@{0} for new stash
      return 'stash@{0}';
    } catch (error: any) {
      throw new Error(`Failed to create git checkpoint: ${error.message}`);
    }
  }

  async listCheckpoints(): Promise<string[]> {
    try {
      const { stdout } = await execAsync(
        'git stash list --grep="\\[woodbury-checkpoint\\]"',
        { cwd: this.workingDirectory }
      );

      return stdout
        .split('\n')
        .filter((line: string) => line.trim().length > 0)
        .map((line: string) => line.trim());
    } catch (error) {
      return [];
    }
  }

  async restoreCheckpoint(ref: string): Promise<void> {
    try {
      const { stderr } = await execAsync(
        `git stash apply ${ref}`,
        { cwd: this.workingDirectory }
      );

      if (stderr && stderr.includes('error')) {
        throw new Error(`Failed to restore checkpoint: ${stderr}`);
      }
    } catch (error: any) {
      throw new Error(`Failed to restore checkpoint: ${error.message}`);
    }
  }

  async getCurrentBranch(): Promise<string> {
    try {
      const { stdout, stderr } = await execAsync(
        'git branch --show-current',
        { cwd: this.workingDirectory }
      );

      if (stderr && stderr.includes('fatal')) {
        return 'HEAD'; // Detached HEAD state
      }

      return stdout.trim() || 'HEAD';
    } catch (error) {
      throw error;
    }
  }

  async getStatus(): Promise<string> {
    try {
      const { stdout, stderr } = await execAsync(
        'git status --porcelain',
        { cwd: this.workingDirectory }
      );

      if (stderr && stderr.includes('fatal')) {
        throw new Error(`Git status failed: ${stderr}`);
      }

      return stdout.trim();
    } catch (error) {
      throw error;
    }
  }

  async isRepository(): Promise<boolean> {
    try {
      await execAsync('git rev-parse --git-dir', { cwd: this.workingDirectory });
      return true;
    } catch (error) {
      return false;
    }
  }
}
