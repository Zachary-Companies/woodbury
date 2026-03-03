/**
 * Visual Element Verifier
 *
 * Uses a trained ONNX model (via the inference server) to visually verify
 * that resolved elements match their recorded appearance. When verification
 * fails, searches nearby elements to find the correct one.
 *
 * Communicates with the Python inference server (woobury_models.serve) via HTTP.
 * All methods are non-throwing — returns null when verification can't run.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { BridgeInterface } from './types.js';

// ── Logging ─────────────────────────────────────────────────────

const _LOG_DIR = join(homedir(), '.woodbury', 'logs');
const _LOG_PATH = join(_LOG_DIR, 'execution.log');

function vvLog(level: string, msg: string, data?: any): void {
  try {
    mkdirSync(_LOG_DIR, { recursive: true });
    const ts = new Date().toISOString();
    let line = `[${ts}] [VISUAL:${level}] ${msg}`;
    if (data !== undefined) {
      try { line += ' ' + JSON.stringify(data); } catch { line += ' [unserializable]'; }
    }
    appendFileSync(_LOG_PATH, line + '\n');
  } catch { /* never break execution */ }
}

// ── Types ───────────────────────────────────────────────────────

export interface VerificationResult {
  /** Whether the element passed visual verification */
  verified: boolean;
  /** Cosine similarity score (0-1 for normalized embeddings) */
  similarity: number;
  /** Cached screenshot data URL for reuse in searchNearby */
  screenshotDataUrl?: string;
}

export interface SearchResult {
  /** Whether a visually matching element was found */
  found: boolean;
  /** Similarity score of the best match */
  similarity: number;
  /** Position of the best matching element */
  position: { left: number; top: number; width: number; height: number };
  /** How many candidates were evaluated */
  candidatesChecked: number;
}

interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

// ── Visual Verifier ─────────────────────────────────────────────

export class VisualVerifier {
  private serverUrl: string;
  private modelPath: string | null;
  private _available: boolean | null = null;
  private _lastHealthCheck = 0;
  private static readonly HEALTH_CHECK_INTERVAL_MS = 30_000;
  private static readonly VERIFY_THRESHOLD = 0.75;
  private static readonly SEARCH_THRESHOLD = 0.65;
  private static readonly SEARCH_RADIUS_PX = 200;

  constructor(serverUrl: string = 'http://127.0.0.1:8679', modelPath?: string) {
    this.serverUrl = serverUrl;
    this.modelPath = modelPath ?? null;
  }

  /**
   * Check if the inference server is reachable.
   * Result is cached for 30 seconds to avoid repeated health checks.
   */
  async isAvailable(): Promise<boolean> {
    const now = Date.now();
    if (this._available !== null && now - this._lastHealthCheck < VisualVerifier.HEALTH_CHECK_INTERVAL_MS) {
      return this._available;
    }

    try {
      const resp = await fetchWithTimeout(`${this.serverUrl}/health`, { method: 'GET' }, 2000);
      const data = await resp.json() as Record<string, unknown>;
      this._available = data.status === 'ready';
    } catch {
      this._available = false;
    }
    this._lastHealthCheck = now;
    return this._available;
  }

