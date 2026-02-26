/**
 * Element Resolver
 *
 * Finds elements on the page using a multi-strategy fallback chain:
 *   1. Placeholder text (uniquely identifies form fields)
 *   2. Primary CSS selector (with multi-match disambiguation)
 *   3. Fallback selectors
 *   4. ARIA label
 *   5. Text content
 *   6. Natural language description
 *   7. Percentage-based viewport position (last resort)
 *
 * When multiple elements match a selector, uses percentage-based bounds
 * from recording to pick the closest match. If no element is found at all,
 * falls back to clicking at the recorded viewport percentage position.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ElementTarget, ElementBounds, ResolvedElement, BridgeInterface } from './types.js';

const _EXEC_LOG_DIR = join(homedir(), '.woodbury', 'logs');
const _EXEC_LOG_PATH = join(_EXEC_LOG_DIR, 'execution.log');
function resolverLog(level: string, msg: string, data?: any): void {
  try {
    mkdirSync(_EXEC_LOG_DIR, { recursive: true });
    const ts = new Date().toISOString();
    let line = `[${ts}] [RESOLVER:${level}] ${msg}`;
    if (data !== undefined) {
      try { line += ' ' + JSON.stringify(data); } catch { line += ' [unserializable]'; }
    }
    appendFileSync(_EXEC_LOG_PATH, line + '\n');
  } catch { /* never break resolver */ }
}

export class ElementResolver {
  constructor(private bridge: BridgeInterface) {}

  /**
   * Resolve an element target using the fallback chain.
   * Returns the resolved element info, or throws if not found.
   */
  async resolve(target: ElementTarget): Promise<ResolvedElement> {
    // 1. Placeholder — uniquely identifies form fields across DOM changes
    if (target.placeholder) {
      const result = await this.tryPlaceholder(target.placeholder);
      if (result) {
        return this.buildResult('placeholder', `[placeholder]`, result, target);
      }
    }

    // 2. Primary CSS selector — fetch multiple matches, pick best by position
    if (target.selector) {
      const result = await this.trySelectorWithDisambiguation(target.selector, target.expectedBounds);
      if (result) {
        return this.buildResult('selector', target.selector, result, target);
      }
    }

    // 3. Fallback selectors
    if (target.fallbackSelectors) {
      for (const sel of target.fallbackSelectors) {
        const result = await this.trySelectorWithDisambiguation(sel, target.expectedBounds);
        if (result) {
          return this.buildResult('fallback', sel, result, target);
        }
      }
    }

    // 4. ARIA label
    if (target.ariaLabel) {
      const result = await this.tryAriaLabel(target.ariaLabel);
      if (result) {
        return this.buildResult('ariaLabel', target.ariaLabel, result, target);
      }
    }

    // 5. Text content
    if (target.textContent) {
      const result = await this.tryTextContent(target.textContent);
      if (result) {
        return this.buildResult('textContent', target.textContent, result, target);
      }
    }

    // 6. Natural language description
    if (target.description) {
      const result = await this.tryDescription(target.description);
      if (result) {
        return this.buildResult('description', target.description, result, target);
      }
    }

    // 7. Percentage-based fallback — use recorded viewport percentages
    if (target.expectedBounds?.pctX != null && target.expectedBounds?.pctY != null) {
      const pctPosition = await this.resolveByPercentage(target.expectedBounds);
      if (pctPosition) {
        return {
          matchedBy: 'percentage',
          matchedValue: `pct(${target.expectedBounds.pctX}%, ${target.expectedBounds.pctY}%)`,
          position: pctPosition,
          boundsValid: null,
        };
      }
    }

    throw new Error(
      `Element not found. Tried: selector="${target.selector}"` +
      (target.placeholder ? `, placeholder="${target.placeholder}"` : '') +
      (target.fallbackSelectors ? `, fallbacks=[${target.fallbackSelectors.join(', ')}]` : '') +
      (target.ariaLabel ? `, aria-label="${target.ariaLabel}"` : '') +
      (target.textContent ? `, text="${target.textContent}"` : '') +
      (target.description ? `, description="${target.description}"` : '')
    );
  }

