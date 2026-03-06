/**
 * Workflow Executor
 *
 * Runs workflow steps sequentially, calling the bridge server for
 * browser interactions. Handles variable substitution, precondition
 * checks, postcondition verification, retries, and progress reporting.
 */

import { promises as fs, appendFileSync, mkdirSync, existsSync } from 'fs';
import { resolve as pathResolve, dirname, join, basename } from 'path';
import { execSync, spawn as cpSpawn } from 'child_process';
import { homedir } from 'os';
import { focusAndMaximizeChrome } from '../browser-utils.js';

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
  ExpectationResult,
  Expectation,
  BridgeInterface,
  NavigateStep,
  ClickStep,
  ClickSelectorStep,
  TypeStep,
  WaitStep,
  AssertStep,
  DownloadStep,
  CaptureDownloadStep,
  MoveFileStep,
  FileDialogStep,
  ScrollStep,
  KeyboardStep,
  KeyboardNavStep,
  KeyboardNavAction,
  ExpectedFocusDescriptor,
  SubWorkflowStep,
  ConditionalStep,
  LoopStep,
  TryCatchStep,
  SetVariableStep,
  DesktopLaunchAppStep,
  DesktopClickStep,
  DesktopTypeStep,
  DesktopKeyboardStep,
  InjectStyleStep,
  Precondition,
  Postcondition,
} from './types.js';
import { substituteObject } from './variable-sub.js';
import { ElementResolver, AccessibilityResolver } from './resolver.js';
import { ConditionValidator } from './validator.js';
import { VisualVerifier } from './visual-verifier.js';

// ── Expectation Checker ──────────────────────────────────────

async function checkExpectations(
  expectations: Expectation[],
  variables: Record<string, unknown>,
): Promise<ExpectationResult[]> {
  const results: ExpectationResult[] = [];
  for (const raw of expectations) {
    // Substitute {{variables}} in expectation fields
    const exp = substituteObject(raw, variables) as Expectation;
    results.push(await checkOneExpectation(exp, variables));
  }
  return results;
}

async function checkOneExpectation(
  exp: Expectation,
  variables: Record<string, unknown>,
): Promise<ExpectationResult> {
  switch (exp.type) {
    case 'file_count': {
      try {
        const entries = await fs.readdir(exp.directory);
        const pattern = exp.pattern || '*';
        // Convert glob to regex: *.mp3 → ^.*\.mp3$
        const regex = new RegExp(
          '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
        );
        const matching = entries.filter(e => regex.test(e));
        const count = matching.length;
        const passed = count >= exp.minCount && (exp.maxCount === undefined || count <= exp.maxCount);
        return {
          expectation: exp,
          passed,
          detail: `Found ${count} file(s) matching "${pattern}" in ${exp.directory} (need >= ${exp.minCount})`,
        };
      } catch {
        return { expectation: exp, passed: false, detail: `Directory not accessible: ${exp.directory}` };
      }
    }
    case 'file_exists': {
      try {
        const stat = await fs.stat(exp.path);
        if (exp.minSizeBytes !== undefined && stat.size < exp.minSizeBytes) {
          return { expectation: exp, passed: false, detail: `File exists but too small: ${stat.size} bytes (need >= ${exp.minSizeBytes})` };
        }
        return { expectation: exp, passed: true, detail: `File exists: ${exp.path} (${stat.size} bytes)` };
      } catch {
        return { expectation: exp, passed: false, detail: `File not found: ${exp.path}` };
      }
    }
    case 'variable_not_empty': {
      const value = variables[exp.variable];
      const passed = value !== undefined && value !== null && value !== '';
      return {
        expectation: exp,
        passed,
        detail: passed ? `Variable "${exp.variable}" is set` : `Variable "${exp.variable}" is empty or missing`,
      };
    }
    case 'variable_equals': {
      const actual = variables[exp.variable];
      const passed = actual === exp.value;
      return {
        expectation: exp,
        passed,
        detail: passed
          ? `Variable "${exp.variable}" equals expected value`
          : `Variable "${exp.variable}" is ${JSON.stringify(actual)}, expected ${JSON.stringify(exp.value)}`,
      };
    }
    default:
      return { expectation: exp, passed: false, detail: 'Unknown expectation type' };
  }
}

// Export for use in composition execution (config-dashboard.ts)
export { checkExpectations };

// ── Workflow Executor ────────────────────────────────────────

