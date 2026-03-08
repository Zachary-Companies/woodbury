/**
 * Skill Synthesizer — Post-episode extraction for the Closure Engine.
 *
 * After a goal is completed, analyzes the tool call sequences to extract:
 * - Procedural memory: common tool sequences that succeeded
 * - Failure memory: error patterns to avoid
 * - Semantic memory: domain knowledge discovered
 *
 * These memories are matched at planning time to accelerate similar future tasks.
 */

import type { MemoryStore } from './memory-store.js';
import type { StateManager } from './state-manager.js';
import type {
  Observation,
  TaskNode,
  MemoryRecord,
  LearningProduct,
  LearningProductValidator,
  LearningProductHeuristic,
  LearningProductTaskTemplate,
} from './types.js';
import { debugLog } from '../../debug-log.js';

/** A recognized tool sequence pattern. */
interface ToolPattern {
  tools: string[];
  frequency: number;
  avgDuration: number;
  successRate: number;
}

export class SkillSynthesizer {
  constructor(
    private stateManager: StateManager,
    private memoryStore: MemoryStore,
  ) {}

  /**
   * Synthesize skills from a completed session.
   * Returns both MemoryRecords (persisted) and LearningProducts (structured output).
   */
  synthesize(): { memories: MemoryRecord[]; learningProducts: LearningProduct[] } {
    const state = this.stateManager.getState();
    const observations = state.observations;
    const tasks = state.taskGraph?.nodes || [];
    const newMemories: MemoryRecord[] = [];
    const learningProducts: LearningProduct[] = [];

    if (observations.length === 0) return { memories: newMemories, learningProducts };

    // 1. Extract successful tool sequence patterns
    const patterns = this.extractPatterns(observations, tasks);
    for (const pattern of patterns) {
      if (pattern.successRate >= 0.8 && pattern.frequency >= 2) {
        const memory = this.memoryStore.add({
          type: 'procedural',
          content: `Successful tool sequence: ${pattern.tools.join(' → ')} (used ${pattern.frequency}x, ${(pattern.successRate * 100).toFixed(0)}% success, avg ${pattern.avgDuration}ms)`,
          tags: ['tool-sequence', ...pattern.tools],
          confidence: Math.min(0.9, pattern.successRate),
          triggerPattern: pattern.tools[0],
        });
        newMemories.push(memory);
      }
    }

    // 2. Extract failure patterns
    const failedObs = observations.filter(o => o.status === 'error');
    const failurePatterns = this.groupByError(failedObs);
    for (const [errorPattern, obs] of failurePatterns) {
      if (obs.length >= 2) {
        const memory = this.memoryStore.add({
          type: 'failure',
          content: `Repeated error pattern (${obs.length}x): ${errorPattern}. Tools: ${obs.map(o => o.toolName).join(', ')}`,
          tags: ['error-pattern', ...new Set(obs.map(o => o.toolName))],
          confidence: 0.85,
          avoidPattern: errorPattern,
        });
        newMemories.push(memory);
      }
    }

    // 3. Extract domain knowledge from successful tasks
    const completedTasks = tasks.filter(t => t.status === 'done' && t.result?.output);
    for (const task of completedTasks) {
      const output = task.result!.output.toLowerCase();
      if (
        output.includes('config') ||
        output.includes('package.json') ||
        output.includes('convention') ||
        output.includes('pattern') ||
        output.includes('framework')
      ) {
        const memory = this.memoryStore.add({
          type: 'semantic',
          content: `Project insight from "${task.description}": ${task.result!.output.slice(0, 300)}`,
          tags: ['project-insight', task.goalId],
          confidence: 0.65,
        });
        newMemories.push(memory);
      }
    }

    // 4. Extract learning products

    // 4a. Validators — generalize from completed tasks with validators
    const validatorProducts = this.extractValidatorProducts(completedTasks);
    learningProducts.push(...validatorProducts);
    for (const vp of validatorProducts) {
      newMemories.push(this.memoryStore.add({
        type: 'procedural',
        content: `Reusable validator (${vp.validator.type}): applies when "${vp.applicabilityPattern}"`,
        tags: ['learning-product', 'validator', vp.validator.type],
        confidence: vp.confidence,
        triggerPattern: vp.applicabilityPattern,
      }));
    }

    // 4b. Heuristics — from error→recovery pairs
    const heuristicProducts = this.extractHeuristicProducts(failedObs, tasks);
    learningProducts.push(...heuristicProducts);
    for (const hp of heuristicProducts) {
      newMemories.push(this.memoryStore.add({
        type: 'procedural',
        content: `Heuristic: If "${hp.condition}" then "${hp.action}"`,
        tags: ['learning-product', 'heuristic'],
        confidence: hp.confidence,
        triggerPattern: hp.condition,
      }));
    }

    // 4c. Task templates — from repeated goal structures
    const templateProducts = this.extractTaskTemplates(tasks);
    learningProducts.push(...templateProducts);
    for (const tp of templateProducts) {
      newMemories.push(this.memoryStore.add({
        type: 'procedural',
        content: `Task template "${tp.name}": ${tp.taskDescriptions.join(' → ')}`,
        tags: ['learning-product', 'task-template', tp.name],
        confidence: tp.confidence,
        triggerPattern: tp.applicabilityPattern,
      }));
    }

    debugLog.info('skill-synthesizer', 'Synthesis complete', {
      totalObservations: observations.length,
      patterns: patterns.length,
      failurePatterns: failurePatterns.size,
      newMemories: newMemories.length,
      learningProducts: learningProducts.length,
    });

    return { memories: newMemories, learningProducts };
  }

