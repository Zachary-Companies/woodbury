/**
 * Verifier — Task and goal verification for the Closure Engine.
 *
 * Extends TaskValidator types with `llm_judge` which uses the LLM
 * to evaluate whether a criterion has been met based on evidence.
 * Uses actual tool calls for validation (file_read, shell_execute, etc.).
 */

import type { ProviderAdapter } from '../v2/core/provider-adapter.js';
import type { ToolRegistryV2 } from '../v2/tools/registry-v2.js';
import type { ToolExecutionContext } from '../v2/types/tool-types.js';
import type {
  TaskNode,
  TaskResult,
  TaskValidator,
  Goal,
  SuccessCriterion,
  Observation,
} from './types.js';
import { debugLog } from '../../debug-log.js';

export interface VerificationResult {
  passed: boolean;
  /** True when some validators passed and some failed */
  partial?: boolean;
  validatorResults: ValidatorResult[];
  summary: string;
  /** What still needs verification (populated when partial) */
  gaps?: string[];
}

export interface ValidatorResult {
  validator: TaskValidator;
  passed: boolean;
  output: string;
  error?: string;
}

export class Verifier {
  constructor(
    private toolRegistry: ToolRegistryV2,
    private adapter: ProviderAdapter,
    private provider: 'openai' | 'anthropic' | 'groq',
    private model: string,
    private workingDirectory: string,
    private toolTimeout: number = 30000,
  ) {}

  /**
   * Verify a task's completion against all its validators.
   */
  async verifyTask(task: TaskNode, result: TaskResult): Promise<VerificationResult> {
    if (task.validators.length === 0) {
      return { passed: true, validatorResults: [], summary: 'No validators — auto-pass' };
    }

    const results: ValidatorResult[] = [];

    for (const validator of task.validators) {
      const vResult = await this.runValidator(validator, result);
      results.push(vResult);
      debugLog.debug('verifier', `Validator ${validator.type}: ${vResult.passed ? 'PASS' : 'FAIL'}`, {
        output: vResult.output.slice(0, 200),
      });
    }

    const allPassed = results.every(r => r.passed);
    const somePassed = results.some(r => r.passed);
    const partial = !allPassed && somePassed;
    const summary = results
      .map(r => `[${r.passed ? 'PASS' : 'FAIL'}] ${r.validator.type}: ${r.output.slice(0, 100)}`)
      .join('\n');

    const gaps = partial
      ? results.filter(r => !r.passed).map(r => `${r.validator.type}: ${r.output.slice(0, 100)}`)
      : undefined;

    return { passed: allPassed, partial, validatorResults: results, summary, gaps };
  }

  /**
   * Verify a goal by checking all success criteria.
   */
  async verifyGoal(
    goal: Goal,
    observations: Observation[],
  ): Promise<{ achieved: boolean; criteriaResults: Array<{ criterion: SuccessCriterion; met: boolean; reason: string }> }> {
    const criteriaResults: Array<{ criterion: SuccessCriterion; met: boolean; reason: string }> = [];

    for (const criterion of goal.successCriteria) {
      if (criterion.validator) {
        const vResult = await this.runValidator(criterion.validator, undefined);
        criteriaResults.push({
          criterion,
          met: vResult.passed,
          reason: vResult.passed ? 'Validator passed' : vResult.output,
        });
      } else {
        // Use LLM judge for criteria without explicit validators
        const met = await this.llmJudge(criterion.description, observations);
        criteriaResults.push({ criterion, met, reason: met ? 'LLM judge: met' : 'LLM judge: not met' });
      }
    }

    const achieved = criteriaResults.every(r => r.met);
    return { achieved, criteriaResults };
  }

