/**
 * Workflow Executor
 *
 * Runs workflow steps sequentially, calling the bridge server for
 * browser interactions. Handles variable substitution, precondition
 * checks, postcondition verification, retries, and progress reporting.
 */

import { promises as fs, appendFileSync, mkdirSync } from 'fs';
import { resolve as pathResolve, dirname, join, basename } from 'path';
import { homedir } from 'os';

// Execution log — writes to ~/.woodbury/logs/execution.log
const _EXEC_LOG_DIR = join(homedir(), '.woodbury', 'logs');
const _EXEC_LOG_PATH = join(_EXEC_LOG_DIR, 'execution.log');
function execLog(level: string, msg: string, data?: any): void {
  try {
    mkdirSync(_EXEC_LOG_DIR, { recursive: true });
    const ts = new Date().toISOString();
    let line = `[${ts}] [EXEC:${level}] ${msg}`;
    if (data !== undefined) {
      try { line += ' ' + JSON.stringify(data); } catch { line += ' [unserializable]'; }
    }
    appendFileSync(_EXEC_LOG_PATH, line + '\n');
  } catch { /* never break executor */ }
}

import type {
  WorkflowDocument,
  WorkflowStep,
  ExecutionOptions,
  ExecutionResult,
  StepResult,
  ExecutionProgressEvent,
  BridgeInterface,
  NavigateStep,
  ClickStep,
  TypeStep,
  WaitStep,
  AssertStep,
  DownloadStep,
  CaptureDownloadStep,
  MoveFileStep,
  ScrollStep,
  KeyboardStep,
  SubWorkflowStep,
  ConditionalStep,
  LoopStep,
  TryCatchStep,
  SetVariableStep,
  Precondition,
  Postcondition,
} from './types.js';
import { substituteObject } from './variable-sub.js';
import { ElementResolver } from './resolver.js';
import { ConditionValidator } from './validator.js';

export class WorkflowExecutor {
  private resolver: ElementResolver;
  private validator: ConditionValidator;
  private variables: Record<string, unknown>;
  private signal?: AbortSignal;
  private onProgress?: (event: ExecutionProgressEvent) => void;
  private stopOnFailure: boolean;
  private workflowDir?: string;

  constructor(
    private bridge: BridgeInterface,
    options: ExecutionOptions
  ) {
    this.resolver = new ElementResolver(bridge);
    this.validator = new ConditionValidator(bridge);
    this.variables = { ...options.variables };
    this.signal = options.signal;
    this.onProgress = options.onProgress;
    this.stopOnFailure = options.stopOnFailure ?? true;
  }

  /**
   * Execute a workflow document.
   */
  async execute(workflow: WorkflowDocument): Promise<ExecutionResult> {
    const startTime = Date.now();

    // Truncate execution log for clean diagnosis
    try {
      mkdirSync(_EXEC_LOG_DIR, { recursive: true });
      const { writeFileSync } = await import('fs');
      writeFileSync(_EXEC_LOG_PATH, '');
    } catch { /* ignore */ }

    execLog('INFO', `=== Workflow execution start: "${workflow.name}" ===`, {
      id: workflow.id,
      site: workflow.site,
      stepsCount: workflow.steps.length,
      variables: this.variables,
    });

    // Validate required variables
    const missing = workflow.variables
      .filter(v => v.required && this.variables[v.name] === undefined)
      .map(v => v.name);

    if (missing.length > 0) {
      return {
        success: false,
        stepsExecuted: 0,
        stepsTotal: workflow.steps.length,
        variables: this.variables,
        stepResults: [],
        error: `Missing required variables: ${missing.join(', ')}`,
        durationMs: Date.now() - startTime,
      };
    }

    // Merge defaults
    for (const v of workflow.variables) {
      if (this.variables[v.name] === undefined && v.default !== undefined) {
        this.variables[v.name] = v.default;
      }
    }

    // Execute steps
    const stepResults = await this.executeSteps(workflow.steps);

    const result: ExecutionResult = {
      success: stepResults.every(r => r.status === 'success' || r.status === 'skipped'),
      stepsExecuted: stepResults.filter(r => r.status !== 'skipped').length,
      stepsTotal: stepResults.length,
      variables: this.variables,
      stepResults,
      durationMs: Date.now() - startTime,
    };

    if (!result.success) {
      const failed = stepResults.find(r => r.status === 'failed');
      result.error = failed?.error;
    }

    this.emitProgress({ type: 'workflow_complete', result });
    return result;
  }

