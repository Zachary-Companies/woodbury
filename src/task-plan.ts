import { access, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { resolve, isAbsolute, join } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition, ToolHandler, ToolContext } from './loop/index.js';

const execAsync = promisify(exec);
const MAX_OUTPUT = 4000;

// ── Validator types ───────────────────────────────────────────

export interface TaskValidator {
  type: 'file_exists' | 'file_contains' | 'command_succeeds' | 'command_output_matches' | 'test_file';
  /** File path (relative to working directory or absolute). */
  path?: string;
  /** Regex pattern. Used by file_contains, command_output_matches. */
  pattern?: string;
  /** Shell command. Used by command_succeeds, command_output_matches, and optionally test_file. */
  command?: string;
}

interface ValidatorResult {
  passed: boolean;
  message: string;
  /** Raw output from test/command execution — included so the LLM can diagnose failures. */
  output?: string;
}

// ── Task types ────────────────────────────────────────────────

export interface PlanTask {
  id: number;
  subject: string;
  description: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  blockedBy: number[];
  blocks: number[];
  validators: TaskValidator[];
  blockedReason?: string;
  maxRetries: number;
  retryCount: number;
  failureHistory: string[];
  toolCallBudget: number;
  toolCallsUsed: number;
}

export interface PlanState {
  tasks: PlanTask[];
}

// ── Tool definitions ──────────────────────────────────────────

export const taskCreateDefinition: ToolDefinition = {
  name: 'task_create',
  description:
    'Create a new task to track work. Every task requires at least one validator. '
    + 'For any task involving code, you MUST include a "test_file" validator — write the test first, then implement.',
  parameters: [
    {
      name: 'subject',
      type: 'string',
      description: 'Brief imperative title, e.g. "Fix authentication bug in login flow"',
      required: true,
    },
    {
      name: 'description',
      type: 'string',
      description: 'Detailed description of what needs to be done, including context and acceptance criteria',
      required: true,
    },
    {
      name: 'activeForm',
      type: 'string',
      description: 'Present continuous label shown while task is in_progress, e.g. "Fixing authentication bug"',
      required: false,
    },
    {
      name: 'validators',
      type: 'array',
      description:
        'Required. At least one acceptance criterion. Each is an object with "type" and type-specific fields:\n'
        + '- { "type": "test_file", "path": "src/__tests__/utils.test.ts" } — PREFERRED for code tasks. The test file must exist and all tests in it must pass. Optionally add "command" to override the test runner (default: npx jest).\n'
        + '- { "type": "file_exists", "path": "src/foo.ts" } — file must exist\n'
        + '- { "type": "file_contains", "path": "src/foo.ts", "pattern": "export function bar" } — file must match regex\n'
        + '- { "type": "command_succeeds", "command": "npm run build" } — command must exit 0\n'
        + '- { "type": "command_output_matches", "command": "npm test", "pattern": "passed" } — output must match regex',
      required: true,
    },
    {
      name: 'maxRetries',
      type: 'number',
      description: 'Maximum validation retries before auto-blocking (default: 3)',
      required: false,
    },
    {
      name: 'toolCallBudget',
      type: 'number',
      description: 'Maximum tool calls allowed for this task (default: 50). Increase for complex tasks, decrease for simple ones.',
      required: false,
    },
  ],
  dangerous: false,
};

export const taskUpdateDefinition: ToolDefinition = {
  name: 'task_update',
  description:
    'Update a task. Set status to "in_progress" when starting work, "completed" when done, "blocked" when stuck, or "deleted" to remove it. '
    + 'Setting status to "completed" automatically runs all validators — the test file is executed and must pass. Completion is rejected if any validator fails. '
    + 'After max retries, the task is auto-blocked.',
  parameters: [
    {
      name: 'taskId',
      type: 'number',
      description: 'The task ID to update',
      required: true,
    },
    {
      name: 'status',
      type: 'string',
      description: 'New status: "pending", "in_progress", "completed", "blocked", or "deleted"',
      required: false,
    },
    {
      name: 'subject',
      type: 'string',
      description: 'New subject for the task',
      required: false,
    },
    {
      name: 'description',
      type: 'string',
      description: 'New description for the task',
      required: false,
    },
    {
      name: 'activeForm',
      type: 'string',
      description: 'New spinner label',
      required: false,
    },
    {
      name: 'blockedReason',
      type: 'string',
      description: 'Required when setting status to "blocked". Explains why the task cannot proceed.',
      required: false,
    },
    {
      name: 'addBlocks',
      type: 'array',
      description: 'Task IDs that cannot start until this task completes',
      required: false,
    },
    {
      name: 'addBlockedBy',
      type: 'array',
      description: 'Task IDs that must complete before this task can start',
      required: false,
    },
  ],
  dangerous: false,
};