  /**
   * Run a single validator.
   */
  private async runValidator(validator: TaskValidator, result?: TaskResult): Promise<ValidatorResult> {
    try {
      switch (validator.type) {
        case 'file_exists':
          return await this.checkFileExists(validator);
        case 'file_contains':
          return await this.checkFileContains(validator);
        case 'command_succeeds':
          return await this.checkCommandSucceeds(validator);
        case 'command_output_matches':
          return await this.checkCommandOutputMatches(validator);
        case 'test_file':
          return await this.checkTestFile(validator);
        case 'llm_judge':
          if (!validator.criterion) {
            return { validator, passed: false, output: 'No criterion specified for llm_judge' };
          }
          const observations = result?.observations || [];
          const met = await this.llmJudge(validator.criterion, observations);
          return { validator, passed: met, output: met ? 'Criterion met' : 'Criterion not met' };
        default:
          return { validator, passed: false, output: `Unknown validator type: ${validator.type}` };
      }
    } catch (err) {
      return {
        validator,
        passed: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async checkFileExists(validator: TaskValidator): Promise<ValidatorResult> {
    const tool = this.toolRegistry.get('file_read');
    if (!tool) return { validator, passed: false, output: 'file_read tool not available' };

    try {
      const output = await this.executeTool(tool.handler, { path: validator.path });
      return { validator, passed: true, output: `File exists (${output.length} chars)` };
    } catch {
      return { validator, passed: false, output: `File not found: ${validator.path}` };
    }
  }

  private async checkFileContains(validator: TaskValidator): Promise<ValidatorResult> {
    const tool = this.toolRegistry.get('file_read');
    if (!tool) return { validator, passed: false, output: 'file_read tool not available' };

    try {
      const output = await this.executeTool(tool.handler, { path: validator.path });
      if (validator.pattern && new RegExp(validator.pattern).test(output)) {
        return { validator, passed: true, output: `File contains pattern: ${validator.pattern}` };
      }
      return { validator, passed: false, output: `File does not contain pattern: ${validator.pattern}` };
    } catch {
      return { validator, passed: false, output: `File not found: ${validator.path}` };
    }
  }

  private async checkCommandSucceeds(validator: TaskValidator): Promise<ValidatorResult> {
    const tool = this.toolRegistry.get('shell_execute');
    if (!tool) return { validator, passed: false, output: 'shell_execute tool not available' };

    try {
      const output = await this.executeTool(tool.handler, { command: validator.command });
      return { validator, passed: true, output: output.slice(0, 500) };
    } catch (err) {
      return { validator, passed: false, output: `Command failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async checkCommandOutputMatches(validator: TaskValidator): Promise<ValidatorResult> {
    const tool = this.toolRegistry.get('shell_execute');
    if (!tool) return { validator, passed: false, output: 'shell_execute tool not available' };

    try {
      const output = await this.executeTool(tool.handler, { command: validator.command });
      if (validator.pattern && new RegExp(validator.pattern).test(output)) {
        return { validator, passed: true, output: `Output matches: ${validator.pattern}` };
      }
      return { validator, passed: false, output: `Output does not match: ${validator.pattern}` };
    } catch (err) {
      return { validator, passed: false, output: `Command failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async checkTestFile(validator: TaskValidator): Promise<ValidatorResult> {
    const tool = this.toolRegistry.get('test_runner');
    if (!tool) return { validator, passed: false, output: 'test_runner tool not available' };

    try {
      const output = await this.executeTool(tool.handler, { testFile: validator.testFile });
      // Check for pass indicators
      const looksLikePassing = /pass|ok|success|\b0 fail/i.test(output) && !/fail|error|FAILED/i.test(output);
      return { validator, passed: looksLikePassing, output: output.slice(0, 500) };
    } catch (err) {
      return { validator, passed: false, output: `Tests failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * Use LLM to judge whether a criterion has been met based on observations.
   */
  private async llmJudge(criterion: string, observations: Observation[]): Promise<boolean> {
    const evidenceSummary = observations
      .slice(-20) // last 20 observations
      .map(o => `[${o.status}] ${o.toolName}(${JSON.stringify(o.params).slice(0, 100)}): ${o.result.slice(0, 200)}`)
      .join('\n');

    try {
      const response = await this.adapter.createCompletion({
        provider: this.provider,
        model: this.model,
        messages: [
          {
            role: 'system',
            content: 'You are a verification judge. Given evidence from tool executions, determine if a criterion has been met. Respond with ONLY "YES" or "NO".',
          },
          {
            role: 'user',
            content: `Criterion: ${criterion}\n\nEvidence:\n${evidenceSummary || '(no evidence available)'}\n\nHas this criterion been met? Answer YES or NO.`,
          },
        ],
        maxTokens: 10,
        temperature: 0,
      });

      return response.content.trim().toUpperCase().startsWith('YES');
    } catch {
      // On error, assume not met (conservative)
      return false;
    }
  }

  private async executeTool(
    handler: (input: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<string>,
    input: Record<string, unknown>,
  ): Promise<string> {
    const context: ToolExecutionContext = {
      workingDirectory: this.workingDirectory,
      timeoutMs: this.toolTimeout,
    };
    return handler(input, context);
  }
}
