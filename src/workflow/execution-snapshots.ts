/**
 * ExecutionSnapshotCapture — captures page snapshots during workflow execution
 * for use as training data. Successful runs keep their snapshots (to contribute
 * to model training), while failed/cancelled runs have their snapshots deleted
 * to avoid polluting the training set.
 *
 * Snapshot filenames include `run-{runId}` for easy identification and cleanup.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';

interface TrackedInteraction {
  selector: string;
  action: string;
  stepId?: string;
  stepIndex?: number;
  timestamp: number;
}

export class ExecutionSnapshotCapture {
  private workflowId: string;
  private siteId: string;
  private runId: string;
  private snapshotsDir: string;
  private snapshotCounter: number = 0;
  private interactions: TrackedInteraction[] = [];
  private capturing: boolean = false;

  constructor(workflowId: string, siteId: string, runId: string) {
    this.workflowId = workflowId;
    this.siteId = siteId;
    this.runId = runId;

    // Store snapshots in the workflow's data directory (same location recorder uses)
    const workflowDataDir = join(homedir(), '.woodbury', 'data', 'workflows', workflowId);
    const sanitizedSite = siteId.replace(/[^a-zA-Z0-9.-]/g, '_');
    this.snapshotsDir = join(workflowDataDir, 'snapshots', sanitizedSite);
    mkdirSync(this.snapshotsDir, { recursive: true });
  }

  /**
   * Capture a page snapshot via the bridge's request_page_snapshot command.
   * This is fire-and-forget — errors are logged but don't stop the run.
   */
  async captureSnapshot(bridgeServer: any): Promise<void> {
    if (this.capturing) return; // Skip if a previous capture is still in progress
    this.capturing = true;

    try {
      const result = await bridgeServer.send('request_page_snapshot', {}, 10000);

      if (!result?.success || !result?.data) {
        return;
      }

      const { viewportImage, snapshot } = result.data;
      if (!viewportImage) return;

      const ts = Date.now();
      const idx = this.snapshotCounter++;
      const baseName = `snapshot_run-${this.runId}_${String(idx).padStart(4, '0')}_${ts}`;

      // 1. Save viewport PNG
      const base64Data = viewportImage.replace(/^data:image\/png;base64,/, '');
      const viewportPath = join(this.snapshotsDir, `${baseName}_viewport.png`);
      writeFileSync(viewportPath, Buffer.from(base64Data, 'base64'));

      // 2. Save element metadata JSON (same schema as recorder.ts handlePageSnapshot)
      const metadata = {
        site_id: this.siteId,
        page_url: snapshot?.url || '',
        page_title: snapshot?.title || '',
        viewport_width: snapshot?.viewportWidth || 0,
        viewport_height: snapshot?.viewportHeight || 0,
        timestamp: ts / 1000,
        viewport_image: `${baseName}_viewport.png`,
        desktop_image: null,
        elements: (snapshot?.elements || []).map((el: any) => ({
          selector: el.selector || '',
          tag: el.tag || '',
          text: (el.text || '').slice(0, 200),
          aria_label: el.ariaLabel || '',
          role: el.role || '',
          type: el.type || '',
          bounds: el.bounds,
        })),
        source: 'execution',
        run_id: this.runId,
      };

      const metaPath = join(this.snapshotsDir, `${baseName}.json`);
      writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
    } catch (err) {
      // Non-fatal — snapshot capture failures shouldn't stop the workflow
    } finally {
      this.capturing = false;
    }
  }

  /**
   * Track an element interaction during execution (click, type, etc.)
   */
  trackInteraction(selector: string, action: string, stepId?: string, stepIndex?: number): void {
    this.interactions.push({
      selector,
      action,
      stepId,
      stepIndex,
      timestamp: Date.now(),
    });
  }

  /**
   * Save interaction summary (same format as recorder's saveInteractedSelectors).
   * Called on successful run completion.
   */
  async saveInteractions(): Promise<void> {
    if (this.interactions.length === 0) return;

    await mkdir(this.snapshotsDir, { recursive: true });

    // Build interacted elements map: selector -> list of interactions
    const interactedElements: Record<string, any[]> = {};
    const selectorSet = new Set<string>();
    for (const interaction of this.interactions) {
      selectorSet.add(interaction.selector);
      if (!interactedElements[interaction.selector]) {
        interactedElements[interaction.selector] = [];
      }
      interactedElements[interaction.selector].push({
        action: interaction.action,
        stepIndex: interaction.stepIndex,
      });
    }

    const summary = {
      site_id: this.siteId,
      run_id: this.runId,
      source: 'execution',
      timestamp: Date.now() / 1000,
      total_interactions: this.interactions.length,
      interacted_selectors: [...selectorSet],
      interacted_elements: interactedElements,
    };

    const summaryPath = join(this.snapshotsDir, `interactions_run-${this.runId}_${Date.now()}.json`);
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  }

  /**
   * Delete all snapshots from this run. Called on failure/cancel.
   * Globs for any file containing `run-{runId}` in the snapshots directory.
   */
  async deleteRunSnapshots(): Promise<void> {
    try {
      const files = readdirSync(this.snapshotsDir);
      const runTag = `run-${this.runId}`;
      let deleted = 0;

      for (const file of files) {
        if (file.includes(runTag)) {
          try {
            unlinkSync(join(this.snapshotsDir, file));
            deleted++;
          } catch {
            // Best effort — file may already be gone
          }
        }
      }
    } catch {
      // Directory may not exist if no snapshots were captured
    }
  }

  /** Number of snapshots captured so far */
  get count(): number {
    return this.snapshotCounter;
  }
}
