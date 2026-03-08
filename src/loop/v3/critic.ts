/**
 * Critic — Blind spot detection, plan critique, and false success validation.
 *
 * Uses LLM to identify hidden assumptions, weak evidence, false success risks,
 * tool misuses, and missing edge cases. Falls back to heuristic analysis if LLM
 * is unavailable.
 */

import type { ProviderAdapter } from '../v2/core/provider-adapter.js';
import type { Goal, Belief, Evidence } from './types.js';
import type { CandidatePlan } from './strategic-planner.js';
import { debugLog } from '../../debug-log.js';

// ── Types ───────────────────────────────────────────────────

export interface CritiqueResult {
  hiddenAssumptions: string[];
  weakEvidence: string[];
  falseSuccessRisks: string[];
  toolMisuses: string[];
  missingEdgeCases: string[];
  overallRisk: 'low' | 'medium' | 'high';
  recommendation: 'proceed' | 'revise' | 'abort';
  suggestedActions?: string[];
}

// ── Critic ──────────────────────────────────────────────────

export class Critic {
  constructor(
    private adapter: ProviderAdapter,
    private provider: 'openai' | 'anthropic' | 'groq',
    private model: string,
  ) {}

  /**
   * Critique a candidate plan using the LLM.
   */
  async critiquePlan(plan: CandidatePlan, goal: Goal): Promise<CritiqueResult> {
    const taskDescriptions = plan.taskGraph.nodes
      .map((n, i) => `${i + 1}. ${n.description} (validators: ${n.validators.length})`)
      .join('\n');

    const prompt = [
      'You are a critical reviewer of task execution plans.',
      'Analyze this plan for blind spots, weak evidence, and potential false success.',
      '',
      `## Goal: ${goal.objective}`,
      `## Strategy: ${plan.strategy}`,
      `## Tasks:\n${taskDescriptions}`,
      '',
      'Respond ONLY with valid JSON:',
      '{',
      '  "hiddenAssumptions": ["assumption 1", ...],',
      '  "weakEvidence": ["weakness 1", ...],',
      '  "falseSuccessRisks": ["risk 1", ...],',
      '  "toolMisuses": [],',
      '  "missingEdgeCases": ["case 1", ...],',
      '  "overallRisk": "low" | "medium" | "high",',
      '  "recommendation": "proceed" | "revise" | "abort",',
      '  "suggestedActions": ["action 1", ...]',
      '}',
    ].join('\n');

    try {
      const response = await this.adapter.createCompletion({
        provider: this.provider,
        model: this.model,
        messages: [
          { role: 'system', content: 'You are a plan critique assistant. Respond ONLY with valid JSON.' },
          { role: 'user', content: prompt },
        ],
        maxTokens: 800,
        temperature: 0.3,
      });

      let json = response.content.trim();
      if (json.startsWith('```')) {
        json = json.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
      }

      const parsed = JSON.parse(json);
      return {
        hiddenAssumptions: parsed.hiddenAssumptions || [],
        weakEvidence: parsed.weakEvidence || [],
        falseSuccessRisks: parsed.falseSuccessRisks || [],
        toolMisuses: parsed.toolMisuses || [],
        missingEdgeCases: parsed.missingEdgeCases || [],
        overallRisk: parsed.overallRisk || 'medium',
        recommendation: parsed.recommendation || 'proceed',
        suggestedActions: parsed.suggestedActions,
      };
    } catch (err) {
      debugLog.debug('critic', 'LLM critique failed, using heuristic', { error: String(err) });
      return this.heuristicCritique(plan, goal);
    }
  }

