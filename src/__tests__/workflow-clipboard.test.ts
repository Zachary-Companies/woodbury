/**
 * Tests for the clipboard workflow step.
 *
 * The regression this guards: `navigator.clipboard.writeText()` returns a
 * PROMISE. Evaluating the bare call made the bridge request resolve
 * successfully even when the write was rejected (no document focus, permission
 * denied), so a try/catch around bridge.send() never saw the failure, the
 * execCommand fallback never ran, and a subsequent paste pasted whatever was
 * already on the clipboard.
 */

import { WorkflowExecutor } from '../workflow/executor';
import type { ClipboardStep } from '../workflow/types';

/** Reach the private step dispatcher without exporting it for tests only. */
function execClipboard(executor: WorkflowExecutor, step: ClipboardStep): Promise<void> {
  return (executor as any).execClipboard(step);
}

interface EvalCall {
  expression: string;
}

/**
 * Bridge stub whose `eval` mimics the content script: it resolves promises
 * before returning, so a rejected clipboard write comes back as `false`.
 */
function makeBridge(opts: { clipboardApiWorks: boolean; execCommandWorks?: boolean }) {
  const evals: EvalCall[] = [];
  const send = jest.fn(async (action: string, params?: any) => {
    if (action !== 'eval') return {};
    const expression: string = params.expression;
    evals.push({ expression });

    if (expression.includes('navigator.clipboard.writeText')) {
      // The real expression ends in `.then(() => true, () => false)`, so a
      // rejected write surfaces as the value `false`, not a thrown error.
      return { result: opts.clipboardApiWorks };
    }
    if (expression.includes('execCommand')) {
      return { result: opts.execCommandWorks ?? true };
    }
    return { result: null };
  });

  return { bridge: { send } as any, send, evals };
}

function makeExecutor(bridge: any) {
  const executor = new WorkflowExecutor(bridge, { variables: {} } as any);
  // Stub native input so no robotjs / real keystrokes are involved.
  const keyPress = jest.fn(async () => {});
  (executor as any).nativeKeyPress = keyPress;
  (executor as any).sleepMs = async () => {};
  return { executor, keyPress };
}

const step = (over: Partial<ClipboardStep> = {}): ClipboardStep =>
  ({ id: 's1', type: 'clipboard', label: 'copy', value: 'hello world', ...over } as ClipboardStep);

describe('clipboard step', () => {
  it('writes via the clipboard API and does not use the fallback', async () => {
    const { bridge, evals } = makeBridge({ clipboardApiWorks: true });
    const { executor } = makeExecutor(bridge);

    await execClipboard(executor, step());

    expect(evals).toHaveLength(1);
    expect(evals[0].expression).toContain('navigator.clipboard.writeText');
    expect(evals.some(e => e.expression.includes('execCommand'))).toBe(false);
  });

  it('resolves the promise in-page rather than returning it raw', async () => {
    // A bare `writeText(...)` expression serializes to {} and hides rejections.
    // The expression must settle to a boolean the caller can inspect.
    const { bridge, evals } = makeBridge({ clipboardApiWorks: true });
    const { executor } = makeExecutor(bridge);

    await execClipboard(executor, step());

    expect(evals[0].expression).toMatch(/\.then\(/);
  });

  it('falls back to execCommand when the clipboard API rejects', async () => {
    // This is the case that silently did nothing before: the bridge call
    // succeeded, so the catch block never fired.
    const { bridge, evals } = makeBridge({ clipboardApiWorks: false, execCommandWorks: true });
    const { executor } = makeExecutor(bridge);

    await execClipboard(executor, step());

    expect(evals).toHaveLength(2);
    expect(evals[1].expression).toContain('execCommand');
  });

  it('throws when both the API and the fallback fail', async () => {
    // Better a failed step than a silent no-op followed by pasting stale data.
    const { bridge } = makeBridge({ clipboardApiWorks: false, execCommandWorks: false });
    const { executor } = makeExecutor(bridge);

    await expect(execClipboard(executor, step())).rejects.toThrow(/failed to write to the clipboard/i);
  });

  it('does not paste when the clipboard could not be written', async () => {
    const { bridge } = makeBridge({ clipboardApiWorks: false, execCommandWorks: false });
    const { executor, keyPress } = makeExecutor(bridge);

    await expect(execClipboard(executor, step({ paste: true }))).rejects.toThrow();
    expect(keyPress).not.toHaveBeenCalled();
  });

  it('pastes with the platform modifier after a successful write', async () => {
    const { bridge } = makeBridge({ clipboardApiWorks: true });
    const { executor, keyPress } = makeExecutor(bridge);

    await execClipboard(executor, step({ paste: true }));

    expect(keyPress).toHaveBeenCalledTimes(1);
    const [key, mods] = keyPress.mock.calls[0] as any;
    expect(key).toBe('v');
    expect(mods).toEqual([process.platform === 'darwin' ? 'cmd' : 'ctrl']);
  });

  it('does not paste unless the step asks for it', async () => {
    const { bridge } = makeBridge({ clipboardApiWorks: true });
    const { executor, keyPress } = makeExecutor(bridge);

    await execClipboard(executor, step({ paste: false }));

    expect(keyPress).not.toHaveBeenCalled();
  });

  it('still falls back when the bridge call itself throws', async () => {
    const send = jest.fn(async (action: string, params?: any) => {
      if (params?.expression?.includes('navigator.clipboard')) throw new Error('bridge down');
      return { result: true };
    });
    const { executor } = makeExecutor({ send } as any);

    await expect(execClipboard(executor, step())).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('escapes the copied text so quotes cannot break the expression', async () => {
    const { bridge, evals } = makeBridge({ clipboardApiWorks: true });
    const { executor } = makeExecutor(bridge);

    await execClipboard(executor, step({ value: 'he said "hi"\nand \'bye\'' }));

    // JSON.stringify is what makes this safe; the raw text must not appear.
    expect(evals[0].expression).toContain(JSON.stringify('he said "hi"\nand \'bye\''));
  });

  it('treats an empty value as an empty string rather than undefined', async () => {
    const { bridge, evals } = makeBridge({ clipboardApiWorks: true });
    const { executor } = makeExecutor(bridge);

    await execClipboard(executor, step({ value: undefined }));

    expect(evals[0].expression).toContain('""');
  });
});