  /**
   * Set the directory context for resolving relative workflow paths.
   */
  setWorkflowDir(dir: string): void {
    this.workflowDir = dir;
  }

  private async executeSteps(steps: WorkflowStep[]): Promise<StepResult[]> {
    const results: StepResult[] = [];

    for (let i = 0; i < steps.length; i++) {
      if (this.signal?.aborted) {
        results.push({
          stepId: steps[i].id,
          stepLabel: steps[i].label,
          status: 'skipped',
          durationMs: 0,
          error: 'Workflow aborted',
        });
        continue;
      }

      // Substitute variables in the step
      const step = substituteObject(steps[i], this.variables);

      this.emitProgress({
        type: 'step_start',
        stepId: step.id,
        stepLabel: step.label,
        index: i,
        total: steps.length,
      });

      const result = await this.executeStepWithRetry(step);
      results.push(result);

      this.emitProgress({
        type: 'step_complete',
        stepId: step.id,
        stepLabel: step.label,
        result,
      });

      if (result.status === 'failed' && this.stopOnFailure) {
        // Skip remaining steps
        for (let j = i + 1; j < steps.length; j++) {
          results.push({
            stepId: steps[j].id,
            stepLabel: steps[j].label,
            status: 'skipped',
            durationMs: 0,
          });
        }
        break;
      }
    }

    return results;
  }

  private async executeStepWithRetry(step: WorkflowStep): Promise<StepResult> {
    const maxAttempts = step.retry?.maxAttempts ?? 1;
    let delayMs = step.retry?.delayMs ?? 1000;
    const backoff = step.retry?.backoffMultiplier ?? 1;
    let lastError = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const stepStart = Date.now();

      try {
        // Check preconditions
        if (step.preconditions) {
          for (const pre of step.preconditions) {
            const passed = await this.validator.checkPrecondition(pre);
            this.emitProgress({
              type: 'precondition_check',
              stepId: step.id,
              condition: pre,
              passed,
            });
            if (!passed) {
              throw new Error(`Precondition failed: ${this.describePrecondition(pre)}`);
            }
          }
        }

        // Capture pre-execution state for postconditions
        const preUrl = await this.getCurrentUrl();

        // Execute the step
        await this.executeStep(step);

        // Check postconditions
        if (step.postconditions) {
          // Small delay to let page state settle
          await this.delay(200);

          for (const post of step.postconditions) {
            const passed = await this.validator.checkPostcondition(post, preUrl);
            this.emitProgress({
              type: 'postcondition_check',
              stepId: step.id,
              condition: post,
              passed,
            });
            if (!passed) {
              throw new Error(`Postcondition failed: ${this.describePostcondition(post)}`);
            }
          }
        }

        return {
          stepId: step.id,
          stepLabel: step.label,
          status: 'success',
          durationMs: Date.now() - stepStart,
          retryCount: attempt > 1 ? attempt - 1 : undefined,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);

        if (attempt < maxAttempts) {
          this.emitProgress({
            type: 'step_retry',
            stepId: step.id,
            stepLabel: step.label,
            attempt,
            maxAttempts,
            error: lastError,
          });
          await this.delay(delayMs);
          delayMs *= backoff;
        }
      }
    }

