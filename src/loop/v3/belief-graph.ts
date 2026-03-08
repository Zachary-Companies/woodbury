/**
 * Belief Graph — Structured belief tracking for the Closure Engine.
 *
 * Automatically derives beliefs from observations (tool results),
 * tracks confidence, invalidates contradictions, and serializes
 * beliefs into LLM-readable context for prompt injection.
 */

import type { StateManager } from './state-manager.js';
import type { Belief, EvidenceSource, Observation, BeliefEdge, BeliefEdgeType } from './types.js';
import { debugLog } from '../../debug-log.js';

/** Mapping of tool names to belief derivation rules. */
interface DerivationRule {
  /** Tool name that triggers this rule */
  toolName: string;
  /** Function to derive a claim from the observation */
  deriveClaim: (obs: Observation) => string | null;
  /** Base confidence for derived beliefs */
  baseConfidence: number;
}

const DERIVATION_RULES: DerivationRule[] = [
  {
    toolName: 'file_read',
    deriveClaim: (obs) => {
      const path = obs.params.path as string;
      return path ? `File "${path}" exists and is readable` : null;
    },
    baseConfidence: 0.95,
  },
  {
    toolName: 'file_write',
    deriveClaim: (obs) => {
      const path = obs.params.path as string;
      return path ? `File "${path}" was written/updated successfully` : null;
    },
    baseConfidence: 0.95,
  },
  {
    toolName: 'list_directory',
    deriveClaim: (obs) => {
      const path = obs.params.path as string;
      return path ? `Directory "${path}" exists and is listable` : null;
    },
    baseConfidence: 0.95,
  },
  {
    toolName: 'shell_execute',
    deriveClaim: (obs) => {
      const cmd = String(obs.params.command || '').slice(0, 80);
      return cmd ? `Command "${cmd}" executed successfully` : null;
    },
    baseConfidence: 0.85,
  },
  {
    toolName: 'test_runner',
    deriveClaim: (obs) => {
      if (obs.status === 'success') {
        // Check if output indicates all tests passing
        const result = obs.result.toLowerCase();
        if (/\b0\s*fail/i.test(result) || /all.*pass/i.test(result)) {
          return 'All tests are passing';
        }
        return 'Test suite executed (check results)';
      }
      return null;
    },
    baseConfidence: 0.90,
  },
  {
    toolName: 'git',
    deriveClaim: (obs) => {
      const subcmd = obs.params.subcommand || obs.params.command;
      if (subcmd === 'status') {
        return `Git status checked: ${obs.result.slice(0, 80)}`;
      }
      if (subcmd === 'commit') {
        return 'Git commit created successfully';
      }
      return null;
    },
    baseConfidence: 0.90,
  },
  {
    toolName: 'grep',
    deriveClaim: (obs) => {
      const pattern = obs.params.pattern as string;
      const path = obs.params.path as string;
      if (pattern && obs.result.length > 0) {
        return `Pattern "${pattern}" found in ${path || 'codebase'}`;
      }
      return null;
    },
    baseConfidence: 0.85,
  },
  {
    toolName: 'web_fetch',
    deriveClaim: (obs) => {
      const url = obs.params.url as string;
      return url ? `URL "${url.slice(0, 80)}" is accessible` : null;
    },
    baseConfidence: 0.80,
  },
];

export class BeliefGraph {
  constructor(private stateManager: StateManager) {}

  /**
   * Derive beliefs from an observation using the derivation rules.
   * Returns the new belief if one was created, null otherwise.
   */
  deriveFromObservation(obs: Observation): Belief | null {
    if (obs.status !== 'success') {
      // Failed observations can invalidate beliefs
      this.invalidateContradictions(obs);
      return null;
    }

    // Find matching derivation rule
    const rule = DERIVATION_RULES.find(r => r.toolName === obs.toolName);
    if (!rule) return null;

    const claim = rule.deriveClaim(obs);
    if (!claim) return null;

    // Create evidence record from this observation
    const evidence = this.stateManager.addEvidence({
      type: 'tool_result',
      source: obs.toolName,
      contentSummary: obs.result.slice(0, 200),
      rawRef: obs.id,
      reliability: rule.baseConfidence,
    });

    // Check for existing identical belief
    const existing = this.stateManager.getBeliefs();
    const duplicate = existing.find(b => b.claim === claim && b.status === 'active');
    if (duplicate) {
      // Link new evidence to existing belief
      if (!duplicate.evidenceIds) duplicate.evidenceIds = [];
      duplicate.evidenceIds.push(evidence.id);
      // Create 'supports' edge from new observation
      this.addEdge(duplicate.id, duplicate.id, 'supports', rule.baseConfidence);
      return duplicate;
    }

    // Find beliefs that will be superseded
    const superseded = this.findSupersededBeliefs(claim, obs);

    // Invalidate contradicting beliefs
    this.invalidateRelated(claim, obs);

    // Create new belief with evidence link
    const source: EvidenceSource = {
      type: 'tool_result',
      toolName: obs.toolName,
      actionId: obs.actionId,
    };

    const belief = this.stateManager.addBelief({
      claim,
      confidence: rule.baseConfidence,
      source,
      status: 'active',
      evidenceIds: [evidence.id],
    });

    // Create 'derived_from' edges for superseded beliefs
    for (const old of superseded) {
      this.addEdge(belief.id, old.id, 'updated_by', 0.8);
    }

    debugLog.debug('belief-graph', `New belief: ${claim}`, {
      confidence: rule.baseConfidence,
      source: obs.toolName,
    });

    return belief;
  }