  /**
   * Verify that the element at `position` visually matches the reference image.
   *
   * Captures a viewport screenshot, sends the target region + reference to the
   * inference server, and returns whether they match.
   *
   * Returns null if verification can't run (server down, no reference, etc.).
   */
  async verifyElement(
    bridge: BridgeInterface,
    position: Bounds,
    referenceImagePath: string,
  ): Promise<VerificationResult | null> {
    try {
      // Check prerequisites
      if (!await this.isAvailable()) return null;
      if (!existsSync(referenceImagePath)) {
        vvLog('WARN', 'Reference image not found', { path: referenceImagePath });
        return null;
      }

      // Load reference image as base64
      const refBuffer = await readFile(referenceImagePath);
      const refBase64 = `data:image/png;base64,${refBuffer.toString('base64')}`;

      // Capture viewport screenshot
      const screenshotDataUrl = await this.captureViewport(bridge);
      if (!screenshotDataUrl) return null;

      // Send to inference server for comparison
      const resp = await fetchWithTimeout(`${this.serverUrl}/compare-region`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          screenshot: screenshotDataUrl,
          bounds: position,
          reference: refBase64,
          ...(this.modelPath ? { model: this.modelPath } : {}),
        }),
      }, 5000);

      const result = await resp.json() as { similarity: number };
      const verified = result.similarity >= VisualVerifier.VERIFY_THRESHOLD;

      vvLog('INFO', `verifyElement: similarity=${result.similarity.toFixed(4)} verified=${verified}`);

      return {
        verified,
        similarity: result.similarity,
        screenshotDataUrl,
      };
    } catch (err) {
      vvLog('ERROR', 'verifyElement failed', { error: String(err) });
      return null;
    }
  }

  /**
   * Search nearby interactive elements for the best visual match to the reference.
   *
   * Queries the bridge for all clickable elements near the expected position,
   * sends them all to the inference server, and returns the best match.
   *
   * When `expectedPct` is provided, uses the position-weighted endpoint that
   * combines visual similarity with spatial proximity to disambiguate
   * visually identical elements at different positions.
   *
   * @param screenshotDataUrl - Optional cached screenshot from verifyElement
   * @param expectedPct - Expected element center as viewport percentages (0-100)
   */
  async searchNearby(
    bridge: BridgeInterface,
    expectedPosition: Bounds,
    referenceImagePath: string,
    searchRadius: number = VisualVerifier.SEARCH_RADIUS_PX,
    screenshotDataUrl?: string,
    expectedPct?: { x: number; y: number },
  ): Promise<SearchResult | null> {
    try {
      if (!await this.isAvailable()) return null;
      if (!existsSync(referenceImagePath)) return null;

      // Load reference
      const refBuffer = await readFile(referenceImagePath);
      const refBase64 = `data:image/png;base64,${refBuffer.toString('base64')}`;

      // Capture screenshot if not provided
      let screenshot: string | null | undefined = screenshotDataUrl;
      if (!screenshot) {
        screenshot = await this.captureViewport(bridge);
        if (!screenshot) return null;
      }

      // Get all clickable elements from the bridge
      const elements = await this.getClickableElements(bridge);
      if (!elements || elements.length === 0) {
        vvLog('WARN', 'No clickable elements found for search');
        return null;
      }

      // Filter to elements within search radius of expected center
      const expCX = expectedPosition.left + expectedPosition.width / 2;
      const expCY = expectedPosition.top + expectedPosition.height / 2;

      const nearby = elements.filter((el: any) => {
        const b = el.position || el.bounds;
        if (!b) return false;
        const cx = b.left + b.width / 2;
        const cy = b.top + b.height / 2;
        const dist = Math.hypot(cx - expCX, cy - expCY);
        return dist <= searchRadius;
      });

      if (nearby.length === 0) {
        vvLog('INFO', 'No nearby elements within search radius', { searchRadius, expectedCenter: { x: expCX, y: expCY } });
        return null;
      }

      // Build candidate bounds list
      const candidateBounds: Bounds[] = nearby.map((el: any) => {
        const b = el.position || el.bounds;
        return {
          left: b.left ?? 0,
          top: b.top ?? 0,
          width: b.width ?? 0,
          height: b.height ?? 0,
        };
      });

      vvLog('INFO', `searchNearby: checking ${candidateBounds.length} candidates within ${searchRadius}px`, {
        hasPositionWeighting: !!expectedPct,
      });

      // Build request body — use weighted endpoint when position data available
      const useWeighted = !!expectedPct;
      const endpoint = useWeighted ? '/search-region-weighted' : '/search-region';

      const requestBody: Record<string, unknown> = {
        screenshot: screenshot,
        candidates: candidateBounds,
        reference: refBase64,
        ...(this.modelPath ? { model: this.modelPath } : {}),
      };

      if (useWeighted) {
        requestBody.expected_pct = expectedPct;
        // Get current viewport size for position % calculation
        const viewportSize = await this.getViewportSize(bridge);
        if (viewportSize) {
          requestBody.viewport = viewportSize;
        }
      }

      // Send to inference server for batch comparison
      const resp = await fetchWithTimeout(`${this.serverUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      }, 10000);

      const searchResult = await resp.json() as {
        results: Array<{ index: number; similarity: number; composite?: number }>;
        best_index: number;
        best_similarity: number;
        best_composite?: number;
      };

      // Use composite score for threshold check when available
      const bestScore = searchResult.best_composite ?? searchResult.best_similarity;

      if (bestScore >= VisualVerifier.SEARCH_THRESHOLD) {
        const bestBounds = candidateBounds[searchResult.best_index];
        vvLog('INFO', `searchNearby: found match at index=${searchResult.best_index} similarity=${searchResult.best_similarity.toFixed(4)} composite=${(searchResult.best_composite ?? searchResult.best_similarity).toFixed(4)}`, {
          position: bestBounds,
          weighted: useWeighted,
        });

        return {
          found: true,
          similarity: searchResult.best_similarity,
          position: bestBounds,
          candidatesChecked: candidateBounds.length,
        };
      }

      vvLog('INFO', `searchNearby: no match above threshold (best=${bestScore.toFixed(4)})`, { weighted: useWeighted });
      return {
        found: false,
        similarity: searchResult.best_similarity,
        position: expectedPosition,
        candidatesChecked: candidateBounds.length,
      };
    } catch (err) {
      vvLog('ERROR', 'searchNearby failed', { error: String(err) });
      return null;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────

  private async captureViewport(bridge: BridgeInterface): Promise<string | null> {
    try {
      const result = await bridge.send('capture_viewport') as Record<string, unknown>;
      if (result && typeof result === 'object') {
        // Handle nested data.image or direct image
        const data = result.data as Record<string, unknown> | undefined;
        const image = data?.image || result.image;
        if (typeof image === 'string') return image;
      }
      vvLog('WARN', 'capture_viewport returned no image');
      return null;
    } catch (err) {
      vvLog('ERROR', 'capture_viewport failed', { error: String(err) });
      return null;
    }
  }

  private async getViewportSize(bridge: BridgeInterface): Promise<{ width: number; height: number } | null> {
    try {
      const result = await bridge.send('get_viewport_size') as unknown;
      if (result && typeof result === 'object') {
        const obj = result as Record<string, unknown>;
        const w = Number(obj.width || obj.innerWidth || 0);
        const h = Number(obj.height || obj.innerHeight || 0);
        if (w > 0 && h > 0) return { width: w, height: h };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async getClickableElements(bridge: BridgeInterface): Promise<any[]> {
    try {
      const result = await bridge.send('get_clickable_elements') as unknown;
      if (Array.isArray(result)) return result;
      if (result && typeof result === 'object') {
        const obj = result as Record<string, unknown>;
        if (Array.isArray(obj.elements)) return obj.elements;
      }
      return [];
    } catch {
      return [];
    }
  }
}


// ── Fetch with timeout ──────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