export const taskListDefinition: ToolDefinition = {
  name: 'task_list',
  description:
    'List all tasks with their status. Use after completing a task to check progress and find the next task to work on.',
  parameters: [],
  dangerous: false,
};

export const taskGetDefinition: ToolDefinition = {
  name: 'task_get',
  description:
    'Get full details of a specific task including description, dependencies, and validators.',
  parameters: [
    {
      name: 'taskId',
      type: 'number',
      description: 'The task ID to retrieve',
      required: true,
    },
  ],
  dangerous: false,
};

// ── Validator execution ───────────────────────────────────────

function resolvePath(p: string, cwd: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

function truncateOutput(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return s.slice(0, MAX_OUTPUT) + `\n... (truncated, ${s.length} chars total)`;
}

async function runValidator(v: TaskValidator, cwd: string): Promise<ValidatorResult> {
  switch (v.type) {
    case 'file_exists': {
      if (!v.path) return { passed: false, message: 'file_exists: missing "path"' };
      try {
        await access(resolvePath(v.path, cwd));
        return { passed: true, message: `✓ File exists: ${v.path}` };
      } catch {
        return { passed: false, message: `✗ File not found: ${v.path}` };
      }
    }

    case 'file_contains': {
      if (!v.path || !v.pattern)
        return { passed: false, message: 'file_contains: missing "path" or "pattern"' };
      try {
        const content = await readFile(resolvePath(v.path, cwd), 'utf-8');
        if (new RegExp(v.pattern).test(content)) {
          return { passed: true, message: `✓ File "${v.path}" contains /${v.pattern}/` };
        }
        return { passed: false, message: `✗ File "${v.path}" does not contain /${v.pattern}/` };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { passed: false, message: `✗ file_contains error: ${msg}` };
      }
    }

    case 'command_succeeds': {
      if (!v.command)
        return { passed: false, message: 'command_succeeds: missing "command"' };
      try {
        const { stdout, stderr } = await execAsync(v.command, { cwd, timeout: 120_000 });
        const output = truncateOutput((stdout + stderr).trim());
        return { passed: true, message: `✓ Command succeeded: ${v.command}`, output };
      } catch (err: unknown) {
        const output = truncateOutput(
          err instanceof Error && 'stdout' in err
            ? String((err as any).stdout ?? '') + String((err as any).stderr ?? '')
            : String(err),
        );
        return { passed: false, message: `✗ Command failed: ${v.command}`, output };
      }
    }

    case 'command_output_matches': {
      if (!v.command || !v.pattern)
        return { passed: false, message: 'command_output_matches: missing "command" or "pattern"' };
      try {
        const { stdout, stderr } = await execAsync(v.command, { cwd, timeout: 120_000 });
        const output = (stdout + stderr).trim();
        if (new RegExp(v.pattern).test(output)) {
          return { passed: true, message: `✓ Output of "${v.command}" matches /${v.pattern}/`, output: truncateOutput(output) };
        }
        return { passed: false, message: `✗ Output of "${v.command}" does not match /${v.pattern}/`, output: truncateOutput(output) };
      } catch (err: unknown) {
        const output = truncateOutput(
          err instanceof Error && 'stdout' in err
            ? String((err as any).stdout ?? '') + String((err as any).stderr ?? '')
            : String(err),
        );
        return { passed: false, message: `✗ Command error: ${v.command}`, output };
      }
    }

    case 'test_file': {
      if (!v.path)
        return { passed: false, message: 'test_file: missing "path"' };

      const fullPath = resolvePath(v.path, cwd);

      // Step 1: Test file must exist
      try {
        const s = await stat(fullPath);
        if (!s.isFile()) {
          return { passed: false, message: `✗ Test file is not a regular file: ${v.path}` };
        }
      } catch {
        return { passed: false, message: `✗ Test file not found: ${v.path}. Write the test file FIRST before implementing.` };
      }

      // Step 2: Test file must not be empty
      try {
        const content = await readFile(fullPath, 'utf-8');
        if (content.trim().length < 20) {
          return { passed: false, message: `✗ Test file is empty or trivial: ${v.path}. Write real assertions.` };
        }
        // Step 3: Must contain at least one assertion keyword
        if (!/\b(expect|assert|should|test|it|describe)\b/.test(content)) {
          return { passed: false, message: `✗ Test file "${v.path}" contains no recognizable test assertions (expect, assert, test, it, describe). Write real tests.` };
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { passed: false, message: `✗ Cannot read test file: ${msg}` };
      }

      // Step 4: Run the test
      const runner = v.command || 'npx jest --no-coverage --forceExit';
      const cmd = `${runner} "${v.path}"`;
      try {
        const { stdout, stderr } = await execAsync(cmd, { cwd, timeout: 120_000 });
        const output = (stdout + stderr).trim();
        return {
          passed: true,
          message: `✓ Tests passed: ${v.path}`,
          output: truncateOutput(output),
        };
      } catch (err: unknown) {
        const raw = err instanceof Error && 'stdout' in err
          ? String((err as any).stdout ?? '') + String((err as any).stderr ?? '')
          : String(err);
        const output = truncateOutput(raw.trim());
        return {
          passed: false,
          message: `✗ Tests failed: ${v.path}`,
          output,
        };
      }
    }

    default:
      return { passed: false, message: `Unknown validator type: ${(v as TaskValidator).type}` };
  }
}

async function runValidators(
  validators: TaskValidator[],
  cwd: string,
): Promise<{ allPassed: boolean; report: string }> {
  const results: ValidatorResult[] = [];
  for (const v of validators) {
    results.push(await runValidator(v, cwd));
  }

  const lines: string[] = [];
  for (const r of results) {
    lines.push(r.message);
    if (r.output) {
      lines.push('```');
      lines.push(r.output);
      lines.push('```');
    }
  }

  return {
    allPassed: results.every((r) => r.passed),
    report: lines.join('\n'),
  };
}

// ── State & handlers ──────────────────────────────────────────

// ── Disk persistence ──────────────────────────────────────

interface PersistedPlan {
  state: PlanState;
  nextId: number;
  completedCount: number;
}

function planFilePath(workDir: string): string {
  return join(workDir, '.woodbury-work', 'plan.json');
}

export async function loadPlanState(workDir: string): Promise<PersistedPlan | null> {
  try {
    const raw = await readFile(planFilePath(workDir), 'utf-8');
    const parsed = JSON.parse(raw) as PersistedPlan;
    if (parsed.state && Array.isArray(parsed.state.tasks)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function savePlanState(
  workDir: string,
  state: PlanState,
  nextId: number,
  completedCount: number,
): Promise<void> {
  const dir = join(workDir, '.woodbury-work');
  await mkdir(dir, { recursive: true });
  const data: PersistedPlan = { state, nextId, completedCount };
  await writeFile(planFilePath(workDir), JSON.stringify(data, null, 2), 'utf-8');
}

// ── TaskToolsHandle ───────────────────────────────────────

export interface TaskToolsHandle {
  createHandler: ToolHandler;
  updateHandler: ToolHandler;
  listHandler: ToolHandler;
  getHandler: ToolHandler;
  resetPlan: () => void;
  getPlanState: () => PlanState;
  trackToolCall: () => { blocked: boolean; taskId?: number; message?: string };
  loadOrReset: (workingDirectory: string) => Promise<void>;
}

const TASK_TOOL_NAMES = new Set([
  'task_create',
  'task_update',
  'task_list',
  'task_get',
]);

export function isTaskTool(name: string): boolean {
  return TASK_TOOL_NAMES.has(name);
}

function remainingCount(state: PlanState): number {
  return state.tasks.filter(
    (t) => t.status === 'pending' || t.status === 'in_progress' || t.status === 'blocked',
  ).length;
}

function completionWarning(state: PlanState): string {
  if (state.tasks.length === 0) return '';

  const remaining = remainingCount(state);
  const blockedTasks = state.tasks.filter((t) => t.status === 'blocked');
  const actionable = state.tasks.filter(
    (t) => t.status === 'pending' || t.status === 'in_progress',
  ).length;

  if (remaining > 0) {
    const parts: string[] = [];

    if (blockedTasks.length > 0) {
      parts.push(`\n🚫 ${blockedTasks.length} blocked task(s):`);
      for (const t of blockedTasks) {
        parts.push(`  - #${t.id} "${t.subject}": ${t.blockedReason ?? 'no reason given'}`);
      }
    }

    if (actionable > 0) {
      const next = state.tasks.find((t) => t.status === 'pending');
      parts.push(`\n⚠ ${actionable} actionable task(s) remaining. Do NOT give a final answer yet.`);
      if (next) {
        parts.push(`→ Next: task #${next.id} "${next.subject}" — mark it in_progress and begin work.`);
      }
    } else if (blockedTasks.length > 0) {
      parts.push(`\n⚠ All remaining tasks are blocked. Give a final_answer explaining the blockers.`);
    }

    return parts.join('\n');
  }
  return '\n✓ All tasks complete. You may now give your final answer.';
}

const VALID_TYPES = ['file_exists', 'file_contains', 'command_succeeds', 'command_output_matches', 'test_file'];

function parseValidators(raw: unknown): TaskValidator[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is Record<string, unknown> => v != null && typeof v === 'object')
    .map((v) => ({
      type: String(v.type ?? '') as TaskValidator['type'],
      path: v.path != null ? String(v.path) : undefined,
      pattern: v.pattern != null ? String(v.pattern) : undefined,
      command: v.command != null ? String(v.command) : undefined,
    }))
    .filter((v) => VALID_TYPES.includes(v.type));
}

export function createTaskTools(
  onPlanChange?: (state: PlanState) => void,
  onTaskCompleted?: (task: PlanTask, validationReport: string) => void,
  workingDirectory?: string,
): TaskToolsHandle {
  let state: PlanState = { tasks: [] };
  let nextId = 1;
  let completedCount = 0;
  let workDir = workingDirectory;

  const notify = () => {
    if (onPlanChange) onPlanChange(state);
    // Persist to disk (fire-and-forget)
    if (workDir) {
      savePlanState(workDir, state, nextId, completedCount).catch(() => {});
    }
  };

  // ── task_create ──

  const createHandler: ToolHandler = async (params) => {
    const subject = params.subject as string;
    const description = params.description as string;
    const activeForm = params.activeForm as string | undefined;
    const validators = parseValidators(params.validators);
    const maxRetries = typeof params.maxRetries === 'number' && params.maxRetries > 0
      ? params.maxRetries
      : 3;
    const toolCallBudget = typeof params.toolCallBudget === 'number' && params.toolCallBudget > 0
      ? params.toolCallBudget
      : 50;

    if (!subject || !description) {
      return 'Error: "subject" and "description" are required.';
    }

    if (validators.length === 0) {
      return (
        'Error: At least one validator is required. Every task must have a verifiable acceptance criterion.\n'
        + 'For code tasks, use { "type": "test_file", "path": "<test-file-path>" } — write the test FIRST, then implement.\n'
        + 'For non-code tasks, use file_exists, file_contains, command_succeeds, or command_output_matches.'
      );
    }

    const task: PlanTask = {
      id: nextId++,
      subject,
      description,
      activeForm,
      status: 'pending',
      blockedBy: [],
      blocks: [],
      validators,
      maxRetries,
      retryCount: 0,
      failureHistory: [],
      toolCallBudget,
      toolCallsUsed: 0,
    };
    state.tasks.push(task);
    notify();

    const hasTestFile = validators.some((v) => v.type === 'test_file');
    const validatorNote = `\n  ${validators.length} validator(s) attached${hasTestFile ? ' (includes test_file — write the test FIRST)' : ''}.`;
    return `Task #${task.id} created: "${task.subject}"${validatorNote}${completionWarning(state)}`;
  };

  // ── task_update ──

  const updateHandler: ToolHandler = async (params, context) => {
    const taskId = params.taskId as number;
    if (taskId == null) return 'Error: "taskId" is required.';

    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) {
      const ids = state.tasks.map((t) => t.id).join(', ');
      return `Error: No task with ID ${taskId}. Valid IDs: ${ids || 'none'}`;
    }

    const newStatus = params.status as string | undefined;
    if (newStatus) {
      if (newStatus === 'deleted') {
        state.tasks = state.tasks.filter((t) => t.id !== taskId);
        for (const t of state.tasks) {
          t.blockedBy = t.blockedBy.filter((id) => id !== taskId);
          t.blocks = t.blocks.filter((id) => id !== taskId);
        }
        notify();
        return `Task #${taskId} deleted.${completionWarning(state)}`;
      }

      const valid = ['pending', 'in_progress', 'completed', 'blocked'];
      if (!valid.includes(newStatus)) {
        return `Error: Invalid status "${newStatus}". Use: ${valid.join(', ')}, or "deleted".`;
      }

      // ── Blocked handling ──
      if (newStatus === 'blocked') {
        const blockedReason = params.blockedReason as string | undefined;
        if (!blockedReason) {
          return 'Error: "blockedReason" is required when setting status to "blocked".';
        }
        task.status = 'blocked';
        task.blockedReason = blockedReason;
        notify();
        return (
          `Task #${taskId} blocked: ${blockedReason}`
          + `\n\nGive a final_answer explaining what is blocked and what you need from the user.`
          + completionWarning(state)
        );
      }

      // ── Unblocking: blocked → in_progress/pending ──
      if (task.status === 'blocked' && (newStatus === 'in_progress' || newStatus === 'pending')) {
        task.blockedReason = undefined;
      }

      // ── Gate completion on validators ──
      if (newStatus === 'completed' && task.validators.length > 0) {
        const { allPassed, report } = await runValidators(
          task.validators,
          context.workingDirectory,
        );
        if (!allPassed) {
          task.retryCount++;
          task.failureHistory.push(report);

          if (task.retryCount >= task.maxRetries) {
            task.status = 'blocked';
            task.blockedReason = `Auto-blocked after ${task.maxRetries} failed validation attempts.`;
            notify();
            return (
              `⛔ Cannot complete task #${taskId} — validation failed (attempt ${task.retryCount}/${task.maxRetries}):\n\n${report}`
              + `\n\n🚫 Max retries reached. Task auto-blocked: ${task.blockedReason}`
              + `\nGive a final_answer explaining the blocker and what you need from the user.`
              + completionWarning(state)
            );
          }

          notify();
          return (
            `⛔ Cannot complete task #${taskId} — validation failed (attempt ${task.retryCount}/${task.maxRetries}):\n\n${report}`
            + `\n\nTask remains in_progress. ${task.maxRetries - task.retryCount} retries remaining. Fix the failing checks and try again.`
            + `\n\n💡 Validation failed. Consider calling \`reflect\` to reassess your approach.`
          );
        }
        task.status = 'completed';
        completedCount++;
        notify();
        onTaskCompleted?.(task, report);
        let result = `Task #${taskId} completed — all validators passed:\n\n${report}`
          + completionWarning(state);
        if (completedCount % 3 === 0) {
          result += `\n\n💡 You have completed ${completedCount} tasks. Consider calling \`reflect\` to assess progress.`;
        }
        return result;
      }

      task.status = newStatus as PlanTask['status'];
    }

    if (params.subject) task.subject = params.subject as string;
    if (params.description) task.description = params.description as string;
    if (params.activeForm) task.activeForm = params.activeForm as string;

    if (Array.isArray(params.addBlocks)) {
      for (const id of params.addBlocks as number[]) {
        if (!task.blocks.includes(id)) task.blocks.push(id);
        const blocked = state.tasks.find((t) => t.id === id);
        if (blocked && !blocked.blockedBy.includes(taskId)) {
          blocked.blockedBy.push(taskId);
        }
      }
    }

    if (Array.isArray(params.addBlockedBy)) {
      for (const id of params.addBlockedBy as number[]) {
        if (!task.blockedBy.includes(id)) task.blockedBy.push(id);
        const blocker = state.tasks.find((t) => t.id === id);
        if (blocker && !blocker.blocks.includes(taskId)) {
          blocker.blocks.push(taskId);
        }
      }
    }

    notify();
    return `Task #${taskId} updated → ${task.status}${completionWarning(state)}`;
  };

  // ── task_list ──

  const listHandler: ToolHandler = async () => {
    if (state.tasks.length === 0) return 'No tasks exist.';

    const icons: Record<PlanTask['status'], string> = {
      pending: '○',
      in_progress: '▶',
      completed: '✓',
      blocked: '⊘',
    };

    const lines = state.tasks.map((t) => {
      const openBlockers = t.blockedBy.filter((id) => {
        const b = state.tasks.find((bt) => bt.id === id);
        return b && b.status !== 'completed';
      });
      const blockedStr =
        openBlockers.length > 0
          ? ` (blocked by: #${openBlockers.join(', #')})`
          : '';
      const vCount = t.validators.length;
      const hasTest = t.validators.some((v) => v.type === 'test_file');
      const validatorStr = vCount > 0
        ? ` [${vCount} validator${vCount > 1 ? 's' : ''}${hasTest ? ', test_file' : ''}]`
        : '';
      const retryStr = t.retryCount > 0 ? ` (retries: ${t.retryCount}/${t.maxRetries})` : '';
      const budgetStr = t.toolCallsUsed > 0 ? ` (calls: ${t.toolCallsUsed}/${t.toolCallBudget})` : '';
      const reasonStr = t.status === 'blocked' && t.blockedReason
        ? ` — ${t.blockedReason}`
        : '';
      return `  ${icons[t.status]} #${t.id}. ${t.subject} [${t.status}]${blockedStr}${validatorStr}${retryStr}${budgetStr}${reasonStr}`;
    });

    const done = state.tasks.filter((t) => t.status === 'completed').length;
    const total = state.tasks.length;
    lines.push(`\nProgress: ${done}/${total} complete`);
    lines.push(completionWarning(state));

    return lines.join('\n');
  };

  // ── task_get ──

  const getHandler: ToolHandler = async (params) => {
    const taskId = params.taskId as number;
    if (taskId == null) return 'Error: "taskId" is required.';

    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) {
      return `Error: No task with ID ${taskId}.`;
    }

    const lines = [
      `Task #${task.id}`,
      `Subject: ${task.subject}`,
      `Status: ${task.status}`,
      `Description: ${task.description}`,
    ];
    if (task.activeForm) lines.push(`Active form: ${task.activeForm}`);
    if (task.blockedReason) lines.push(`Blocked reason: ${task.blockedReason}`);
    if (task.retryCount > 0) lines.push(`Retries: ${task.retryCount}/${task.maxRetries}`);
    lines.push(`Tool calls: ${task.toolCallsUsed}/${task.toolCallBudget}`);
    if (task.blockedBy.length > 0)
      lines.push(`Blocked by: #${task.blockedBy.join(', #')}`);
    if (task.blocks.length > 0)
      lines.push(`Blocks: #${task.blocks.join(', #')}`);
    if (task.validators.length > 0) {
      lines.push(`Validators (${task.validators.length}):`);
      for (const v of task.validators) {
        if (v.type === 'test_file') lines.push(`  - test_file: ${v.path}${v.command ? ` (runner: ${v.command})` : ''}`);
        else if (v.type === 'file_exists') lines.push(`  - file_exists: ${v.path}`);
        else if (v.type === 'file_contains') lines.push(`  - file_contains: ${v.path} /${v.pattern}/`);
        else if (v.type === 'command_succeeds') lines.push(`  - command_succeeds: ${v.command}`);
        else if (v.type === 'command_output_matches') lines.push(`  - command_output_matches: ${v.command} /${v.pattern}/`);
      }
    }
    if (task.failureHistory.length > 0) {
      lines.push(`Last failure:\n${task.failureHistory[task.failureHistory.length - 1]}`);
    }

    return lines.join('\n');
  };

  // ── per-step budget tracking ──

  const trackToolCall = (): { blocked: boolean; taskId?: number; message?: string } => {
    const active = state.tasks.find((t) => t.status === 'in_progress');
    if (!active) return { blocked: false };

    active.toolCallsUsed++;
    if (active.toolCallsUsed >= active.toolCallBudget) {
      active.status = 'blocked';
      active.blockedReason = `Tool call budget exhausted (${active.toolCallsUsed}/${active.toolCallBudget}). Break this task into smaller tasks or increase the budget.`;
      notify();
      return {
        blocked: true,
        taskId: active.id,
        message: `⛔ Task #${active.id} auto-blocked: tool call budget exhausted (${active.toolCallsUsed}/${active.toolCallBudget}). Break the task into smaller pieces or create a new task with a larger budget.`,
      };
    }
    return { blocked: false, taskId: active.id };
  };

  // ── lifecycle ──

  const resetPlan = () => {
    state = { tasks: [] };
    nextId = 1;
    completedCount = 0;
  };

  const getPlanState = () => state;

  const loadOrReset = async (wd: string): Promise<void> => {
    workDir = wd;
    const persisted = await loadPlanState(wd);
    if (persisted && persisted.state.tasks.length > 0) {
      state = persisted.state;
      nextId = persisted.nextId;
      completedCount = persisted.completedCount;
      notify();
    } else {
      resetPlan();
    }
  };

  return {
    createHandler,
    updateHandler,
    listHandler,
    getHandler,
    resetPlan,
    getPlanState,
    trackToolCall,
    loadOrReset,
  };
}