  /**
   * Invalidate beliefs that contradict a failed observation.
   */
  private invalidateContradictions(obs: Observation): void {
    const beliefs = this.stateManager.getBeliefs();

    for (const belief of beliefs) {
      let shouldInvalidate = false;

      // A failed file_read invalidates "file exists" beliefs for that path
      if (obs.toolName === 'file_read' && obs.params.path) {
        if (belief.claim.includes(`"${obs.params.path}"`)) {
          shouldInvalidate = true;
        }
      }

      // A failed test run invalidates "tests are passing"
      if (obs.toolName === 'test_runner' && belief.claim.includes('tests are passing')) {
        shouldInvalidate = true;
      }

      // A failed shell command invalidates beliefs about that command
      if (obs.toolName === 'shell_execute' && obs.params.command) {
        const cmdStr = String(obs.params.command).slice(0, 80);
        if (belief.claim.includes(`"${cmdStr}"`)) {
          shouldInvalidate = true;
        }
      }

      if (shouldInvalidate) {
        this.stateManager.invalidateBelief(belief.id, `Contradicted by failed ${obs.toolName} (${obs.id})`);
        // Create a 'contradicts' edge (self-referential as placeholder since obs has no belief)
        this.addEdge(belief.id, belief.id, 'contradicts', 0.9);
        debugLog.debug('belief-graph', `Invalidated belief: ${belief.claim.slice(0, 60)}`);
      }
    }
  }

  /**
   * Invalidate beliefs that are superseded by a new claim.
   */
  private invalidateRelated(newClaim: string, obs: Observation): void {
    const beliefs = this.stateManager.getBeliefs();

    // Extract the key subject from the claim (e.g., file path, command)
    const pathMatch = newClaim.match(/"([^"]+)"/);
    const subject = pathMatch ? pathMatch[1] : null;
    if (!subject) return;

    for (const belief of beliefs) {
      // Only invalidate beliefs about the same subject with different claims
      if (belief.claim !== newClaim && belief.claim.includes(`"${subject}"`)) {
        this.stateManager.invalidateBelief(belief.id, `Superseded by ${obs.id}`);
      }
    }
  }

  /**
   * Get beliefs above a confidence threshold.
   */
  getHighConfidenceBeliefs(minConfidence: number = 0.7): Belief[] {
    return this.stateManager.getBeliefs().filter(b => b.confidence >= minConfidence);
  }

  /**
   * Serialize active beliefs into a context string for LLM prompts.
   */
  toContextString(maxBeliefs: number = 20): string {
    const beliefs = this.stateManager.getBeliefs()
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, maxBeliefs);

    if (beliefs.length === 0) return '';

    const lines = beliefs.map(b => {
      const pct = (b.confidence * 100).toFixed(0);
      return `- [${pct}%] ${b.claim}`;
    });

    return `## Current Beliefs\n${lines.join('\n')}`;
  }

  /**
   * Apply confidence decay to all active beliefs.
   * Called periodically to ensure stale beliefs lose influence.
   */
  decayConfidence(factor: number = 0.95): void {
    const beliefs = this.stateManager.getBeliefs();
    for (const belief of beliefs) {
      if (belief.confidence > 0.3) {
        // We can't directly modify beliefs through state manager currently,
        // so we invalidate very low confidence ones
        const newConf = belief.confidence * factor;
        if (newConf < 0.3) {
          this.stateManager.invalidateBelief(belief.id, 'Confidence decayed below threshold');
        }
      }
    }
  }

  // ── Typed Edge Methods ───────────────────────────────────

  /**
   * Add a typed edge between beliefs.
   */
  addEdge(fromBeliefId: string, toBeliefId: string, type: BeliefEdgeType, weight: number): BeliefEdge {
    return this.stateManager.addBeliefEdge({
      fromBeliefId,
      toBeliefId,
      type,
      weight,
    });
  }

  /**
   * Get beliefs that support a given belief.
   */
  getSupportingBeliefs(beliefId: string): Belief[] {
    const edges = this.stateManager.getBeliefEdges(beliefId)
      .filter(e => e.type === 'supports' && e.toBeliefId === beliefId);
    const beliefs = this.stateManager.getBeliefs();
    return edges.map(e => beliefs.find(b => b.id === e.fromBeliefId)).filter(Boolean) as Belief[];
  }

  /**
   * Get beliefs that contradict a given belief.
   */
  getContradictingBeliefs(beliefId: string): Belief[] {
    const edges = this.stateManager.getBeliefEdges(beliefId)
      .filter(e => e.type === 'contradicts');
    const beliefs = this.stateManager.getBeliefs();
    const ids = new Set(edges.map(e =>
      e.fromBeliefId === beliefId ? e.toBeliefId : e.fromBeliefId
    ));
    return beliefs.filter(b => ids.has(b.id));
  }

  /**
   * Get the evidence chain for a belief (evidence IDs from the belief + linked evidence).
   */
  getEvidenceChain(beliefId: string): string[] {
    const beliefs = this.stateManager.getState().beliefs;
    const belief = beliefs.find(b => b.id === beliefId);
    if (!belief) return [];
    return belief.evidenceIds || [];
  }

  /**
   * Find beliefs that will be superseded by a new claim.
   */
  private findSupersededBeliefs(newClaim: string, obs: Observation): Belief[] {
    const beliefs = this.stateManager.getBeliefs();
    const pathMatch = newClaim.match(/"([^"]+)"/);
    const subject = pathMatch ? pathMatch[1] : null;
    if (!subject) return [];

    return beliefs.filter(
      b => b.claim !== newClaim && b.claim.includes(`"${subject}"`) && b.status === 'active'
    );
  }
}