    return {
      stepId: step.id,
      stepLabel: step.label,
      status: 'failed',
      durationMs: 0,
      error: lastError,
      retryCount: maxAttempts > 1 ? maxAttempts - 1 : undefined,
    };
  }

  private async executeStep(step: WorkflowStep): Promise<void> {
    switch (step.type) {
      case 'navigate':
        return this.execNavigate(step as NavigateStep);
      case 'click':
        return this.execClick(step as ClickStep);
      case 'type':
        return this.execType(step as TypeStep);
      case 'wait':
        return this.execWait(step as WaitStep);
      case 'assert':
        return this.execAssert(step as AssertStep);
      case 'download':
        return this.execDownload(step as DownloadStep);
      case 'capture_download':
        return this.execCaptureDownload(step as CaptureDownloadStep);
      case 'move_file':
        return this.execMoveFile(step as MoveFileStep);
      case 'scroll':
        return this.execScroll(step as ScrollStep);
      case 'keyboard':
        return this.execKeyboard(step as KeyboardStep);
      case 'sub_workflow':
        return this.execSubWorkflow(step as SubWorkflowStep);
      case 'conditional':
        return this.execConditional(step as ConditionalStep);
      case 'loop':
        return this.execLoop(step as LoopStep);
      case 'try_catch':
        return this.execTryCatch(step as TryCatchStep);
      case 'set_variable':
        return this.execSetVariable(step as SetVariableStep);
      default:
        throw new Error(`Unknown step type: ${(step as WorkflowStep).type}`);
    }
  }

  // ── Step executors ──────────────────────────────────────────

  private async execNavigate(step: NavigateStep): Promise<void> {
    await this.bridge.send('open', { url: step.url });

    if (step.waitMs) {
      await this.delay(step.waitMs);
    }

    if (step.waitForSelector) {
      await this.bridge.send('wait_for_element', {
        selector: step.waitForSelector,
        timeout: step.timeoutMs || 10000,
      });
    }
  }

  private async execClick(step: ClickStep): Promise<void> {
    execLog('INFO', `execClick: ${step.id} "${step.label}"`, {
      selector: step.target.selector,
      placeholder: step.target.placeholder,
      textContent: step.target.textContent,
      expectedPct: step.target.expectedBounds ? {
        pctX: step.target.expectedBounds.pctX,
        pctY: step.target.expectedBounds.pctY,
      } : null,
    });

    const resolved = await this.resolver.resolve(step.target);

    execLog('INFO', `execClick resolved: ${step.id}`, {
      matchedBy: resolved.matchedBy,
      matchedValue: resolved.matchedValue,
      position: resolved.position,
      boundsValid: resolved.boundsValid,
    });

    if (resolved.boundsValid === false) {
      execLog('WARN', `execClick bounds invalid: ${step.id}`, {
        actualPos: resolved.position,
        expectedBounds: step.target.expectedBounds,
      });
    }

    if (resolved.position) {
      const centerX = resolved.position.left + resolved.position.width / 2;
      const centerY = resolved.position.top + resolved.position.height / 2;

      const action = step.clickType === 'hover' ? 'move'
        : step.clickType === 'double' ? 'double_click'
        : step.clickType === 'right' ? 'right_click'
        : 'click';

      execLog('INFO', `execClick sending mouse: ${step.id}`, {
        action,
        x: Math.round(centerX),
        y: Math.round(centerY),
      });

      await this.bridge.send('mouse', {
        action,
        x: Math.round(centerX),
        y: Math.round(centerY),
      });
    } else {
      execLog('WARN', `execClick no position, using click_element: ${step.id}`, {
        selector: step.target.selector,
      });
      // Fallback: try click_element with selector
      await this.bridge.send('click_element', {
        selector: step.target.selector,
      });
    }

    if (step.delayAfterMs) {
      await this.delay(step.delayAfterMs);
    }
  }

  private async execType(step: TypeStep): Promise<void> {
    execLog('INFO', `execType: ${step.id} "${step.label}"`, {
      selector: step.target.selector,
      placeholder: step.target.placeholder,
      value: step.value?.slice(0, 50),
    });

    const resolved = await this.resolver.resolve(step.target);

    execLog('INFO', `execType resolved: ${step.id}`, {
      matchedBy: resolved.matchedBy,
      matchedValue: resolved.matchedValue,
      position: resolved.position,
    });

    // Build the best selector for set_value — prefer placeholder (more unique)
    const setValueSelector = step.target.placeholder
      ? `[placeholder="${step.target.placeholder.replace(/"/g, '\\"')}"]`
      : step.target.selector;

    if (step.clearFirst) {
      // Try set_value first (works with React/Vue controlled inputs)
      try {
        await this.bridge.send('set_value', {
          selector: setValueSelector,
          value: '',
        });
      } catch {
        // Fallback: click and select all + delete
        if (resolved.position) {
          const cx = resolved.position.left + resolved.position.width / 2;
          const cy = resolved.position.top + resolved.position.height / 2;
          await this.bridge.send('mouse', { action: 'click', x: Math.round(cx), y: Math.round(cy) });
          await this.bridge.send('keyboard', { action: 'hotkey', key: 'a', ctrl: true });
          await this.bridge.send('keyboard', { action: 'press', key: 'backspace' });
        }
      }
    }

    // Try set_value first for reliability
    try {
      await this.bridge.send('set_value', {
        selector: setValueSelector,
        value: step.value,
      });
    } catch {
      // Fallback: click and type
      if (resolved.position) {
        const cx = resolved.position.left + resolved.position.width / 2;
        const cy = resolved.position.top + resolved.position.height / 2;
        await this.bridge.send('mouse', { action: 'click', x: Math.round(cx), y: Math.round(cy) });
      }
      await this.bridge.send('keyboard', { action: 'type', text: step.value });
    }

    if (step.delayAfterMs) {
      await this.delay(step.delayAfterMs);
    }
  }

  private async execWait(step: WaitStep): Promise<void> {
    const timeout = step.timeoutMs || 30000;
    const met = await this.validator.waitForCondition(
      step.condition,
      timeout,
      500,
      this.signal
    );

    if (!met) {
      throw new Error(`Wait condition not met within ${timeout}ms: ${JSON.stringify(step.condition)}`);
    }
  }

  private async execAssert(step: AssertStep): Promise<void> {
    const passed = await this.validator.checkAssertCondition(
      step.condition,
      this.variables
    );

    if (!passed) {
      throw new Error(step.errorMessage || `Assertion failed: ${JSON.stringify(step.condition)}`);
    }
  }

  private async execDownload(step: DownloadStep): Promise<void> {
    // Click the trigger element to start download
    const resolved = await this.resolver.resolve(step.trigger);

    if (resolved.position) {
      const cx = resolved.position.left + resolved.position.width / 2;
      const cy = resolved.position.top + resolved.position.height / 2;
      await this.bridge.send('mouse', { action: 'click', x: Math.round(cx), y: Math.round(cy) });
    } else {
      await this.bridge.send('click_element', { selector: step.trigger.selector });
    }

    // Wait for download to complete
    if (step.waitMs) {
      await this.delay(step.waitMs);
    }
  }

  private async execCaptureDownload(step: CaptureDownloadStep): Promise<void> {
    const maxFiles = step.maxFiles ?? 1;
    const lookbackMs = step.lookbackMs ?? 30000;
    const waitTimeoutMs = step.waitTimeoutMs ?? 60000;
    const outputVariable = step.outputVariable ?? 'downloadedFiles';

    execLog('INFO', `execCaptureDownload: ${step.id}`, {
      filenamePattern: step.filenamePattern, maxFiles, lookbackMs, waitTimeoutMs, outputVariable,
    });

    // Step 1: Query recent downloads from Chrome
    const queryResult = await this.bridge.send('get_downloads', {
      limit: maxFiles * 3,
      filenamePattern: step.filenamePattern,
      sinceMs: lookbackMs,
    }) as any;

    const downloads = queryResult?.downloads ?? [];
    if (downloads.length === 0) {
      throw new Error('No matching downloads found');
    }

    // Step 2: Wait for any in-progress downloads to complete
    const inProgressIds = downloads
      .filter((d: any) => d.state === 'in_progress')
      .map((d: any) => d.id);
    if (inProgressIds.length > 0) {
      execLog('INFO', `Waiting for ${inProgressIds.length} in-progress download(s)`);
      await this.bridge.send('wait_downloads_complete', {
        downloadIds: inProgressIds,
        timeoutMs: waitTimeoutMs,
      });
    }

    // Step 3: Re-query to get final filenames (may change during download)
    const finalResult = await this.bridge.send('get_downloads', {
      limit: maxFiles * 3,
      filenamePattern: step.filenamePattern,
      sinceMs: lookbackMs,
      state: 'complete',
    }) as any;

    const completedFiles = (finalResult?.downloads ?? [])
      .map((d: any) => d.filename)
      .slice(0, maxFiles);

    if (completedFiles.length === 0) {
      throw new Error('No completed downloads found after waiting');
    }

    // Step 4: Store file paths in workflow variables
    this.variables[outputVariable] = completedFiles;
    execLog('INFO', `Captured ${completedFiles.length} download(s)`, { files: completedFiles });
  }

  private async execMoveFile(step: MoveFileStep): Promise<void> {
    const source = step.source as unknown;
    const destination = step.destination;

    // Handle array sources (from capture_download variable substitution)
    if (Array.isArray(source)) {
      const files = source as string[];
      if (files.length === 0) {
        throw new Error('No source files to move (empty array)');
      }
      await fs.mkdir(destination, { recursive: true });
      for (const file of files) {
        const destFile = join(destination, basename(file));
        await fs.rename(file, destFile);
      }
      return;
    }

    // Handle glob patterns in source
    if (typeof source === 'string' && source.includes('*')) {
      const matches = await this.globFiles(source);
      if (matches.length === 0) {
        throw new Error(`No files matching pattern: ${source}`);
      }

      // Ensure destination directory exists
      await fs.mkdir(dirname(destination), { recursive: true });

      for (const file of matches) {
        const destFile = join(destination, file.split('/').pop()!);
        await fs.rename(file, destFile);
      }
    } else {
      await fs.mkdir(dirname(destination), { recursive: true });
      await fs.rename(source as string, destination);
    }
  }

  private async execScroll(step: ScrollStep): Promise<void> {
    if (step.target) {
      await this.bridge.send('scroll_to_element', {
        selector: step.target.selector,
      });
    } else {
      await this.bridge.send('mouse', {
        action: 'scroll',
        scrollY: step.direction === 'down' ? (step.amount || 3) : -(step.amount || 3),
        scrollX: step.direction === 'right' ? (step.amount || 3) : step.direction === 'left' ? -(step.amount || 3) : 0,
      });
    }
  }

  private async execKeyboard(step: KeyboardStep): Promise<void> {
    if (step.modifiers && step.modifiers.length > 0) {
      await this.bridge.send('keyboard', {
        action: 'hotkey',
        key: step.key,
        ctrl: step.modifiers.includes('ctrl'),
        shift: step.modifiers.includes('shift'),
        alt: step.modifiers.includes('alt'),
      });
    } else {
      await this.bridge.send('keyboard', {
        action: 'press',
        key: step.key,
      });
    }
  }

  private async execSubWorkflow(step: SubWorkflowStep): Promise<void> {
    // Resolve workflow path
    let workflowPath = step.workflowPath;
    if (!workflowPath.startsWith('/') && this.workflowDir) {
      workflowPath = pathResolve(this.workflowDir, workflowPath);
    }

    const content = await fs.readFile(workflowPath, 'utf-8');
    const subWorkflow: WorkflowDocument = JSON.parse(content);

    // Merge variables: current context + explicit bindings
    const subVars = { ...this.variables };
    if (step.variables) {
      for (const [key, value] of Object.entries(step.variables)) {
        subVars[key] = value;
      }
    }

    const subExecutor = new WorkflowExecutor(this.bridge, {
      variables: subVars,
      signal: this.signal,
      onProgress: this.onProgress,
      stopOnFailure: this.stopOnFailure,
    });
    subExecutor.setWorkflowDir(dirname(workflowPath));

    const result = await subExecutor.execute(subWorkflow);

    // Propagate variable changes back
    Object.assign(this.variables, result.variables);

    if (!result.success) {
      throw new Error(`Sub-workflow "${subWorkflow.name}" failed: ${result.error}`);
    }
  }

  private async execConditional(step: ConditionalStep): Promise<void> {
    const passed = await this.validator.checkAssertCondition(
      step.condition,
      this.variables
    );

    const stepsToRun = passed ? step.thenSteps : (step.elseSteps || []);

    if (stepsToRun.length > 0) {
      const results = await this.executeSteps(stepsToRun);
      const failed = results.find(r => r.status === 'failed');
      if (failed && this.stopOnFailure) {
        throw new Error(`Conditional branch step failed: ${failed.error}`);
      }
    }
  }

  private async execLoop(step: LoopStep): Promise<void> {
    const items = this.variables[step.overVariable];

    if (!Array.isArray(items)) {
      throw new Error(`Loop variable "${step.overVariable}" is not an array`);
    }

    for (let i = 0; i < items.length; i++) {
      if (this.signal?.aborted) break;

      this.variables[step.itemVariable] = items[i];
      if (step.indexVariable) {
        this.variables[step.indexVariable] = i;
      }

      const results = await this.executeSteps(step.steps);
      const failed = results.find(r => r.status === 'failed');
      if (failed && this.stopOnFailure) {
        throw new Error(`Loop iteration ${i} failed: ${failed.error}`);
      }
    }
  }

  private async execTryCatch(step: TryCatchStep): Promise<void> {
    try {
      const results = await this.executeSteps(step.trySteps);
      const failed = results.find(r => r.status === 'failed');
      if (failed) {
        throw new Error(failed.error || 'Step failed');
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (step.errorVariable) {
        this.variables[step.errorVariable] = errorMsg;
      }

      const catchResults = await this.executeSteps(step.catchSteps);
      const catchFailed = catchResults.find(r => r.status === 'failed');
      if (catchFailed && this.stopOnFailure) {
        throw new Error(`Catch block failed: ${catchFailed.error}`);
      }
    }
  }

  private async execSetVariable(step: SetVariableStep): Promise<void> {
    let value: unknown;

    switch (step.source.type) {
      case 'literal':
        value = step.source.value;
        break;

      case 'element_text': {
        const resolved = await this.resolver.resolve(step.source.target);
        value = resolved.textContent || '';
        break;
      }

      case 'element_attribute': {
        const info = await this.bridge.send('get_element_info', {
          selector: step.source.target.selector,
        }) as Record<string, unknown>;
        const attrs = info?.attributes as Record<string, string> | undefined;
        value = attrs?.[step.source.attribute] || '';
        break;
      }

      case 'url':
        value = await this.getCurrentUrl();
        break;

      case 'url_param': {
        const url = await this.getCurrentUrl();
        try {
          const parsed = new URL(url);
          value = parsed.searchParams.get(step.source.param) || '';
        } catch {
          value = '';
        }
        break;
      }

      case 'regex': {
        const input = String(step.source.input);
        try {
          const match = new RegExp(step.source.pattern).exec(input);
          if (match) {
            value = step.source.group !== undefined
              ? match[step.source.group] || ''
              : match[0];
          } else {
            value = '';
          }
        } catch {
          value = '';
        }
        break;
      }

      default:
        throw new Error(`Unknown variable source type: ${(step.source as { type: string }).type}`);
    }

    this.variables[step.variable] = value;
  }

  // ── Utilities ────────────────────────────────────────────────

  private async getCurrentUrl(): Promise<string> {
    try {
      const info = await this.bridge.send('get_page_info') as Record<string, unknown>;
      return (info?.url as string) || '';
    } catch {
      return '';
    }
  }

  private async globFiles(pattern: string): Promise<string[]> {
    try {
      const dir = dirname(pattern);
      const filePattern = basename(pattern);
      // Convert simple glob pattern to regex (supports * and ?)
      const regex = new RegExp(
        '^' + filePattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
      );
      const entries = await fs.readdir(dir);
      return entries
        .filter(entry => regex.test(entry))
        .map(entry => join(dir, entry));
    } catch {
      return [];
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (this.signal) {
        this.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      }
    });
  }

  private emitProgress(event: ExecutionProgressEvent): void {
    this.onProgress?.(event);
  }

  private describePrecondition(pre: Precondition): string {
    switch (pre.type) {
      case 'url_matches': return `URL matches "${pre.pattern}"`;
      case 'url_contains': return `URL contains "${pre.substring}"`;
      case 'element_exists': return `Element exists: "${pre.target.selector}"`;
      case 'element_visible': return `Element visible: "${pre.target.selector}"`;
      case 'element_text_matches': return `Element text matches "${pre.pattern}": "${pre.target.selector}"`;
      default: return JSON.stringify(pre);
    }
  }

  private describePostcondition(post: Postcondition): string {
    switch (post.type) {
      case 'url_changed': return 'URL changed';
      case 'url_matches': return `URL matches "${post.pattern}"`;
      case 'element_appeared': return `Element appeared: "${post.target.selector}"`;
      case 'element_disappeared': return `Element disappeared: "${post.target.selector}"`;
      case 'element_text_changed': return `Element text changed: "${post.target.selector}"`;
      default: return JSON.stringify(post);
    }
  }
}