export class WorkflowExecutor {
  private resolver: ElementResolver | AccessibilityResolver;
  private validator: ConditionValidator;
  private visualVerifier: VisualVerifier | null;
  private _explicitVerifier: boolean;
  private variables: Record<string, unknown>;
  private initialVariables: Record<string, unknown>;
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
    // Visual verifier is initialized per-workflow in execute() with the workflow's modelPath,
    // unless explicitly provided via options.
    this.visualVerifier = options.visualVerifier !== undefined ? options.visualVerifier : null;
    this._explicitVerifier = options.visualVerifier !== undefined;
    this.variables = { ...options.variables };
    this.initialVariables = { ...options.variables };
    this.signal = options.signal;
    this.onProgress = options.onProgress;
    this.stopOnFailure = options.stopOnFailure ?? true;
  }

  /**
   * Execute a workflow document.
   * Supports workflow-level expectations (post-step checks) and retry.
   */
  async execute(workflow: WorkflowDocument): Promise<ExecutionResult> {
    const startTime = Date.now();

    // Select resolver based on workflow recording mode
    if (workflow.metadata?.recordingMode === 'accessibility') {
      this.resolver = new AccessibilityResolver(this.bridge);
      execLog('INFO', 'Using AccessibilityResolver (accessibility recording mode)');
    }
    // else keep default ElementResolver

    // Initialize visual verifier with workflow's model if not explicitly provided
    if (!this._explicitVerifier) {
      const modelPath = workflow.metadata?.modelPath;
      if (modelPath) {
        this.visualVerifier = new VisualVerifier(undefined, modelPath);
      } else {
        // No model associated with this workflow — create verifier without model
        // (will use inference server's default model, if any)
        this.visualVerifier = new VisualVerifier();
      }
    }

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

    // Workflow-level retry loop
    const maxAttempts = workflow.retry?.maxAttempts ?? 1;
    let retryDelayMs = workflow.retry?.delayMs ?? 5000;
    const retryBackoff = workflow.retry?.backoffMultiplier ?? 1;
    let lastFailedExpectations: string[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Reset variables for retry
      this.variables = { ...this.initialVariables };
      for (const v of workflow.variables) {
        if (this.variables[v.name] === undefined && v.default !== undefined) {
          this.variables[v.name] = v.default;
        }
      }

      if (attempt > 1) {
        execLog('INFO', `=== Workflow retry attempt ${attempt}/${maxAttempts} ===`, {
          failedExpectations: lastFailedExpectations,
        });
        this.emitProgress({
          type: 'workflow_retry',
          attempt,
          maxAttempts,
          failedExpectations: lastFailedExpectations,
        });
        await this.delay(retryDelayMs);
        retryDelayMs *= retryBackoff;
      }

      // Execute steps
      const stepResults = await this.executeSteps(workflow.steps);
      const stepsSuccess = stepResults.every(r => r.status === 'success' || r.status === 'skipped');

      if (!stepsSuccess) {
        if (attempt === maxAttempts) {
          const failed = stepResults.find(r => r.status === 'failed');
          const result: ExecutionResult = {
            success: false,
            stepsExecuted: stepResults.filter(r => r.status !== 'skipped').length,
            stepsTotal: stepResults.length,
            variables: this.variables,
            stepResults,
            error: failed?.error,
            durationMs: Date.now() - startTime,
          };
          this.emitProgress({ type: 'workflow_complete', result });
          return result;
        }
        lastFailedExpectations = ['Steps failed'];
        continue; // retry
      }

      // Check expectations after successful steps
      let expectationResults: ExpectationResult[] | undefined;
      if (workflow.expectations && workflow.expectations.length > 0) {
        expectationResults = await checkExpectations(workflow.expectations, this.variables);

        for (const er of expectationResults) {
          this.emitProgress({
            type: 'expectation_check',
            expectation: er.expectation,
            passed: er.passed,
            detail: er.detail,
          });
        }

        const allPassed = expectationResults.every(r => r.passed);

        if (!allPassed) {
          const failed = expectationResults.filter(r => !r.passed);
          lastFailedExpectations = failed.map(f => f.detail);

          if (attempt === maxAttempts) {
            const result: ExecutionResult = {
              success: false,
              stepsExecuted: stepResults.filter(r => r.status !== 'skipped').length,
              stepsTotal: stepResults.length,
              variables: this.variables,
              stepResults,
              expectationResults,
              error: `Expectations not met: ${failed.map(f => f.detail).join('; ')}`,
              durationMs: Date.now() - startTime,
            };
            this.emitProgress({ type: 'workflow_complete', result });
            return result;
          }
          continue; // retry
        }
      }

      // All steps passed + all expectations passed (or no expectations)
      const result: ExecutionResult = {
        success: true,
        stepsExecuted: stepResults.filter(r => r.status !== 'skipped').length,
        stepsTotal: stepResults.length,
        variables: this.variables,
        stepResults,
        expectationResults,
        durationMs: Date.now() - startTime,
      };
      this.emitProgress({ type: 'workflow_complete', result });
      return result;
    }

    // Should not reach here, but just in case
    return {
      success: false,
      stepsExecuted: 0,
      stepsTotal: workflow.steps.length,
      variables: this.variables,
      stepResults: [],
      error: 'Workflow execution ended unexpectedly',
      durationMs: Date.now() - startTime,
    };
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
      case 'click_selector':
        return this.execClickSelector(step as ClickSelectorStep);
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
      case 'file_dialog':
        return this.execFileDialog(step as FileDialogStep);
      case 'scroll':
        return this.execScroll(step as ScrollStep);
      case 'keyboard':
        return this.execKeyboard(step as KeyboardStep);
      case 'keyboard_nav':
        return this.execKeyboardNav(step as KeyboardNavStep);
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
      case 'desktop_launch_app':
        return this.execDesktopLaunchApp(step as DesktopLaunchAppStep);
      case 'desktop_click':
        return this.execDesktopClick(step as DesktopClickStep);
      case 'desktop_type':
        return this.execDesktopType(step as DesktopTypeStep);
      case 'desktop_keyboard':
        return this.execDesktopKeyboard(step as DesktopKeyboardStep);
      case 'inject_style':
        return this.execInjectStyle(step as InjectStyleStep);
      default:
        throw new Error(`Unknown step type: ${(step as WorkflowStep).type}`);
    }
  }

  // ── Step executors ──────────────────────────────────────────

  private async execNavigate(step: NavigateStep): Promise<void> {
    // If Chrome extension isn't connected, launch Chrome and wait for it
    if (!this.bridge.isConnected) {
      execLog('INFO', 'Chrome not connected — launching Chrome and waiting for extension...');
      try {
        const mod = await import('flow-frame-core/dist/controllers/browserController.js');
        await mod.BrowserController.openChrome({ url: 'about:blank' });
      } catch {
        // Fallback: use the open package directly
        try {
          const { default: open } = await import('open');
          await open('about:blank', { app: { name: 'google chrome' } });
        } catch (e) {
          execLog('WARN', `Failed to launch Chrome: ${e}`);
        }
      }
      // Wait up to 15 seconds for the extension to connect
      const deadline = Date.now() + 15000;
      while (!this.bridge.isConnected && Date.now() < deadline) {
        await this.delay(500);
      }
      if (!this.bridge.isConnected) {
        throw new Error(
          'Chrome was launched but the extension did not connect within 15 seconds.\n' +
          'Make sure the Woodbury Bridge extension is installed in Chrome.'
        );
      }
      execLog('INFO', 'Chrome extension connected after launch');
    }

    // Bring Chrome to the foreground and maximise immediately (fire-and-forget)
    focusAndMaximizeChrome();

    await this.bridge.send('open', { url: step.url }, 30000);

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

    // Visual verification: confirm element looks like the recording
    if (this.visualVerifier && step.target.referenceImage && resolved.position) {
      const vResult = await this.visualVerifier.verifyElement(
        this.bridge,
        resolved.position,
        step.target.referenceImage,
      );

      if (vResult && !vResult.verified) {
        execLog('WARN', `execClick visual verification failed: ${step.id}`, {
          similarity: vResult.similarity,
          matchedBy: resolved.matchedBy,
        });

        // Build position context from expectedBounds for weighted search
        const expectedPct = step.target.expectedBounds?.pctX != null
          ? { x: step.target.expectedBounds.pctX, y: step.target.expectedBounds.pctY! }
          : undefined;

        // Search nearby for the correct element
        const search = await this.visualVerifier.searchNearby(
          this.bridge,
          resolved.position,
          step.target.referenceImage,
          undefined, // default search radius
          vResult.screenshotDataUrl, // reuse cached screenshot
          expectedPct, // position weighting for disambiguation
        );

        if (search?.found) {
          execLog('INFO', `execClick visual search found better match: ${step.id}`, {
            similarity: search.similarity,
            adjustedPosition: search.position,
            candidatesChecked: search.candidatesChecked,
            usedPositionWeighting: !!expectedPct,
          });
          resolved.position = search.position;
          resolved.matchedBy = 'visual';
        }
      } else if (vResult?.verified) {
        execLog('INFO', `execClick visual verification passed: ${step.id}`, {
          similarity: vResult.similarity,
        });
      }
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

      // Use robotjs for visible mouse movement
      const robot = (await import('robotjs')).default || (await import('robotjs'));
      let offsetX = 1;
      let offsetY = 125;
      try {
        const ping = await this.bridge.send('ping', {}) as any;
        if (ping?.chromeOffset) {
          offsetX = ping.chromeOffset.chromeUIWidth ?? 1;
          offsetY = ping.chromeOffset.chromeUIHeight ?? 125;
        }
      } catch { /* use defaults */ }

      const targetX = Math.round(centerX) + offsetX;
      const targetY = Math.round(centerY) + offsetY;
      robot.moveMouseSmooth(targetX, targetY);

      if (action === 'move') {
        // hover — just move, don't click
      } else if (action === 'double_click') {
        robot.mouseClick();
        await this.delay(100);
        robot.mouseClick();
      } else if (action === 'right_click') {
        robot.mouseClick('right');
      } else {
        robot.mouseClick();
      }
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

  private async execClickSelector(step: ClickSelectorStep): Promise<void> {
    execLog('INFO', `execClickSelector: ${step.id} "${step.label}"`, {
      selector: step.selector,
      textContent: step.textContent,
      exactMatch: step.exactMatch,
      clickType: step.clickType,
    });

    if (!step.selector) {
      throw new Error('click_selector step requires a selector');
    }

    // Find element by CSS selector, optionally filtered by text content
    let elements: any[];
    if (step.textContent) {
      elements = await this.bridge.send('find_elements_with_text', {
        selector: step.selector,
        text: step.textContent,
        exact: !!step.exactMatch,
        limit: 1,
      }) as any[];
    } else {
      elements = await this.bridge.send('find_elements', {
        selector: step.selector,
        limit: 1,
      }) as any[];
    }

    if (!elements || elements.length === 0) {
      const desc = step.textContent
        ? `"${step.selector}" containing "${step.textContent}"`
        : `"${step.selector}"`;
      throw new Error(`click_selector: no element found matching ${desc}`);
    }

    const bounds = elements[0].bounds;

    if (!bounds || !bounds.visible) {
      throw new Error(`click_selector: element matching "${step.selector}" is not visible`);
    }

    // Import robotjs directly (same pattern as ff-mouse.ts)
    const robot = (await import('robotjs')).default || (await import('robotjs'));

    // Get Chrome offset from bridge
    let offsetX = 1;
    let offsetY = 125;
    try {
      const ping = await this.bridge.send('ping', {}) as any;
      if (ping?.chromeOffset) {
        offsetX = ping.chromeOffset.chromeUIWidth ?? 1;
        offsetY = ping.chromeOffset.chromeUIHeight ?? 125;
      }
    } catch { /* use defaults */ }

    // Calculate screen-absolute target: element center + chrome offset
    const targetX = bounds.left + offsetX + (bounds.width / 2);
    const targetY = bounds.top + offsetY + (bounds.height / 2);

    execLog('INFO', `execClickSelector: moving to (${targetX}, ${targetY}), offset=(${offsetX}, ${offsetY})`, { bounds });

    // Move mouse visibly via robotjs
    robot.moveMouseSmooth(targetX, targetY);

    // Click via robotjs
    if (step.clickType === 'double') {
      robot.mouseClick();
      await this.delay(100);
      robot.mouseClick();
    } else if (step.clickType === 'right') {
      robot.mouseClick('right');
    } else {
      robot.mouseClick();
    }

    execLog('INFO', `execClickSelector: clicked element matching "${step.selector}"`);

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

    // Visual verification: confirm element looks like the recording
    if (this.visualVerifier && step.target.referenceImage && resolved.position) {
      const vResult = await this.visualVerifier.verifyElement(
        this.bridge,
        resolved.position,
        step.target.referenceImage,
      );

      if (vResult && !vResult.verified) {
        execLog('WARN', `execType visual verification failed: ${step.id}`, {
          similarity: vResult.similarity,
          matchedBy: resolved.matchedBy,
        });

        // Build position context from expectedBounds for weighted search
        const expectedPct = step.target.expectedBounds?.pctX != null
          ? { x: step.target.expectedBounds.pctX, y: step.target.expectedBounds.pctY! }
          : undefined;

        const search = await this.visualVerifier.searchNearby(
          this.bridge,
          resolved.position,
          step.target.referenceImage,
          undefined,
          vResult.screenshotDataUrl,
          expectedPct, // position weighting for disambiguation
        );

        if (search?.found) {
          execLog('INFO', `execType visual search found better match: ${step.id}`, {
            similarity: search.similarity,
            adjustedPosition: search.position,
            candidatesChecked: search.candidatesChecked,
            usedPositionWeighting: !!expectedPct,
          });
          resolved.position = search.position;
          resolved.matchedBy = 'visual';
        }
      } else if (vResult?.verified) {
        execLog('INFO', `execType visual verification passed: ${step.id}`, {
          similarity: vResult.similarity,
        });
      }
    }

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
        // Fallback: click and select all + delete (skip click if skipClick is set)
        if (resolved.position && !step.skipClick) {
          const cx = resolved.position.left + resolved.position.width / 2;
          const cy = resolved.position.top + resolved.position.height / 2;
          await this.bridge.send('mouse', { action: 'click', x: Math.round(cx), y: Math.round(cy) });
        }
        await this.bridge.send('keyboard', { action: 'hotkey', key: 'a', ctrl: true });
        await this.bridge.send('keyboard', { action: 'press', key: 'backspace' });
      }
    }

    // Try set_value first for reliability
    try {
      await this.bridge.send('set_value', {
        selector: setValueSelector,
        value: step.value,
      });
      // After set_value, click the element to sync OS-level focus with DOM focus.
      // set_value does el.focus() but OS keyboard (Tab etc.) follows OS focus, not DOM focus.
      if (resolved.position && !step.skipClick) {
        const cx = resolved.position.left + resolved.position.width / 2;
        const cy = resolved.position.top + resolved.position.height / 2;
        await this.bridge.send('mouse', { action: 'click', x: Math.round(cx), y: Math.round(cy) });
      }
    } catch {
      // Fallback: type via keyboard (click to focus first unless skipClick is set)
      if (resolved.position && !step.skipClick) {
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

  private async execFileDialog(step: FileDialogStep): Promise<void> {
    const filePath = step.filePath;
    const outputVariable = step.outputVariable ?? 'selectedFile';
    const delayBeforeMs = step.delayBeforeMs ?? 2000;
    const delayAfterMs = step.delayAfterMs ?? 1000;

    execLog('INFO', `execFileDialog: ${step.id}`, {
      filePath, outputVariable, hasTrigger: !!step.trigger,
    });

    // Validate absolute path
    if (!filePath.startsWith('/') && !filePath.match(/^[A-Z]:\\/)) {
      throw new Error(`file_dialog: filePath must be absolute. Got: "${filePath}"`);
    }

    // Step 1: Click trigger element to open the file dialog (if specified)
    if (step.trigger && step.trigger.selector) {
      const resolved = await this.resolver.resolve(step.trigger);
      if (resolved.position) {
        const cx = resolved.position.left + resolved.position.width / 2;
        const cy = resolved.position.top + resolved.position.height / 2;
        await this.bridge.send('mouse', {
          action: 'click',
          x: Math.round(cx),
          y: Math.round(cy),
        });
      } else {
        await this.bridge.send('click_element', {
          selector: step.trigger.selector,
        });
      }
    }

    // Step 2: Wait for OS dialog to appear
    await this.delay(delayBeforeMs);

    // Step 3: Navigate the OS file dialog using flow-frame-core
    let flowFrameOps: any;
    try {
      flowFrameOps = await import('flow-frame-core/dist/operations.js');
    } catch (err: any) {
      throw new Error(`file_dialog: Failed to load flow-frame-core: ${err.message}`);
    }

    try {
      await flowFrameOps.fileModalOperate(filePath);
    } catch (err: any) {
      throw new Error(`file_dialog: Dialog operation failed: ${err.message}`);
    }

    // Step 4: Wait for page to process the selected file
    if (delayAfterMs > 0) {
      await this.delay(delayAfterMs);
    }

    // Step 5: Store the file path in workflow variables
    this.variables[outputVariable] = filePath;
    execLog('INFO', `execFileDialog complete: stored ${filePath} in ${outputVariable}`);
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

  // ── Keyboard Nav helpers ───────────────────────────────────

  /** Map keyboard_nav action key to bridge keyboard params */
  private keyboardNavKeyToParams(key: string): { keyName: string; modifiers: string[] } {
    switch (key) {
      case 'tab':         return { keyName: 'Tab', modifiers: [] };
      case 'shift_tab':   return { keyName: 'Tab', modifiers: ['shift'] };
      case 'arrow_up':    return { keyName: 'ArrowUp', modifiers: [] };
      case 'arrow_down':  return { keyName: 'ArrowDown', modifiers: [] };
      case 'arrow_left':  return { keyName: 'ArrowLeft', modifiers: [] };
      case 'arrow_right': return { keyName: 'ArrowRight', modifiers: [] };
      case 'enter':       return { keyName: 'Enter', modifiers: [] };
      case 'space':       return { keyName: 'Space', modifiers: [] };
      case 'escape':      return { keyName: 'Escape', modifiers: [] };
      default:            return { keyName: 'Tab', modifiers: [] };
    }
  }

  /** Get reverse direction key for self-healing */
  private keyboardNavReverse(key: string): string {
    const map: Record<string, string> = {
      tab: 'shift_tab', shift_tab: 'tab',
      arrow_up: 'arrow_down', arrow_down: 'arrow_up',
      arrow_left: 'arrow_right', arrow_right: 'arrow_left',
    };
    return map[key] || key;
  }

  /** Send a single key press via bridge */
  private async sendNavKeyPress(keyName: string, modifiers: string[]): Promise<void> {
    if (modifiers.length > 0) {
      await this.bridge.send('keyboard', {
        action: 'hotkey',
        key: keyName,
        shift: modifiers.includes('shift'),
        ctrl: modifiers.includes('ctrl'),
        alt: modifiers.includes('alt'),
      });
    } else {
      await this.bridge.send('keyboard', { action: 'press', key: keyName });
    }
  }

  /** Check if focused element matches expected focus criteria (AND logic) */
  private focusMatches(
    focused: any,
    expected: ExpectedFocusDescriptor
  ): boolean {
    if (!focused || !focused.focused) return false;

    if (expected.tag && focused.tag !== expected.tag.toLowerCase()) return false;
    if (expected.role && focused.role !== expected.role) return false;
    if (expected.ariaLabel && focused.ariaLabel !== expected.ariaLabel) return false;
    if (expected.placeholder && focused.placeholder !== expected.placeholder) return false;

    // Text matching: use substring/includes for flexibility
    if (expected.text) {
      const focusedText = (focused.text || '').toLowerCase();
      const expectedText = expected.text.toLowerCase();
      if (!focusedText.includes(expectedText) && !expectedText.includes(focusedText)) {
        return false;
      }
    }

    // Selector: check against selector or fallbacks
    if (expected.selector) {
      const allSelectors = [focused.selector, ...(focused.fallbackSelectors || [])];
      if (!allSelectors.some((s: string) => s && s.includes(expected.selector!))) {
        return false;
      }
    }

    return true;
  }

  /** Check if focused element's text matches a search string */
  private textMatchesSearch(focused: any, matchText: string): boolean {
    if (!focused || !focused.focused) return false;
    const searchLower = matchText.toLowerCase();
    const texts = [focused.text, focused.ariaLabel, focused.placeholder]
      .filter(Boolean)
      .map((t: string) => t.toLowerCase());
    return texts.some(t => t.includes(searchLower) || searchLower.includes(t));
  }

  private async execKeyboardNav(step: KeyboardNavStep): Promise<void> {
    const maxSearch = step.maxSearchDistance || 20;
    const delayBetweenPresses = 75;

    execLog('INFO', 'keyboard_nav start', {
      actionsCount: step.actions.length,
      actions: step.actions.map(a => `${a.key}${a.matchText ? `:search("${a.matchText}")` : `:${a.count || 1}`}`),
    });

    // Execute each action in the sequence
    for (let ai = 0; ai < step.actions.length; ai++) {
      const action = step.actions[ai];
      const { keyName, modifiers } = this.keyboardNavKeyToParams(action.key);

      if (action.matchText) {
        // ── Search mode: keep pressing until text match ──
        // Note: {{variables}} already substituted by substituteObject() before executeStep()
        const searchText = action.matchText;

        execLog('INFO', `keyboard_nav action[${ai}] search mode`, {
          key: action.key, searchText, maxSearch,
        });

        let found = false;
        for (let press = 1; press <= maxSearch; press++) {
          await this.sendNavKeyPress(keyName, modifiers);
          await this.delay(delayBetweenPresses);

          const focused = await this.bridge.send('get_focused_element') as any;
          if (this.textMatchesSearch(focused, searchText)) {
            execLog('INFO', `keyboard_nav search found at press ${press}`, {
              key: action.key, matchedText: focused?.text?.slice(0, 50),
            });
            found = true;
            break;
          }
        }

        if (!found) {
          throw new Error(
            `keyboard_nav: could not find "${searchText}" after ${maxSearch} ${action.key} presses`
          );
        }
      } else {
        // ── Count mode: press N times ──
        const count = action.count || 1;
        for (let i = 0; i < count; i++) {
          await this.sendNavKeyPress(keyName, modifiers);
          if (i < count - 1) {
            await this.delay(delayBetweenPresses);
          }
        }
      }

      // Brief pause between actions in the sequence
      if (ai < step.actions.length - 1) {
        await this.delay(delayBetweenPresses);
      }
    }

    // Wait for focus to settle
    await this.delay(step.delayAfterMs || 1000);

    // If no expectedFocus, we're done
    if (!step.expectedFocus || Object.keys(step.expectedFocus).length === 0) return;

    // Verify focus matches expected
    let focused = await this.bridge.send('get_focused_element') as any;
    if (this.focusMatches(focused, step.expectedFocus)) {
      execLog('INFO', 'keyboard_nav focus verified', {
        focusedText: focused?.text?.slice(0, 50),
      });
      return;
    }

    // Focus doesn't match — try self-healing if enabled
    if (step.autoFix === false) {
      throw new Error(
        `keyboard_nav: focus mismatch. Expected: ${JSON.stringify(step.expectedFocus)}, ` +
        `Got: tag=${focused?.tag}, text="${focused?.text?.slice(0, 50)}"`
      );
    }

    // Find the last navigational action to use for self-healing
    const navActions = step.actions.filter(a =>
      ['tab', 'shift_tab', 'arrow_up', 'arrow_down', 'arrow_left', 'arrow_right'].includes(a.key)
    );
    if (navActions.length === 0) {
      throw new Error(
        `keyboard_nav: focus mismatch and no navigational actions to self-heal with. ` +
        `Expected: ${JSON.stringify(step.expectedFocus)}`
      );
    }

    const healAction = navActions[navActions.length - 1];
    const { keyName: healKey, modifiers: healMods } = this.keyboardNavKeyToParams(healAction.key);

    execLog('INFO', 'keyboard_nav self-healing: searching forward', {
      key: healAction.key, maxSearch,
    });

    // Search forward
    for (let extra = 1; extra <= maxSearch; extra++) {
      await this.sendNavKeyPress(healKey, healMods);
      await this.delay(delayBetweenPresses);
      focused = await this.bridge.send('get_focused_element') as any;

      if (this.focusMatches(focused, step.expectedFocus)) {
        execLog('INFO', 'keyboard_nav self-healed forward', { extra });
        return;
      }
    }

    // Forward search failed — try reverse
    const reverseKey = this.keyboardNavReverse(healAction.key);
    const { keyName: revKeyName, modifiers: revMods } = this.keyboardNavKeyToParams(reverseKey);

    execLog('INFO', 'keyboard_nav self-healing: searching reverse', { reverseKey });

    // Undo forward overshoot
    const undoCount = maxSearch + (healAction.count || 1);
    for (let i = 0; i < undoCount; i++) {
      await this.sendNavKeyPress(revKeyName, revMods);
      await this.delay(delayBetweenPresses);
    }

    // Search in reverse
    for (let extra = 1; extra <= maxSearch; extra++) {
      await this.sendNavKeyPress(revKeyName, revMods);
      await this.delay(delayBetweenPresses);
      focused = await this.bridge.send('get_focused_element') as any;

      if (this.focusMatches(focused, step.expectedFocus)) {
        execLog('INFO', 'keyboard_nav self-healed reverse', { extra });
        return;
      }
    }

    throw new Error(
      `keyboard_nav: could not find expected focus after self-healing ` +
      `(searched ${maxSearch} forward + ${maxSearch} reverse). ` +
      `Expected: ${JSON.stringify(step.expectedFocus)}`
    );
  }

  // ── Sub-workflow ──────────────────────────────────────────

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
      visualVerifier: this.visualVerifier,
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
    let passed: boolean;
    if (typeof step.condition === 'function') {
      passed = !!(await step.condition(this.variables));
    } else {
      passed = await this.validator.checkAssertCondition(
        step.condition,
        this.variables
      );
    }

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

  // ── Desktop step executors ─────────────────────────────────

  private async execDesktopLaunchApp(step: DesktopLaunchAppStep): Promise<void> {
    const appName = step.appName;
    execLog('INFO', `execDesktopLaunchApp: ${appName}`);

    if (process.platform === 'darwin') {
      try {
        execSync(
          `osascript -e 'tell application "${appName.replace(/"/g, '\\"')}" to activate'`,
          { timeout: 5000, encoding: 'utf-8' }
        );
      } catch {
        execSync(
          `open -a "${appName.replace(/"/g, '\\"')}"`,
          { timeout: 5000, encoding: 'utf-8' }
        );
      }
    } else if (process.platform === 'win32') {
      try {
        execSync(
          `powershell -NoProfile -c "Start-Process '${appName.replace(/'/g, "''")}';"`,
          { timeout: 5000, encoding: 'utf-8' }
        );
      } catch {
        cpSpawn('cmd', ['/c', 'start', '', appName], { detached: true, stdio: 'ignore' });
      }
    } else {
      try {
        cpSpawn(appName.toLowerCase(), [], { detached: true, stdio: 'ignore' });
      } catch {
        cpSpawn('xdg-open', [appName], { detached: true, stdio: 'ignore' });
      }
    }

    if (step.delayAfterMs) {
      await this.sleepMs(step.delayAfterMs);
    }
  }

  private async execDesktopClick(step: DesktopClickStep): Promise<void> {
    execLog('INFO', `execDesktopClick: ${step.id}`, { x: step.x, y: step.y, action: step.action, app: step.app });

    let robot: any;
    try {
      robot = (await import('robotjs')).default || (await import('robotjs'));
    } catch (err: any) {
      throw new Error(`Desktop click requires robotjs: ${err.message}`);
    }

    // Move mouse to absolute screen coordinates (no Chrome offset)
    const isWin = process.platform === 'win32';
    if (isWin) {
      robot.moveMouse(step.x, step.y);
    } else {
      robot.moveMouseSmooth(step.x, step.y);
    }

    // Small settle delay after move
    await this.sleepMs(100);

    // Perform click
    if (step.action === 'double_click') {
      robot.mouseClick('left', true); // double-click
    } else if (step.action === 'right_click') {
      robot.mouseClick('right');
    } else {
      robot.mouseClick();
    }

    if (step.delayAfterMs) {
      await this.sleepMs(step.delayAfterMs);
    }
  }

  private async execDesktopType(step: DesktopTypeStep): Promise<void> {
    execLog('INFO', `execDesktopType: ${step.id}`, { value: step.value?.slice(0, 50) });

    let robot: any;
    try {
      robot = (await import('robotjs')).default || (await import('robotjs'));
    } catch (err: any) {
      throw new Error(`Desktop type requires robotjs: ${err.message}`);
    }

    // typeString handles full strings (not just single key codes)
    robot.typeString(step.value || '');

    if (step.delayAfterMs) {
      await this.sleepMs(step.delayAfterMs);
    }
  }

  private async execDesktopKeyboard(step: DesktopKeyboardStep): Promise<void> {
    execLog('INFO', `execDesktopKeyboard: ${step.id}`, { key: step.key, modifiers: step.modifiers });

    let robot: any;
    try {
      robot = (await import('robotjs')).default || (await import('robotjs'));
    } catch (err: any) {
      throw new Error(`Desktop keyboard requires robotjs: ${err.message}`);
    }

    // Map modifier names to robotjs format
    const robotMods = (step.modifiers || []).map((m: string) => {
      if (m === 'cmd') return process.platform === 'darwin' ? 'command' : 'control';
      if (m === 'ctrl') return 'control';
      return m; // 'alt', 'shift' are the same
    });

    robot.keyTap(step.key, robotMods);

    if (step.delayAfterMs) {
      await this.sleepMs(step.delayAfterMs);
    }
  }

  private async execInjectStyle(step: InjectStyleStep): Promise<void> {
    const action = step.action || 'apply';
    execLog('INFO', `execInjectStyle: ${step.id}`, { selector: step.selector, action });

    if (action === 'clear') {
      await this.bridge.send('clear_injected_styles', { selector: step.selector || undefined });
    } else {
      if (!step.styles || Object.keys(step.styles).length === 0) {
        throw new Error('inject_style step requires a non-empty styles object when action is "apply"');
      }
      await this.bridge.send('inject_style', { selector: step.selector, styles: step.styles });
    }
  }

  private sleepMs(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
