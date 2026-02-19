import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// ── Types ────────────────────────────────────────────────

export interface CheckpointResult {
  ref: string | null;
  message: string;
}

// ── Utilities ────────────────────────────────────────────

export async function isGitRepo(workDir: string): Promise<boolean> {
  // Fast check: look for .git directory
  try {
    await access(join(workDir, '.git'));
    return true;
  } catch {
    // Fallback: git rev-parse (handles worktrees, submodules)
    try {
      await execAsync('git rev-parse --is-inside-work-tree', {
        cwd: workDir,
        timeout: 5_000,
      });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Create a git stash checkpoint without modifying the working tree.
 * Uses `git stash create` to create a stash commit, then `git stash store`
 * to save it with a woodbury-checkpoint prefix.
 *
 * Returns null ref if the tree is clean or this is not a git repo.
 */
export async function createCheckpoint(
  workDir: string,
  reason: string,
): Promise<CheckpointResult> {
  if (!(await isGitRepo(workDir))) {
    return { ref: null, message: 'Not a git repository.' };
  }

  try {
    // git stash create returns the stash commit hash, or empty if clean tree
    const { stdout } = await execAsync('git stash create', {
      cwd: workDir,
      timeout: 15_000,
    });

    const ref = stdout.trim();
    if (!ref) {
      return { ref: null, message: 'Working tree clean, no checkpoint needed.' };
    }

    // Store the stash with our prefix so it shows up in git stash list
    const msg = `woodbury-checkpoint: ${reason}`;
    await execAsync(`git stash store -m "${msg.replace(/"/g, '\\"')}" ${ref}`, {
      cwd: workDir,
      timeout: 5_000,
    });

    return { ref, message: `Checkpoint created: ${ref.slice(0, 8)}` };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { ref: null, message: `Checkpoint failed: ${errMsg}` };
  }
}

/**
 * List all woodbury-checkpoint stashes.
 */
export async function listCheckpoints(workDir: string): Promise<string[]> {
  if (!(await isGitRepo(workDir))) {
    return [];
  }

  try {
    const { stdout } = await execAsync('git stash list', {
      cwd: workDir,
      timeout: 5_000,
    });

    return stdout
      .split('\n')
      .filter(line => line.includes('woodbury-checkpoint:'))
      .map(line => line.trim());
  } catch {
    return [];
  }
}
