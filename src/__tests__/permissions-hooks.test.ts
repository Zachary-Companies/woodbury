/**
 * Tests for the graduated permission policy and the pre/post tool-use hook runner.
 *
 * Both are security boundaries, so the cases that matter most are the ones where
 * a failure mode silently ALLOWS something:
 *  - Prompt mode must not deny read-only tools (it ranked -1 and denied everything)
 *  - a hook that times out must DENY, not fall through to allowed
 *  - a hook that exits without draining stdin must not crash the process (EPIPE)
 */

import { PermissionPolicy, PermissionMode } from '../loop/permissions';
import { HookRunner } from '../loop/hooks';

const silentLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;

describe('PermissionPolicy', () => {
  describe('Prompt mode', () => {
    it('allows read-only tools without a prompter', async () => {
      // Prompt's rank is -1, so it can never satisfy the >= comparison used for
      // the other modes. Read-only has to be decided explicitly or every read
      // is denied — which made Prompt mode unusable.
      const policy = new PermissionPolicy({ mode: PermissionMode.Prompt, logger: silentLogger });

      for (const tool of ['file_read', 'list_directory', 'grep', 'pdf_read']) {
        const outcome = await policy.authorize(tool);
        expect(outcome).toEqual({ allowed: true });
      }
    });

    it('escalates non-read-only tools through the prompter', async () => {
      const prompter = jest.fn().mockResolvedValue({ allow: true, reason: 'user approved' });
      const policy = new PermissionPolicy({
        mode: PermissionMode.Prompt,
        prompter,
        logger: silentLogger,
      });

      const outcome = await policy.authorize('file_write');
      expect(outcome.allowed).toBe(true);
      expect(prompter).toHaveBeenCalledWith('file_write', PermissionMode.WorkspaceWrite, PermissionMode.Prompt);
    });

    it('denies when the user rejects the escalation', async () => {
      const prompter = jest.fn().mockResolvedValue({ allow: false, reason: 'nope' });
      const policy = new PermissionPolicy({
        mode: PermissionMode.Prompt,
        prompter,
        logger: silentLogger,
      });

      const outcome = await policy.authorize('shell_execute');
      expect(outcome.allowed).toBe(false);
      expect((outcome as any).reason).toBe('nope');
    });

    it('denies a write tool when no prompter is configured', async () => {
      const policy = new PermissionPolicy({ mode: PermissionMode.Prompt, logger: silentLogger });
      const outcome = await policy.authorize('shell_execute');
      expect(outcome.allowed).toBe(false);
    });
  });

  describe('rank comparison', () => {
    it('ReadOnly permits reads and refuses writes and shell', async () => {
      const policy = new PermissionPolicy({ mode: PermissionMode.ReadOnly, logger: silentLogger });
      expect((await policy.authorize('file_read')).allowed).toBe(true);
      expect((await policy.authorize('file_write')).allowed).toBe(false);
      expect((await policy.authorize('shell_execute')).allowed).toBe(false);
    });

    it('WorkspaceWrite permits reads and writes but refuses shell', async () => {
      const policy = new PermissionPolicy({ mode: PermissionMode.WorkspaceWrite, logger: silentLogger });
      expect((await policy.authorize('file_read')).allowed).toBe(true);
      expect((await policy.authorize('file_write')).allowed).toBe(true);
      expect((await policy.authorize('file_edit')).allowed).toBe(true);
      expect((await policy.authorize('shell_execute')).allowed).toBe(false);
    });

    it('FullAccess permits everything, including unknown tools', async () => {
      const policy = new PermissionPolicy({ mode: PermissionMode.FullAccess, logger: silentLogger });
      expect((await policy.authorize('shell_execute')).allowed).toBe(true);
      expect((await policy.authorize('some_unregistered_tool')).allowed).toBe(true);
    });

    it('treats unknown tools as FullAccess-required under a lower mode', async () => {
      const policy = new PermissionPolicy({ mode: PermissionMode.WorkspaceWrite, logger: silentLogger });
      expect((await policy.authorize('some_unregistered_tool')).allowed).toBe(false);
    });
  });

  describe('deny lists', () => {
    it('denies an explicitly listed tool even under FullAccess', async () => {
      const policy = new PermissionPolicy({
        mode: PermissionMode.FullAccess,
        denyList: ['shell_execute'],
        logger: silentLogger,
      });
      const outcome = await policy.authorize('shell_execute');
      expect(outcome.allowed).toBe(false);
      expect((outcome as any).reason).toMatch(/deny list/);
    });

    it('denies by prefix even under FullAccess', async () => {
      const policy = new PermissionPolicy({
        mode: PermissionMode.FullAccess,
        denyPrefixes: ['social_'],
        logger: silentLogger,
      });
      expect((await policy.authorize('social_post')).allowed).toBe(false);
      expect((await policy.authorize('file_read')).allowed).toBe(true);
    });

    it('records every decision in the audit trail', async () => {
      const policy = new PermissionPolicy({
        mode: PermissionMode.ReadOnly,
        denyList: ['git'],
        logger: silentLogger,
      });
      await policy.authorize('file_read');
      await policy.authorize('file_write');
      await policy.authorize('git');

      const decisions = policy.getDecisions();
      expect(decisions).toHaveLength(3);
      expect(decisions.map(d => d.decision)).toEqual(['allow', 'deny', 'deny']);
    });
  });
});

