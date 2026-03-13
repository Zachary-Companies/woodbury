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

interface ReflectionMemoryCandidate {
  content: string;
  type?: MemoryRecord['type'];
  title?: string;
  tags?: string[];
  confidence?: number;
  applicabilityConditions?: string[];
}

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
    let structuredMemories: ReflectionMemoryCandidate[] = [];

    try {
      const response = await this.adapter.createCompletion({
        provider: this.provider,
        model: this.model,
        messages: [
          {
            role: 'system',
            content: 'You are a reflection assistant. Analyze work progress and extract lessons worth remembering. Respond in JSON: { "assessment": "...", "lessons": ["..."], "adjustments": ["..."], "memories": [{ "content": "...", "type": "semantic|procedural|failure|failure_pattern|preference|episodic", "title": "...", "tags": ["..."], "confidence": 0.0, "applicabilityConditions": ["..."] }] }. No markdown fences.',
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
      structuredMemories = Array.isArray(parsed.memories) ? parsed.memories : [];
    } catch {
      // Fallback — simple assessment without LLM
      assessment = `Progress: ${completed.length}/${nodes.length} tasks done, ${failed.length} failed. Trigger: ${trigger}.`;
      if (failed.length > 0) {
        lessonsLearned = failed.map(t => `"${t.description}" failed: ${t.result?.error || 'unknown'}`);
      }
    }

    // Create memories from lessons
    const newMemories: MemoryRecord[] = [];
    for (const memoryCandidate of this.selectMemoryCandidates(trigger, lessonsLearned, structuredMemories)) {
      const memory = this.memoryStore.add({
        type: memoryCandidate.type,
        title: memoryCandidate.title,
        content: memoryCandidate.content,
        tags: memoryCandidate.tags,
        confidence: memoryCandidate.confidence,
        applicabilityConditions: memoryCandidate.applicabilityConditions,
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

  private selectMemoryCandidates(
    trigger: ReflectionTrigger,
    lessonsLearned: string[],
    candidates: ReflectionMemoryCandidate[],
  ): Array<Required<Pick<MemoryRecord, 'type' | 'content' | 'tags' | 'confidence'>> & Pick<MemoryRecord, 'title' | 'applicabilityConditions'>> {
    const normalizedCandidates = candidates
      .map(candidate => this.normalizeMemoryCandidate(candidate, trigger))
      .filter((candidate): candidate is Required<Pick<MemoryRecord, 'type' | 'content' | 'tags' | 'confidence'>> & Pick<MemoryRecord, 'title' | 'applicabilityConditions'> => !!candidate)
      .map(candidate => ({
        candidate,
        score: this.scoreMemoryCandidate(candidate, trigger),
      }))
      .filter(({ candidate, score }) => this.isInterestingMemoryCandidate(candidate, trigger, score))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(({ candidate }) => candidate);

    if (normalizedCandidates.length > 0) {
      return normalizedCandidates;
    }

    return lessonsLearned
      .map(lesson => lesson.trim())
      .filter(Boolean)
      .map(lesson => ({
        type: this.inferMemoryType(lesson, trigger),
        title: undefined,
        content: lesson,
        tags: ['reflection', trigger],
        confidence: trigger === 'failure' ? 0.8 : 0.7,
        applicabilityConditions: undefined,
      }))
      .map(candidate => ({
        candidate,
        score: this.scoreMemoryCandidate(candidate, trigger),
      }))
      .filter(({ candidate, score }) => this.isInterestingMemoryCandidate(candidate, trigger, score))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(({ candidate }) => candidate);
  }

  private normalizeMemoryCandidate(
    candidate: ReflectionMemoryCandidate,
    trigger: ReflectionTrigger,
  ): (Required<Pick<MemoryRecord, 'type' | 'content' | 'tags' | 'confidence'>> & Pick<MemoryRecord, 'title' | 'applicabilityConditions'>) | null {
    if (!candidate || typeof candidate.content !== 'string' || !candidate.content.trim()) {
      return null;
    }

    const normalizedContent = this.cleanMemoryContent(candidate.content);
    if (!normalizedContent) {
      return null;
    }

    const tags = Array.from(new Set([
      'reflection',
      trigger,
      ...(Array.isArray(candidate.tags) ? candidate.tags.filter((tag): tag is string => typeof tag === 'string') : []),
    ].map(tag => tag.trim()).filter(Boolean)));

    return {
      type: this.inferMemoryType(candidate.type || normalizedContent, trigger),
      title: typeof candidate.title === 'string' && candidate.title.trim() ? candidate.title.trim() : undefined,
      content: normalizedContent,
      tags,
      confidence: Math.min(1, Math.max(0.1, typeof candidate.confidence === 'number' ? candidate.confidence : trigger === 'failure' ? 0.8 : 0.7)),
      applicabilityConditions: Array.isArray(candidate.applicabilityConditions)
        ? candidate.applicabilityConditions.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : undefined,
    };
  }

  private cleanMemoryContent(content: string): string {
    const normalized = content
      .replace(/\s+/g, ' ')
      .replace(/^[-*]\s*/, '')
      .trim();

    if (!normalized) {
      return '';
    }

    return normalized.replace(/^(lesson learned|note|memory):\s*/i, '').trim();
  }

  private scoreMemoryCandidate(
    candidate: Pick<MemoryRecord, 'type' | 'content' | 'tags' | 'confidence' | 'applicabilityConditions'>,
    trigger: ReflectionTrigger,
  ): number {
    const content = candidate.content.toLowerCase();
    let score = 0;

    if (candidate.content.length >= 24) score += 1;
    if (candidate.content.length >= 48) score += 1;
    if (candidate.confidence >= 0.8) score += 1;
    if (candidate.type === 'procedural' || candidate.type === 'failure' || candidate.type === 'failure_pattern' || candidate.type === 'preference') score += 2;
    if (this.hasActionablePattern(content)) score += 2;
    if (this.hasTechnicalAnchor(content, candidate.tags)) score += 2;
    if (candidate.type === 'failure' && /(error|failed|timeout|enoent|denied|invalid|exception|retry)/i.test(content)) score += 2;
    if (candidate.applicabilityConditions && candidate.applicabilityConditions.length > 0) score += 1;
    if (trigger === 'failure' || trigger === 'recovery') score += 1;

    if (this.isGenericStatusContent(content)) score -= 4;
    if (this.isEphemeralContent(content)) score -= 3;
    if (!this.hasActionablePattern(content) && !this.hasTechnicalAnchor(content, candidate.tags) && candidate.type === 'semantic') score -= 3;

    return score;
  }

  private isInterestingMemoryCandidate(
    candidate: Pick<MemoryRecord, 'type' | 'content' | 'tags' | 'confidence' | 'applicabilityConditions'>,
    trigger: ReflectionTrigger,
    score: number,
  ): boolean {
    if (candidate.content.length < 18) {
      return false;
    }

    if (this.isGenericStatusContent(candidate.content.toLowerCase())) {
      return false;
    }

    const minimumScore = trigger === 'failure' || trigger === 'recovery' ? 2 : 3;
    return score >= minimumScore;
  }

  private hasActionablePattern(content: string): boolean {
    return /(always|prefer|use |check |verify|confirm|before |after |when |if |avoid|remember to|must |should |workflow|procedure|steps|instead of|fall back)/i.test(content);
  }

  private hasTechnicalAnchor(content: string, tags: string[]): boolean {
    if (/[\w-]+\.[a-z]{2,5}\b/i.test(content)) {
      return true;
    }

    if (/\b(src|test|jest|npm|sqlite|sql|json|http|api|route|dashboard|memory|workflow|electron|node|typescript|javascript|python|env|port|selector|model|embedding|cache)\b/i.test(content)) {
      return true;
    }

    if (/[/~][\w./-]+/.test(content) || /`[^`]+`/.test(content) || /[A-Z_]{3,}/.test(content)) {
      return true;
    }

    return tags.some(tag => /(workflow|bug|failure|tool|dashboard|memory|project|test|build|api)/i.test(tag));
  }

  private isGenericStatusContent(content: string): boolean {
    return /^(good progress|made progress|progress update|things are going well|consider |continue |need to |remember this|worked on |completed task|task done|in progress|progress:)/i.test(content)
      || /(run tests more frequently|more frequently|keep going|next step is|follow up later)/i.test(content);
  }

  private isEphemeralContent(content: string): boolean {
    return /(today|yesterday|this session|just now|currently|for now|latest run|temporary|temp |scratch|debug print|console\.log)/i.test(content);
  }

  private inferMemoryType(candidate: string, trigger: ReflectionTrigger): MemoryRecord['type'] {
    if (candidate === 'episodic' || candidate === 'semantic' || candidate === 'procedural' || candidate === 'failure' || candidate === 'failure_pattern' || candidate === 'preference') {
      return candidate;
    }

    if (trigger === 'failure') {
      return 'failure';
    }

    const normalized = candidate.toLowerCase();
    if (/(failed|failure|error|timeout|enoent|denied|invalid|broken)/i.test(normalized)) {
      return 'failure';
    }
    if (/(always|prefer|use |check |before |after |workflow|procedure|steps)/i.test(normalized)) {
      return 'procedural';
    }
    if (/(user prefers|preference|likes|wants)/i.test(normalized)) {
      return 'preference';
    }

    return 'semantic';
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

    parts.push('', 'Analyze the progress, identify lessons learned, suggest any plan adjustments, and extract only durable memories that would help a future session avoid repeated mistakes or reuse useful procedures.');

    return parts.join('\n');
  }
}
