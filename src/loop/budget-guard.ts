/**
 * Budget enforcement for agentic loops.
 *
 * Tracks LLM cost per iteration and enforces budget limits.
 * When limits are exceeded, the agent gracefully stops instead of throwing.
 */

export interface BudgetLimits {
  maxTotalTokens?: number;
  maxTotalCostUsd?: number;
  /** Fraction (0-1) at which to emit a warning. Default: 0.8 */
  warnAtPercent?: number;
}

export type BudgetStatus = 'ok' | 'warning' | 'exceeded';

export interface BudgetState {
  totalCostUsd: number;
  totalTokens: number;
  status: BudgetStatus;
}

// ── Pricing (inline to avoid cross-package dependency) ────────────

interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'claude-opus-4-6': { inputPer1M: 5, outputPer1M: 25 },
  'claude-sonnet-4-6': { inputPer1M: 3, outputPer1M: 15 },
  'claude-haiku-4-5-20251001': { inputPer1M: 1, outputPer1M: 5 },
  'claude-sonnet-4-5-20250929': { inputPer1M: 3, outputPer1M: 15 },
  'claude-opus-4-5-20251101': { inputPer1M: 5, outputPer1M: 25 },
  'claude-opus-4-1-20250805': { inputPer1M: 15, outputPer1M: 75 },
  'claude-sonnet-4-20250514': { inputPer1M: 3, outputPer1M: 15 },
  'claude-opus-4-20250514': { inputPer1M: 15, outputPer1M: 75 },
  // OpenAI
  'gpt-5.4': { inputPer1M: 2.50, outputPer1M: 15 },
  'gpt-5.4-mini': { inputPer1M: 0.75, outputPer1M: 4.50 },
  'gpt-4.1': { inputPer1M: 2, outputPer1M: 8 },
  'gpt-4.1-mini': { inputPer1M: 0.40, outputPer1M: 1.60 },
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10 },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.60 },
  'o4-mini': { inputPer1M: 1.10, outputPer1M: 4.40 },
  'o3': { inputPer1M: 2, outputPer1M: 8 },
  // Groq
  'llama-3.3-70b-versatile': { inputPer1M: 0.59, outputPer1M: 0.79 },
  'llama-3.1-8b-instant': { inputPer1M: 0.05, outputPer1M: 0.08 },
};

function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    return ((inputTokens * 3) + (outputTokens * 15)) / 1_000_000;
  }
  return (
    (inputTokens * pricing.inputPer1M) / 1_000_000 +
    (outputTokens * pricing.outputPer1M) / 1_000_000
  );
}

// ── Budget Tracker ────────────────────────────────────────────────

export class BudgetTracker {
  private totalCost = 0;
  private totalTokens = 0;
  private warningEmitted = false;

  /**
   * Record token usage from an LLM response.
   * Returns the incremental cost of this call.
   */
  addUsage(model: string, inputTokens: number, outputTokens: number): number {
    const cost = calculateCost(model, inputTokens, outputTokens);
    this.totalCost += cost;
    this.totalTokens += inputTokens + outputTokens;
    return cost;
  }

  getState(): BudgetState {
    return {
      totalCostUsd: this.totalCost,
      totalTokens: this.totalTokens,
      status: 'ok',
    };
  }

  /**
   * Check budget status against limits. Returns the status and
   * whether this is the first time a warning was triggered.
   */
  check(limits?: BudgetLimits): { status: BudgetStatus; firstWarning: boolean } {
    if (!limits) return { status: 'ok', firstWarning: false };

    // Check exceeded
    if (limits.maxTotalCostUsd != null && this.totalCost >= limits.maxTotalCostUsd) {
      return { status: 'exceeded', firstWarning: false };
    }
    if (limits.maxTotalTokens != null && this.totalTokens >= limits.maxTotalTokens) {
      return { status: 'exceeded', firstWarning: false };
    }

    // Check warning threshold
    const threshold = limits.warnAtPercent ?? 0.8;
    const isWarning =
      (limits.maxTotalCostUsd != null && this.totalCost >= limits.maxTotalCostUsd * threshold) ||
      (limits.maxTotalTokens != null && this.totalTokens >= limits.maxTotalTokens * threshold);

    if (isWarning) {
      const firstWarning = !this.warningEmitted;
      this.warningEmitted = true;
      return { status: 'warning', firstWarning };
    }

    return { status: 'ok', firstWarning: false };
  }

  getCost(): number { return this.totalCost; }
  getTokens(): number { return this.totalTokens; }
}