  /**
   * Detect blind spots by analyzing beliefs and evidence for gaps.
   */
  async detectBlindSpots(
    goal: Goal,
    beliefs: Belief[],
    evidence: Evidence[],
  ): Promise<string[]> {
    const blindSpots: string[] = [];

    // Check for low-confidence beliefs related to the goal
    const lowConf = beliefs.filter(b => b.confidence < 0.5 && b.status === 'active');
    if (lowConf.length > 0) {
      blindSpots.push(`${lowConf.length} low-confidence beliefs may need verification`);
    }

    // Check for areas with no evidence
    if (evidence.length === 0) {
      blindSpots.push('No evidence collected yet — all beliefs are unverified assumptions');
    }

    // Check for single-source evidence
    const sources = new Set(evidence.map(e => e.source));
    if (sources.size === 1 && evidence.length > 1) {
      blindSpots.push('All evidence comes from a single source — cross-verification needed');
    }

    // Check for low-reliability evidence
    const lowReliability = evidence.filter(e => e.reliability < 0.5);
    if (lowReliability.length > evidence.length * 0.5 && evidence.length > 0) {
      blindSpots.push('More than half of evidence has low reliability');
    }

    // Check success criteria coverage
    const unmetCriteria = goal.successCriteria.filter(c => !c.met);
    if (unmetCriteria.length > 0) {
      blindSpots.push(`${unmetCriteria.length} success criteria not yet met`);
    }

    return blindSpots;
  }

  /**
   * Validate whether a claimed success is genuine by examining the evidence.
   */
  async validateSuccess(
    goal: Goal,
    evidence: Evidence[],
  ): Promise<{ genuine: boolean; concerns: string[] }> {
    const concerns: string[] = [];

    // Check if all success criteria are met
    const unmetCriteria = goal.successCriteria.filter(c => !c.met);
    if (unmetCriteria.length > 0) {
      concerns.push(`${unmetCriteria.length} success criteria marked as unmet`);
    }

    // Check if there's sufficient evidence
    if (evidence.length === 0) {
      concerns.push('No evidence supports this success claim');
    }

    // Check evidence reliability
    const avgReliability = evidence.length > 0
      ? evidence.reduce((sum, e) => sum + e.reliability, 0) / evidence.length
      : 0;
    if (avgReliability < 0.6) {
      concerns.push(`Average evidence reliability is low (${(avgReliability * 100).toFixed(0)}%)`);
    }

    // Check for error evidence
    const errorEvidence = evidence.filter(e => e.contentSummary.toLowerCase().includes('error'));
    if (errorEvidence.length > 0) {
      concerns.push(`${errorEvidence.length} evidence items contain error indicators`);
    }

    const genuine = concerns.length === 0;
    return { genuine, concerns };
  }

  // ── Heuristic fallback ───────────────────────────────────

  private heuristicCritique(plan: CandidatePlan, goal: Goal): CritiqueResult {
    const hiddenAssumptions: string[] = [];
    const weakEvidence: string[] = [];
    const missingEdgeCases: string[] = [];

    const taskCount = plan.taskGraph.nodes.length;

    // Single-task plans might oversimplify
    if (taskCount === 1 && goal.successCriteria.length > 1) {
      hiddenAssumptions.push('Single task may not address all success criteria');
    }

    // Tasks without validators
    const unvalidated = plan.taskGraph.nodes.filter(n => n.validators.length === 0);
    if (unvalidated.length > 0) {
      weakEvidence.push(`${unvalidated.length} tasks have no validators — success cannot be verified`);
    }

    // No dependencies in multi-task plans
    if (taskCount > 2) {
      const noDeps = plan.taskGraph.nodes.filter(n => n.dependsOn.length === 0);
      if (noDeps.length === taskCount) {
        missingEdgeCases.push('No task dependencies — tasks might have implicit ordering');
      }
    }

    const overallRisk: 'low' | 'medium' | 'high' =
      (hiddenAssumptions.length + weakEvidence.length + missingEdgeCases.length) > 3 ? 'high' :
      (hiddenAssumptions.length + weakEvidence.length + missingEdgeCases.length) > 1 ? 'medium' : 'low';

    return {
      hiddenAssumptions,
      weakEvidence,
      falseSuccessRisks: [],
      toolMisuses: [],
      missingEdgeCases,
      overallRisk,
      recommendation: overallRisk === 'high' ? 'revise' : 'proceed',
    };
  }
}
