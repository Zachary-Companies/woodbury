import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { isGitRepo, createCheckpoint, listCheckpoints } from '../src/git-checkpoint.js';

const execAsync = promisify(exec);

describe('git-checkpoint', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-gitcp-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('isGitRepo returns false for non-git dir', async () => {
    expect(await isGitRepo(tmpDir)).toBe(false);
  });

  it('isGitRepo returns true for git-initialized dir', async () => {
    await execAsync('git init', { cwd: tmpDir });
    expect(await isGitRepo(tmpDir)).toBe(true);
  });

  it('createCheckpoint returns null for non-git dir', async () => {
    const result = await createCheckpoint(tmpDir, 'test');
    expect(result.ref).toBeNull();
    expect(result.message).toContain('Not a git repository');
  });

  it('createCheckpoint returns null for clean tree', async () => {
    await execAsync('git init', { cwd: tmpDir });
    await execAsync('git config user.email "test@test.com"', { cwd: tmpDir });
    await execAsync('git config user.name "Test"', { cwd: tmpDir });

    // Create an initial commit so tree is clean
    await writeFile(join(tmpDir, 'init.txt'), 'init');
    await execAsync('git add . && git commit -m "init"', { cwd: tmpDir });

    const result = await createCheckpoint(tmpDir, 'test reason');
    expect(result.ref).toBeNull();
    expect(result.message).toContain('clean');
  });

  it('createCheckpoint creates stash with woodbury-checkpoint prefix', async () => {
    await execAsync('git init', { cwd: tmpDir });
    await execAsync('git config user.email "test@test.com"', { cwd: tmpDir });
    await execAsync('git config user.name "Test"', { cwd: tmpDir });

    // Create initial commit
    await writeFile(join(tmpDir, 'init.txt'), 'init');
    await execAsync('git add . && git commit -m "init"', { cwd: tmpDir });

    // Make a dirty change to a TRACKED file (git stash create needs tracked changes)
    await writeFile(join(tmpDir, 'init.txt'), 'modified content');

    const result = await createCheckpoint(tmpDir, 'risky delete');
    expect(result.ref).toBeTruthy();
    expect(result.message).toContain('Checkpoint created');

    // Verify the stash was stored
    const { stdout } = await execAsync('git stash list', { cwd: tmpDir });
    expect(stdout).toContain('woodbury-checkpoint: risky delete');
  });

  it('listCheckpoints returns only woodbury-prefixed stashes', async () => {
    await execAsync('git init', { cwd: tmpDir });
    await execAsync('git config user.email "test@test.com"', { cwd: tmpDir });
    await execAsync('git config user.name "Test"', { cwd: tmpDir });

    // Create initial commit
    await writeFile(join(tmpDir, 'init.txt'), 'init');
    await execAsync('git add . && git commit -m "init"', { cwd: tmpDir });

    // Create a dirty change to a tracked file and checkpoint
    await writeFile(join(tmpDir, 'init.txt'), 'modified for checkpoint');
    await createCheckpoint(tmpDir, 'first checkpoint');

    const cps = await listCheckpoints(tmpDir);
    expect(cps.length).toBeGreaterThanOrEqual(1);
    expect(cps[0]).toContain('woodbury-checkpoint:');
  });

  it('listCheckpoints returns empty for non-git dir', async () => {
    const cps = await listCheckpoints(tmpDir);
    expect(cps).toEqual([]);
  });
});
