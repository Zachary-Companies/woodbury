/**
 * Condition Validator
 *
 * Evaluates preconditions and postconditions for workflow steps
 * by querying the browser state via the bridge server.
 */

import type {
  Precondition,
  Postcondition,
  AssertCondition,
  WaitCondition,
  BridgeInterface,
  ElementTarget,
} from './types.js';
import { ElementResolver } from './resolver.js';
import { substituteString } from './variable-sub.js';

export class ConditionValidator {
  private resolver: ElementResolver;

  constructor(private bridge: BridgeInterface) {
    this.resolver = new ElementResolver(bridge);
  }

  /**
   * Evaluate a precondition. Returns true if it passes.
   */
  async checkPrecondition(condition: Precondition): Promise<boolean> {
    switch (condition.type) {
      case 'url_matches':
        return this.checkUrlMatches(condition.pattern);

      case 'url_contains':
        return this.checkUrlContains(condition.substring);

      case 'element_exists':
        return this.checkElementExists(condition.target);

      case 'element_visible':
        return this.checkElementVisible(condition.target);

      case 'element_text_matches':
        return this.checkElementTextMatches(condition.target, condition.pattern);

      default:
        return true;
    }
  }

  /**
   * Evaluate a postcondition. Returns true if it passes.
   * For url_changed, the previousUrl must be provided.
   */
  async checkPostcondition(
    condition: Postcondition,
    previousUrl?: string
  ): Promise<boolean> {
    switch (condition.type) {
      case 'url_changed': {
        const currentUrl = await this.getCurrentUrl();
        return currentUrl !== previousUrl;
      }

      case 'url_matches':
        return this.checkUrlMatches(condition.pattern);

      case 'element_appeared':
        return this.checkElementExists(condition.target);

      case 'element_disappeared':
        return !(await this.checkElementExists(condition.target));

      case 'element_text_changed':
        // Can't fully check without previous text — just verify element exists
        return this.checkElementExists(condition.target);

      default:
        return true;
    }
  }

  /**
   * Evaluate an assert condition. Returns true if it passes.
   */
  async checkAssertCondition(
    condition: AssertCondition,
    variables?: Record<string, unknown>
  ): Promise<boolean> {
    switch (condition.type) {
      case 'element_exists':
        return this.checkElementExists(condition.target);

      case 'element_visible':
        return this.checkElementVisible(condition.target);

      case 'element_text_matches':
        return this.checkElementTextMatches(condition.target, condition.pattern);

      case 'url_matches':
        return this.checkUrlMatches(condition.pattern);

      case 'url_contains':
        return this.checkUrlContains(condition.substring);

      case 'page_title_contains':
        return this.checkPageTitleContains(condition.text);

      case 'variable_equals':
        if (!variables) return false;
        return variables[condition.variable] === condition.value;

      case 'expression': {
        try {
          const substituted = substituteString(condition.expression, variables || {});
          const expr = typeof substituted === 'string' ? substituted : String(substituted);
          // Same pattern used by composition Branch nodes
          const result = new Function('return (' + expr + ')')();
          return !!result;
        } catch {
          return false;
        }
      }

      default:
        return true;
    }
  }

  /**
   * Wait for a condition to become true, with polling.
   * Returns true if condition was met, false if timeout.
   */
  async waitForCondition(
    condition: WaitCondition,
    timeoutMs: number = 30000,
    pollIntervalMs: number = 500,
    signal?: AbortSignal
  ): Promise<boolean> {
    if (condition.type === 'delay') {
      await this.delay(condition.ms, signal);
      return true;
    }

    if (condition.type === 'network_idle') {
      // Network idle is hard to detect via bridge — just wait
      await this.delay(condition.timeoutMs || 3000, signal);
      return true;
    }

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (signal?.aborted) return false;

      const result = await this.checkWaitCondition(condition);
      if (result) return true;

      await this.delay(pollIntervalMs, signal);
    }

    return false;
  }

  private async checkWaitCondition(condition: WaitCondition): Promise<boolean> {
    switch (condition.type) {
      case 'element_visible':
        return this.checkElementVisible(condition.target);

      case 'element_hidden':
        return !(await this.checkElementVisible(condition.target));

      case 'url_matches':
        return this.checkUrlMatches(condition.pattern);

      case 'url_contains':
        return this.checkUrlContains(condition.substring);

      case 'text_appears':
        return this.checkPageTextContains(condition.text);

      case 'text_disappears':
        return !(await this.checkPageTextContains(condition.text));

      default:
        return true;
    }
  }

  // ── Helper methods ──────────────────────────────────────────

  private async getCurrentUrl(): Promise<string> {
    try {
      const info = await this.bridge.send('get_page_info') as Record<string, unknown>;
      return (info?.url as string) || '';
    } catch {
      return '';
    }
  }

  private async checkUrlMatches(pattern: string): Promise<boolean> {
    const url = await this.getCurrentUrl();
    try {
      return new RegExp(pattern).test(url);
    } catch {
      return url.includes(pattern);
    }
  }

  private async checkUrlContains(substring: string): Promise<boolean> {
    const url = await this.getCurrentUrl();
    return url.includes(substring);
  }

  private async checkElementExists(target: ElementTarget): Promise<boolean> {
    try {
      await this.resolver.resolve(target);
      return true;
    } catch {
      return false;
    }
  }

  private async checkElementVisible(target: ElementTarget): Promise<boolean> {
    try {
      const resolved = await this.resolver.resolve(target);
      // If we found it and it has a position, consider it visible
      return !!resolved.position;
    } catch {
      return false;
    }
  }

  private async checkElementTextMatches(
    target: ElementTarget,
    pattern: string
  ): Promise<boolean> {
    try {
      const resolved = await this.resolver.resolve(target);
      if (!resolved.textContent) return false;
      try {
        return new RegExp(pattern).test(resolved.textContent);
      } catch {
        return resolved.textContent.includes(pattern);
      }
    } catch {
      return false;
    }
  }

  private async checkPageTitleContains(text: string): Promise<boolean> {
    try {
      const info = await this.bridge.send('get_page_info') as Record<string, unknown>;
      const title = (info?.title as string) || '';
      return title.includes(text);
    } catch {
      return false;
    }
  }

  private async checkPageTextContains(text: string): Promise<boolean> {
    try {
      const result = await this.bridge.send('get_page_text') as any;
      const pageText = typeof result === 'string' ? result : result?.text || '';
      return pageText.includes(text);
    } catch {
      return false;
    }
  }

  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Aborted'));
        }, { once: true });
      }
    });
  }
}