describe('HookRunner', () => {
  const runner = (pre: string[], timeoutMs = 10000) =>
    new HookRunner({ preToolUse: pre, timeoutMs }, silentLogger);

  it('allows when no hooks are configured', async () => {
    const r = new HookRunner({}, silentLogger);
    await expect(r.runPreToolUse('file_read', {})).resolves.toEqual({ allowed: true });
  });

  it('allows on exit 0', async () => {
    const result = await runner(['exit 0']).runPreToolUse('file_read', {});
    expect(result.allowed).toBe(true);
  });

  it('denies on exit 2 and surfaces stdout as the reason', async () => {
    const result = await runner(['echo "blocked by policy"; exit 2']).runPreToolUse('shell_execute', {});
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('blocked by policy');
  });

  it('allows but warns on other non-zero exits', async () => {
    const result = await runner(['echo warn; exit 3']).runPreToolUse('file_read', {});
    expect(result.allowed).toBe(true);
  });

  it('DENIES when a hook exceeds its timeout', async () => {
    // A policy hook killed by the timeout never rendered a verdict. Treating
    // that as "allowed" lets a hung deny hook wave through the tool it was
    // meant to block, so the timeout must fail closed.
    const result = await runner(['sleep 5'], 300).runPreToolUse('shell_execute', {});
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/timed out/i);
  }, 15000);

  it('does not crash when a hook exits without reading stdin', async () => {
    // Writing the payload to a closed pipe raises EPIPE on child.stdin, which
    // is a different emitter from the ChildProcess — with no listener there,
    // Node turns it into an uncaught exception and kills the agent.
    const uncaught = jest.fn();
    process.on('uncaughtException', uncaught);
    try {
      const bigInput = { blob: 'x'.repeat(500_000) };
      const result = await runner(['exit 2']).runPreToolUse('file_write', bigInput);
      expect(result.allowed).toBe(false);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.off('uncaughtException', uncaught);
    }
  }, 15000);

  it('stops at the first denying hook', async () => {
    const result = await runner(['exit 0', 'exit 2', 'exit 0']).runPreToolUse('file_write', {});
    expect(result.allowed).toBe(false);
  });

  it('passes tool context to the hook via environment', async () => {
    const result = await runner(['test "$HOOK_TOOL_NAME" = "file_write" || exit 2'])
      .runPreToolUse('file_write', { path: 'a.txt' });
    expect(result.allowed).toBe(true);
  });

  it('fails open when the hook command cannot be spawned', async () => {
    // A malformed command is an operator error, not a policy verdict; the shell
    // reports it as a normal non-zero exit rather than a deny.
    const result = await runner(['this-command-does-not-exist-xyz']).runPreToolUse('file_read', {});
    expect(result.allowed).toBe(true);
  });

  it('post-tool hooks never block and swallow their own failures', async () => {
    const r = new HookRunner({ postToolUse: ['exit 2', 'this-does-not-exist-xyz'] }, silentLogger);
    await expect(
      r.runPostToolUse('file_read', {}, 'output', false)
    ).resolves.toBeUndefined();
  }, 15000);
});
