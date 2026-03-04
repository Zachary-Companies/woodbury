/**
 * Marketplace Types
 *
 * Types for the workflow marketplace (Electron side).
 * These mirror/complement the web app types in apps/woodbury-web/src/types/workflow.ts.
 */

/** Metadata collected from the publish dialog before upload */
export interface PublishMetadata {
  name: string;
  description: string;
  category: string;
  tags: string[];
  changelog: string;
  /** SemVer string — "1.0.0" for new, auto-incremented for updates */
  version: string;
  /** Whether to include the trained ONNX model */
  includeModel: boolean;
  /** Local paths to screenshot files to upload */
  screenshotPaths: string[];
}

/** Info about an available update for an installed shared workflow */
export interface UpdateInfo {
  workflowId: string;
  name: string;
  installedVersion: string;
  latestVersion: string;
  changelog: string;
  hasModelUpdate: boolean;
}

/** Tracks a shared workflow installed locally, stored in marketplace.json */
export interface InstalledSharedWorkflow {
  /** Firestore document ID of the shared workflow */
  workflowId: string;
  /** Display name */
  name: string;
  /** Version installed */
  installedVersion: string;
  /** Author info */
  authorId: string;
  authorName: string;
  /** Target site domain */
  site: string;
  /** Whether the installed version includes a model */
  hasModel: boolean;
  /** Local file path to the installed workflow JSON */
  localWorkflowPath: string;
  /** Local file path to the installed model (null if no model) */
  localModelPath: string | null;
  /** When this was installed/updated */
  installedAt: string;
  updatedAt: string;
}

/** The marketplace manifest file structure (~/.woodbury/marketplace.json) */
export interface MarketplaceManifest {
  /** Schema version */
  version: '1.0';
  /** Map of workflowId → installed workflow info */
  workflows: Record<string, InstalledSharedWorkflow>;
}

/** Result of a publish operation */
export interface PublishResult {
  success: boolean;
  workflowId: string;
  version: string;
  url: string;
  error?: string;
}

/** Result of a download/install operation */
export interface DownloadResult {
  success: boolean;
  workflowPath: string;
  modelPath: string | null;
  error?: string;
}
