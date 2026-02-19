import { GitOps } from '../git-ops';
import { exec } from 'child_process';

// Mock the child_process exec function
jest.mock('child_process');
const mockExec = exec as jest.MockedFunction<typeof exec>;

describe('GitOps', () => {
  let gitOps: GitOps;
  const testWorkDir = '/test/work';

  beforeEach(() => {
    gitOps = new GitOps(testWorkDir);
    jest.clearAllMocks();
  });

  describe('initialization', () => {
    it('should create a GitOps instance with working directory', () => {
      expect(gitOps).toBeInstanceOf(GitOps);
    });
  });

  describe('createCheckpoint', () => {
    it('should create a git stash checkpoint', async () => {
      // Mock successful stash creation
      (mockExec as any).mockImplementation((command: string, options: any, callback: Function) => {
        callback(null, {
          stdout: 'Saved working directory and index state WIP on main: abc123 Test commit',
          stderr: ''
        });
      });

      const result = await gitOps.createCheckpoint('test checkpoint');

      expect(result).toMatch(/^stash@\{\d+\}$/);
    });

    it('should handle git stash errors', async () => {
      (mockExec as any).mockImplementation((command: string, options: any, callback: Function) => {
        callback(null, {
          stdout: '',
          stderr: 'fatal: not a git repository'
        });
      });

      await expect(gitOps.createCheckpoint('test')).rejects.toThrow('Failed to create git checkpoint');
    });
  });

  describe('listCheckpoints', () => {
    it('should list available checkpoints', async () => {
      (mockExec as any).mockImplementation((command: string, options: any, callback: Function) => {
        callback(null, {
          stdout: 'stash@{0}: [woodbury-checkpoint] test checkpoint\nstash@{1}: [woodbury-checkpoint] another checkpoint',
          stderr: ''
        });
      });

      const result = await gitOps.listCheckpoints();

      expect(result).toHaveLength(2);
      expect(result[0]).toMatch(/^stash@\{0\}.*test checkpoint$/);
    });

    it('should return empty array when no checkpoints exist', async () => {
      (mockExec as any).mockImplementation((command: string, options: any, callback: Function) => {
        callback(null, {
          stdout: '',
          stderr: ''
        });
      });

      const result = await gitOps.listCheckpoints();
      expect(result).toEqual([]);
    });
  });

  describe('restoreCheckpoint', () => {
    it('should restore a specific checkpoint', async () => {
      (mockExec as any).mockImplementation((command: string, options: any, callback: Function) => {
        callback(null, {
          stdout: '',
          stderr: ''
        });
      });

      await gitOps.restoreCheckpoint('stash@{0}');
      // Should not throw
    });

    it('should handle restore errors', async () => {
      (mockExec as any).mockImplementation((command: string, options: any, callback: Function) => {
        callback(null, {
          stdout: '',
          stderr: 'error: Your local changes would be overwritten'
        });
      });

      await expect(gitOps.restoreCheckpoint('stash@{0}')).rejects.toThrow('Failed to restore checkpoint');
    });
  });

  describe('getCurrentBranch', () => {
    it('should return current branch name', async () => {
      (mockExec as any).mockImplementation((command: string, options: any, callback: Function) => {
        callback(null, {
          stdout: 'main\n',
          stderr: ''
        });
      });

      const result = await gitOps.getCurrentBranch();
      expect(result).toBe('main');
    });

    it('should handle detached HEAD state', async () => {
      (mockExec as any).mockImplementation((command: string, options: any, callback: Function) => {
        callback(null, {
          stdout: '',
          stderr: 'fatal: not a git repository'
        });
      });

      const result = await gitOps.getCurrentBranch();
      expect(result).toBe('HEAD');
    });
  });

  describe('getStatus', () => {
    it('should return git status information', async () => {
      (mockExec as any).mockImplementation((command: string, options: any, callback: Function) => {
        callback(null, {
          stdout: ' M src/test.ts\n?? new-file.ts\n',
          stderr: ''
        });
      });

      const result = await gitOps.getStatus();
      expect(result).toContain('M src/test.ts');
      expect(result).toContain('?? new-file.ts');
    });

    it('should return empty string for clean working directory', async () => {
      (mockExec as any).mockImplementation((command: string, options: any, callback: Function) => {
        callback(null, {
          stdout: '',
          stderr: ''
        });
      });

      const result = await gitOps.getStatus();
      expect(result).toBe('');
    });
  });

  describe('isRepository', () => {
    it('should return true for git repository', async () => {
      (mockExec as any).mockImplementation((command: string, options: any, callback: Function) => {
        callback(null, {
          stdout: '.git',
          stderr: ''
        });
      });

      const result = await gitOps.isRepository();
      expect(result).toBe(true);
    });

    it('should return false for non-git directory', async () => {
      (mockExec as any).mockImplementation((command: string, options: any, callback: Function) => {
        callback(new Error('Command failed'), null);
      });

      const result = await gitOps.isRepository();
      expect(result).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should handle command execution errors', async () => {
      (mockExec as any).mockImplementation((command: string, options: any, callback: Function) => {
        callback(new Error('Command failed'), null);
      });

      await expect(gitOps.getCurrentBranch()).rejects.toThrow();
    });
  });
});
