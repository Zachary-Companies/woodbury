/**
 * Reflector — Structured reflection for the Closure Engine.
 *
 * Triggers: every N completed tasks, any failure, any recovery, user request, goal complete.
 * Uses LLM to assess progress, identify lessons, propose plan adjustments,
 * and create memory records for future sessions.
 */

import type { ProviderAdapter } from '../v2/core/provider-adapter.js';
import type { StateManager } from './state-manager.js';
import type { MemoryStore } from './memory-store.js';
import type {
  ReflectionRecord,
  MemoryRecord,
  TaskNode,
  Observation,
  Belief,
} from './types.js';
import { debugLog } from '../../debug-log.js';

export type ReflectionTrigger = 'periodic' | 'failure' | 'recovery' | 'user_request' | 'goal_complete';

export class Reflector {
  constructor(
    private stateManager: StateManager,
    private memoryStore: MemoryStore,
    private adapter: ProviderAdapter,
    private provider: 'openai' | 'anthropic' | 'groq',
    private model: string,
  ) {}

  /**
   * Perform a reflection and produce a ReflectionRecord.
   */
  async reflect(trigger: ReflectionTrigger): Promise<ReflectionRecord> {
    const state = this.stateManager.getState();
    const nodes = state.taskGraph?.nodes || [];
    const completed = nodes.filter(n => n.status === 'done');
    const failed = nodes.filter(n => n.status === 'failed');
    const pending = nodes.filter(n => n.status === 'pending' || n.status === 'ready');
    const beliefs = state.beliefs.filter(b => b.status === 'active');
    const recentObs = state.observations.slice(-30);

    // Build context for LLM reflection
    const context = this.buildReflectionContext(trigger, completed, failed, pending, beliefs, recentObs);

    let assessment: string;
    let lessonsLearned: string[] = [];
    let planAdjustments: string[] = [];

    try {
      const response = await this.adapter.createCompletion({
        provider: this.provider,
        model: this.model,
        messages: [
          {
            role: 'system',
            content: 'You are a reflection assistant. Analyze work progress and extract lessons. Respond in JSON: { "assessment": "...", "lessons": ["..."], "adjustments": ["..."] }. No markdown fences.',
          },
          { role: 'user', content: context },
        ],
        maxTokens: 500,
        temperature: 0.3,
      });

      let json = response.content.trim();
      if (json.startsWith('```')) {
        json = json.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
      }

      const parsed = JSON.parse(json);
      assessment = parsed.assessment || `${completed.length} tasks done, ${failed.length} failed.`;
      lessonsLearned = parsed.lessons || [];
      planAdjustments = parsed.adjustments || [];
    } catch {
      // Fallback — simple assessment without LLM
      assessment = `Progress: ${completed.length}/${nodes.length} tasks done, ${failed.length} failed. Trigger: ${trigger}.`;
      if (failed.length > 0) {
        lessonsLearned = failed.map(t => `"${t.description}" failed: ${t.result?.error || 'unknown'}`);
      }
    }

    // Create memories from lessons
    const newMemories: MemoryRecord[] = [];
    for (const lesson of lessonsLearned) {
      const memory = this.memoryStore.add({
        type: trigger === 'failure' ? 'failure' : 'semantic',
        content: lesson,
        tags: ['reflection', trigger],
        confidence: 0.7,
      });
      newMemories.push(memory);
    }

    // Save reflection
    const reflection = this.stateManager.addReflection({
      trigger,
      assessment,
      lessonsLearned,
      planAdjustments,
      newMemories,
    });

    debugLog.info('reflector', `Reflection (${trigger})`, {
      assessment: assessment.slice(0, 100),
      lessons: lessonsLearned.length,
      adjustments: planAdjustments.length,
      newMemories: newMemories.length,
    });

    return reflection;
  }

  /**
   * Determine if reflection should be triggered based on task completion count.
   */
  shouldReflect(completedCount: number, interval: number): boolean {
    return completedCount > 0 && completedCount % interval === 0;
  }

  /**
   * Build the context string for the LLM reflection prompt.
   */
  private buildReflectionContext(
    trigger: ReflectionTrigger,
    completed: TaskNode[],
    failed: TaskNode[],
    pending: TaskNode[],
    beliefs: Belief[],
    recentObs: Observation[],
  ): string {
    const parts: string[] = [
      `Reflection trigger: ${trigger}`,
      '',
      `## Progress`,
      `- Completed: ${completed.length}`,
      `- Failed: ${failed.length}`,
      `- Pending: ${pending.length}`,
    ];

    if (completed.length > 0) {
      parts.push('', '## Completed Tasks');
      for (const t of completed.slice(-5)) {
        parts.push(`- ${t.description}`);
      }
    }

    if (failed.length > 0) {
      parts.push('', '## Failed Tasks');
      for (const t of failed) {
        parts.push(`- ${t.description}: ${t.result?.error || 'unknown error'}`);
      }
    }

    if (beliefs.length > 0) {
      parts.push('', '## Active Beliefs');
      for (const b of beliefs.slice(-10)) {
        parts.push(`- [${(b.confidence * 100).toFixed(0)}%] ${b.claim}`);
      }
    }

    if (recentObs.length > 0) {
      const errors = recentObs.filter(o => o.status === 'error');
      if (errors.length > 0) {
        parts.push('', '## Recent Errors');
        for (const o of errors.slice(-5)) {
          parts.push(`- ${o.toolName}: ${o.result.slice(0, 100)}`);
        }
      }
    }

    parts.push('', 'Analyze the progress, identify lessons learned, and suggest any plan adjustments.');

    return parts.join('\n');
  }
}