  /**
   * Find an element by placeholder attribute.
   * Placeholders are stable identifiers for form fields.
   */
  private async tryPlaceholder(
    placeholder: string
  ): Promise<BridgeElementResult | null> {
    try {
      // Escape quotes in placeholder for CSS selector
      const escaped = placeholder.replace(/"/g, '\\"');
      const data = await this.bridge.send('find_elements', {
        selector: `[placeholder="${escaped}"]`,
        limit: 1,
      }) as unknown;
      return this.extractFirst(data);
    } catch {
      return null;
    }
  }

  /**
   * Find elements by selector with multi-match disambiguation.
   * When multiple elements match, picks the one closest to expected bounds
   * using viewport-percentage-based distance calculation.
   */
  private async trySelectorWithDisambiguation(
    selector: string,
    expectedBounds?: ElementBounds
  ): Promise<BridgeElementResult | null> {
    try {
      const data = await this.bridge.send('find_elements', {
        selector,
        limit: 10, // Fetch up to 10 matches for disambiguation
      }) as unknown;

      const all = this.extractAll(data);
      resolverLog('INFO', `trySelectorWithDisambiguation: "${selector}"`, {
        matchCount: all.length,
        positions: all.map(a => a.position),
      });

      if (all.length === 0) return null;
      if (all.length === 1) return all[0];

      // Multiple matches — disambiguate using percentage-based bounds
      if (expectedBounds?.pctX != null && expectedBounds?.pctY != null) {
        const best = this.pickClosestByPercentage(all, expectedBounds);
        resolverLog('INFO', `disambiguation picked`, {
          expectedPct: { pctX: expectedBounds.pctX, pctY: expectedBounds.pctY },
          chosen: best.position,
        });
        return best;
      }

      // No percentage data — fall back to first match
      return all[0];
    } catch {
      return null;
    }
  }

  private async tryAriaLabel(
    ariaLabel: string
  ): Promise<BridgeElementResult | null> {
    try {
      const data = await this.bridge.send('find_elements', {
        selector: `[aria-label="${ariaLabel}"]`,
        limit: 1,
      }) as unknown;
      return this.extractFirst(data);
    } catch {
      return null;
    }
  }

  private async tryTextContent(
    text: string
  ): Promise<BridgeElementResult | null> {
    try {
      const data = await this.bridge.send('find_element_by_text', { text, limit: 5 }) as unknown;
      const all = this.extractAll(data);
      if (all.length === 0) return null;
      if (all.length === 1) return all[0];
      // No percentage-based disambiguation needed for text (usually unique enough)
      return all[0];
    } catch {
      return null;
    }
  }

  private async tryDescription(
    description: string
  ): Promise<BridgeElementResult | null> {
    try {
      const data = await this.bridge.send('find_interactive', { description, limit: 1 }) as unknown;
      return this.extractFirst(data);
    } catch {
      return null;
    }
  }

  /**
   * Calculate viewport position from percentage-based bounds.
   * Gets current viewport size from the bridge and scales percentages.
   */
  async resolveByPercentage(
    bounds: ElementBounds
  ): Promise<{ left: number; top: number; width: number; height: number } | null> {
    if (bounds.pctX == null || bounds.pctY == null) return null;

    try {
      // Get current viewport dimensions from the bridge
      const pageInfo = await this.bridge.send('get_page_info', {}) as unknown;
      let vpW = 0, vpH = 0;

      if (pageInfo && typeof pageInfo === 'object') {
        const info = pageInfo as Record<string, unknown>;
        // Try viewport object first
        const viewport = info.viewport as Record<string, number> | undefined;
        if (viewport?.width && viewport?.height) {
          vpW = viewport.width;
          vpH = viewport.height;
        } else if (typeof info.innerWidth === 'number' && typeof info.innerHeight === 'number') {
          vpW = info.innerWidth;
          vpH = info.innerHeight;
        }
      }

      // Fallback: use recorded viewport dimensions
      if (!vpW || !vpH) {
        vpW = bounds.viewportW || 1920;
        vpH = bounds.viewportH || 1080;
      }

      resolverLog('INFO', 'resolveByPercentage', {
        pctX: bounds.pctX, pctY: bounds.pctY, pctW: bounds.pctW, pctH: bounds.pctH,
        currentViewport: { vpW, vpH },
        recordedViewport: { viewportW: bounds.viewportW, viewportH: bounds.viewportH },
      });

      // Convert percentages to current viewport pixels
      const pctW = bounds.pctW || 0;
      const pctH = bounds.pctH || 0;
      const width = (pctW / 100) * vpW;
      const height = (pctH / 100) * vpH;
      const centerX = (bounds.pctX / 100) * vpW;
      const centerY = (bounds.pctY / 100) * vpH;

      return {
        left: Math.round(centerX - width / 2),
        top: Math.round(centerY - height / 2),
        width: Math.round(width),
        height: Math.round(height),
      };
    } catch {
      return null;
    }
  }

  /**
   * Pick the element whose center is closest to the expected percentage position.
   * Uses the current viewport dimensions to scale the expected percentages.
   */
  private pickClosestByPercentage(
    candidates: BridgeElementResult[],
    expectedBounds: ElementBounds
  ): BridgeElementResult {
    const pctX = expectedBounds.pctX!;
    const pctY = expectedBounds.pctY!;

    let best = candidates[0];
    let bestDist = Infinity;

    for (const candidate of candidates) {
      if (!candidate.position) continue;

      // Get the candidate's center relative to its own bounds
      const cx = candidate.position.left + candidate.position.width / 2;
      const cy = candidate.position.top + candidate.position.height / 2;

      // We need to compare in a resolution-independent way.
      // The candidate positions are viewport-relative pixels from getBoundingClientRect.
      // We can compare the candidate's pixel center against the expected pixel center
      // derived from the recorded viewport. But if the viewport changed, we need the
      // CURRENT viewport to convert percentages.
      //
      // For now, use the recorded viewport dimensions since we don't have the current
      // viewport in this sync context. This is accurate enough when the viewport
      // hasn't changed much (common case — same browser window).
      const vpW = expectedBounds.viewportW || 1920;
      const vpH = expectedBounds.viewportH || 1080;
      const expectedCX = (pctX / 100) * vpW;
      const expectedCY = (pctY / 100) * vpH;

      const dist = Math.hypot(cx - expectedCX, cy - expectedCY);
      if (dist < bestDist) {
        bestDist = dist;
        best = candidate;
      }
    }

    return best;
  }

  private extractFirst(data: unknown): BridgeElementResult | null {
    const all = this.extractAll(data);
    return all.length > 0 ? all[0] : null;
  }

  /**
   * Extract all element results from a bridge response.
   */
  private extractAll(data: unknown): BridgeElementResult[] {
    if (!data) return [];

    // Handle array responses
    if (Array.isArray(data)) {
      return data
        .map(item => this.normalizeBridgeResult(item))
        .filter((r): r is BridgeElementResult => r !== null);
    }

    // Handle object with elements array
    if (typeof data === 'object' && data !== null) {
      const obj = data as Record<string, unknown>;
      if (Array.isArray(obj.elements)) {
        return obj.elements
          .map((item: unknown) => this.normalizeBridgeResult(item))
          .filter((r): r is BridgeElementResult => r !== null);
      }
      // Direct element result
      if ('position' in obj || 'bounds' in obj || 'selector' in obj) {
        const result = this.normalizeBridgeResult(obj);
        return result ? [result] : [];
      }
    }

    return [];
  }

  private normalizeBridgeResult(raw: unknown): BridgeElementResult | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;

    const position = (obj.position || obj.bounds) as
      { left?: number; top?: number; width?: number; height?: number } | undefined;

    return {
      position: position ? {
        left: position.left ?? 0,
        top: position.top ?? 0,
        width: position.width ?? 0,
        height: position.height ?? 0,
      } : undefined,
      textContent: (obj.textContent || obj.text || obj.innerText) as string | undefined,
      selector: obj.selector as string | undefined,
    };
  }