  // ── Learning product extractors ─────────────────────────

  /**
   * Extract reusable validator definitions from completed tasks.
   */
  private extractValidatorProducts(completedTasks: TaskNode[]): LearningProductValidator[] {
    const products: LearningProductValidator[] = [];
    const seenTypes = new Set<string>();

    for (const task of completedTasks) {
      for (const validator of task.validators) {
        const key = `${validator.type}:${validator.pattern || validator.command || validator.criterion || ''}`;
        if (seenTypes.has(key)) continue;
        seenTypes.add(key);

        const keywords = task.description
          .toLowerCase()
          .split(/\s+/)
          .filter(w => w.length > 4)
          .slice(0, 5)
          .join('|');

        if (keywords) {
          products.push({
            kind: 'validator',
            validator: { ...validator },
            applicabilityPattern: keywords,
            confidence: 0.7,
          });
        }
      }
    }

    return products;
  }

  /**
   * Extract heuristics from error→recovery pairs.
   * Pattern: "if error X happens with tool Y, do Z instead"
   */
  private extractHeuristicProducts(
    failedObs: Observation[],
    tasks: TaskNode[],
  ): LearningProductHeuristic[] {
    const products: LearningProductHeuristic[] = [];
    const errorGroups = this.groupByError(failedObs);

    for (const [errorPattern, obs] of errorGroups) {
      if (obs.length < 2) continue;

      // Check if any task containing this error eventually succeeded (recovery happened)
      const taskIds = new Set(obs.map(o => o.taskId));
      for (const taskId of taskIds) {
        const task = tasks.find(t => t.id === taskId);
        if (task && task.status === 'done' && task.retryCount > 0) {
          const toolNames = [...new Set(obs.filter(o => o.taskId === taskId).map(o => o.toolName))];
          products.push({
            kind: 'heuristic',
            condition: `Error "${errorPattern}" with ${toolNames.join('/')}`,
            action: `Retry with different approach (recovered after ${task.retryCount} retries)`,
            sourceErrorPattern: errorPattern,
            confidence: 0.65,
          });
        }
      }
    }

    return products;
  }

  /**
   * Extract task templates from the goal's task structure.
   * If ≥3 tasks completed with ≥70% success rate, the graph is a reusable template.
   */
  private extractTaskTemplates(tasks: TaskNode[]): LearningProductTaskTemplate[] {
    const products: LearningProductTaskTemplate[] = [];

    const completedTasks = tasks.filter(t => t.status === 'done');
    if (completedTasks.length < 3) return products;

    const successRate = completedTasks.length / Math.max(1, tasks.length);
    if (successRate < 0.7) return products;

    // Parameterize descriptions
    const descriptions = completedTasks.map(t =>
      t.description
        .replace(/['"][^'"]+['"]/g, '{{value}}')
        .replace(/\/[\w/.-]+/g, '{{path}}')
        .replace(/\b[A-Z]\w+\b/g, '{{Name}}'),
    );

    // Build index-based dependency map
    const taskIdToIndex = new Map(completedTasks.map((t, i) => [t.id, i]));
    const dependencyMap = completedTasks.map(t =>
      t.dependsOn
        .map(depId => taskIdToIndex.get(depId))
        .filter((idx): idx is number => idx !== undefined),
    );

    // Extract top keywords for applicability
    const allDescWords = completedTasks
      .flatMap(t => t.description.toLowerCase().split(/\s+/))
      .filter(w => w.length > 4);
    const wordFreq = new Map<string, number>();
    for (const w of allDescWords) {
      wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
    }
    const topWords = [...wordFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([w]) => w);

    if (topWords.length > 0) {
      const goalId = completedTasks[0]?.goalId || '';
      products.push({
        kind: 'task_template',
        name: `template_${goalId.slice(0, 20)}`,
        taskDescriptions: descriptions,
        dependencyMap,
        applicabilityPattern: topWords.join('|'),
        confidence: successRate * 0.8,
      });
    }

    return products;
  }

