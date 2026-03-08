/**
 * Confidence Engine — Multi-factor confidence calculation for beliefs.
 *
 * Computes confidence scores based on source reliability, agreement/contradiction,
 * verification status, and ambiguity detection. Maps scores to action tiers.
 */

import type { StateManager } from './state-manager.js';
import type { MemoryStore } from './memory-store.js';
import type { Belief } from './types.js';
import type { ToolDescriptorRegistry } from './tool-descriptor.js';

// ── Types ───────────────────────────────────────────────────

export interface ConfidenceFactors {
  sourceReliability: number;
  agreementScore: number;
  verificationBonus: number;
  ambiguityPenalty: number;
  contradictionPenalty: number;
  noveltyPenalty: number;
}

export type ConfidenceTier = 'auto' | 'double_check' | 'hypothesis' | 'unreliable';

// ── Ambiguity markers ──────────────────────────────────────

const AMBIGUITY_MARKERS = [
  'might', 'possibly', 'perhaps', 'maybe', 'could be',
  'uncertain', 'unclear', 'not sure', 'seems like',
  'appears to', 'likely', 'unlikely', 'probably',
];

// ── Engine ──────────────────────────────────────────────────

export class ConfidenceEngine {
  constructor(
    private stateManager: StateManager,
    private memoryStore: MemoryStore,
    private toolDescriptors?: ToolDescriptorRegistry,
  ) {}

  /**
   * Calculate confidence for a belief using multi-factor formula.
   *
   * score = sourceReliability*0.30 + agreementScore*0.25 + verificationBonus*0.20
   *       - ambiguityPenalty*0.10 - contradictionPenalty*0.10 - noveltyPenalty*0.05
   */
  calculateConfidence(belief: Belief): number {
    const factors = this.computeFactors(belief);

    const score =
      factors.sourceReliability * 0.30 +
      factors.agreementScore * 0.25 +
      factors.verificationBonus * 0.20 -
      factors.ambiguityPenalty * 0.10 -
      factors.contradictionPenalty * 0.10 -
      factors.noveltyPenalty * 0.05;

    // Clamp to [0, 1]
    return Math.max(0, Math.min(1, score));
  }

  /**
   * Get the confidence tier for a given confidence score.
   *
   * >= 0.90: auto — safe to act without verification
   * >= 0.75: double_check — act but verify afterward
   * >= 0.50: hypothesis — gather more evidence before acting
   * < 0.50: unreliable — do not act on this belief
   */
  getTier(confidence: number): ConfidenceTier {
    if (confidence >= 0.90) return 'auto';
    if (confidence >= 0.75) return 'double_check';
    if (confidence >= 0.50) return 'hypothesis';
    return 'unreliable';
  }

  /**
   * Recalibrate all active beliefs.
   */
  recalibrateAll(): void {
    const beliefs = this.stateManager.getBeliefs();
    for (const belief of beliefs) {
      const newConfidence = this.calculateConfidence(belief);
      // Update confidence directly on the belief object in state
      belief.confidence = newConfidence;
    }
  }

  /**
   * Compute the individual factors for a belief.
   */
  computeFactors(belief: Belief): ConfidenceFactors {
    return {
      sourceReliability: this.computeSourceReliability(belief),
      agreementScore: this.computeAgreementScore(belief),
      verificationBonus: this.computeVerificationBonus(belief),
      ambiguityPenalty: this.computeAmbiguityPenalty(belief),
      contradictionPenalty: this.computeContradictionPenalty(belief),
      noveltyPenalty: this.computeNoveltyPenalty(belief),
    };
  }

  // ── Factor Computation ───────────────────────────────────

  private computeSourceReliability(belief: Belief): number {
    // Check evidence reliability
    const evidenceIds = belief.evidenceIds || [];
    if (evidenceIds.length > 0) {
      const evidenceList = evidenceIds
        .map(id => this.stateManager.getEvidenceById(id))
        .filter(Boolean);
      if (evidenceList.length > 0) {
        const avg = evidenceList.reduce((sum, e) => sum + e!.reliability, 0) / evidenceList.length;
        return avg;
      }
    }

    // Fall back to tool descriptor reliability
    if (this.toolDescriptors && belief.source.type === 'tool_result') {
      const desc = this.toolDescriptors.get(belief.source.toolName);
      if (desc) return desc.avgReliability;
    }

    // Default: use the belief's own confidence as a baseline
    return belief.confidence;
  }

  private computeAgreementScore(belief: Belief): number {
    const edges = this.stateManager.getBeliefEdges(belief.id);
    const supportEdges = edges.filter(e => e.type === 'supports');
    // Normalize: 0 supports → 0.5, 1 → 0.7, 2+ → 0.9, 3+ → 1.0
    if (supportEdges.length === 0) return 0.5;
    if (supportEdges.length === 1) return 0.7;
    if (supportEdges.length === 2) return 0.9;
    return 1.0;
  }

  private computeVerificationBonus(belief: Belief): number {
    const edges = this.stateManager.getBeliefEdges(belief.id);
    const supportEdges = edges.filter(e => e.type === 'supports');

    if (supportEdges.length === 0) return 0;

    // Check if any supporting edge comes from a different source type
    const beliefs = this.stateManager.getState().beliefs;
    for (const edge of supportEdges) {
      const otherId = edge.fromBeliefId === belief.id ? edge.toBeliefId : edge.fromBeliefId;
      const other = beliefs.find(b => b.id === otherId);
      if (other && other.source.type !== belief.source.type) {
        return 1.0; // Cross-source verification
      }
    }

    return 0.3; // Same-source support is worth something
  }

  private computeAmbiguityPenalty(belief: Belief): number {
    const lower = belief.claim.toLowerCase();
    let markerCount = 0;
    for (const marker of AMBIGUITY_MARKERS) {
      if (lower.includes(marker)) markerCount++;
    }
    // Normalize: 0 markers → 0, 1 → 0.3, 2 → 0.6, 3+ → 1.0
    if (markerCount === 0) return 0;
    if (markerCount === 1) return 0.3;
    if (markerCount === 2) return 0.6;
    return 1.0;
  }

  private computeContradictionPenalty(belief: Belief): number {
    const edges = this.stateManager.getBeliefEdges(belief.id);
    const contradictions = edges.filter(e => e.type === 'contradicts');
    if (contradictions.length === 0) return 0;
    if (contradictions.length === 1) return 0.5;
    return 1.0;
  }

  private computeNoveltyPenalty(belief: Belief): number {
    // Check if there are matching memories for this belief's topic
    const keywords = belief.claim.split(/\s+/).filter(w => w.length > 4);
    if (keywords.length === 0) return 0;

    // Check first 3 keywords
    for (const keyword of keywords.slice(0, 3)) {
      const matches = this.memoryStore.query(keyword);
      if (matches.length > 0) return 0; // Has prior knowledge
    }

    return 0.5; // No prior knowledge — moderate penalty
  }
}