  private buildResult(
    matchedBy: ResolvedElement['matchedBy'],
    matchedValue: string,
    bridgeResult: BridgeElementResult,
    target: ElementTarget
  ): ResolvedElement {
    const result: ResolvedElement = {
      matchedBy,
      matchedValue,
      position: bridgeResult.position,
      textContent: bridgeResult.textContent,
    };

    // Fuzzy bounds validation using percentage-based comparison
    if (target.expectedBounds && bridgeResult.position) {
      result.boundsValid = this.validateBounds(
        bridgeResult.position,
        target.expectedBounds
      );
    } else {
      result.boundsValid = null;
    }

    return result;
  }

  /**
   * Check if actual position is within tolerance of expected bounds.
   * Returns true if within tolerance, false otherwise.
   */
  private validateBounds(
    actual: { left: number; top: number; width: number; height: number },
    expected: { left: number; top: number; width: number; height: number; tolerance: number }
  ): boolean {
    const t = expected.tolerance;
    return (
      Math.abs(actual.left - expected.left) <= t &&
      Math.abs(actual.top - expected.top) <= t &&
      Math.abs(actual.width - expected.width) <= t &&
      Math.abs(actual.height - expected.height) <= t
    );
  }
}

interface BridgeElementResult {
  position?: { left: number; top: number; width: number; height: number };
  textContent?: string;
  selector?: string;
}