  // ── Tool pattern extraction ───────────────────────────────

  /**
   * Extract tool sequence patterns from observations.
   */
  private extractPatterns(observations: Observation[], tasks: TaskNode[]): ToolPattern[] {
    // Group observations by task
    const taskObsMap = new Map<string, Observation[]>();
    for (const obs of observations) {
      const list = taskObsMap.get(obs.taskId) || [];
      list.push(obs);
      taskObsMap.set(obs.taskId, list);
    }

    // Extract 2-tool and 3-tool sequences
    const sequenceCounts = new Map<string, { count: number; durations: number[]; successes: number }>();

    for (const [, taskObs] of taskObsMap) {
      // 2-grams
      for (let i = 0; i < taskObs.length - 1; i++) {
        const key = `${taskObs[i].toolName}→${taskObs[i + 1].toolName}`;
        const entry = sequenceCounts.get(key) || { count: 0, durations: [], successes: 0 };
        entry.count++;
        entry.durations.push(taskObs[i].duration + taskObs[i + 1].duration);
        if (taskObs[i].status === 'success' && taskObs[i + 1].status === 'success') {
          entry.successes++;
        }
        sequenceCounts.set(key, entry);
      }

      // 3-grams
      for (let i = 0; i < taskObs.length - 2; i++) {
        const key = `${taskObs[i].toolName}→${taskObs[i + 1].toolName}→${taskObs[i + 2].toolName}`;
        const entry = sequenceCounts.get(key) || { count: 0, durations: [], successes: 0 };
        entry.count++;
        entry.durations.push(taskObs[i].duration + taskObs[i + 1].duration + taskObs[i + 2].duration);
        if (taskObs[i].status === 'success' && taskObs[i + 1].status === 'success' && taskObs[i + 2].status === 'success') {
          entry.successes++;
        }
        sequenceCounts.set(key, entry);
      }
    }

    // Convert to ToolPattern
    const patterns: ToolPattern[] = [];
    for (const [key, data] of sequenceCounts) {
      const tools = key.split('→');
      const avgDuration = Math.round(data.durations.reduce((a, b) => a + b, 0) / data.durations.length);
      patterns.push({
        tools,
        frequency: data.count,
        avgDuration,
        successRate: data.successes / data.count,
      });
    }

    // Sort by frequency × success rate
    patterns.sort((a, b) => (b.frequency * b.successRate) - (a.frequency * a.successRate));

    return patterns.slice(0, 10); // top 10 patterns
  }

  /**
   * Group failed observations by their error message pattern.
   */
  private groupByError(failedObs: Observation[]): Map<string, Observation[]> {
    const groups = new Map<string, Observation[]>();

    for (const obs of failedObs) {
      // Normalize error message to a pattern
      const pattern = this.normalizeError(obs.result);
      const list = groups.get(pattern) || [];
      list.push(obs);
      groups.set(pattern, list);
    }

    return groups;
  }

  /**
   * Normalize an error message to a reusable pattern.
   * Strips file paths, line numbers, and variable values.
   */
  private normalizeError(errorMsg: string): string {
    return errorMsg
      .slice(0, 200)
      .replace(/\/[\w/.-]+/g, '<path>')        // file paths
      .replace(/\b\d+\b/g, '<n>')              // numbers
      .replace(/'[^']+'/g, "'<val>'")           // quoted strings
      .replace(/"[^"]+"/g, '"<val>"')           // double-quoted strings
      .replace(/\s+/g, ' ')                     // normalize whitespace
      .trim();
  }
}
