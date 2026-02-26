/**
 * Workflow Automation Types
 *
 * Defines the JSON schema for recorded/authored browser workflows.
 * Workflows capture browser interactions as structured steps with
 * CSS selectors, fallback strategies, fuzzy position validation,
 * variable substitution, and composition (conditionals, loops, sub-workflows).
 */

// ────────────────────────────────────────────────────────────────
//  Top-level document
// ────────────────────────────────────────────────────────────────

export interface WorkflowDocument {
  /** Schema version for forward compatibility */
  version: '1.0';
  /** Unique identifier for this workflow */
  id: string;
  /** Human-readable name */
  name: string;
  /** What this workflow does */
  description: string;
  /** Target site domain (e.g., "suno.com") */
  site: string;
  /** Variables this workflow accepts at runtime */
  variables: VariableDeclaration[];
  /** The steps to execute */
  steps: WorkflowStep[];
  /** Recording/authoring metadata */
  metadata: WorkflowMetadata;
}

export interface WorkflowMetadata {
  createdAt: string;
  updatedAt: string;
  recordedBy: 'manual' | 'recorder';
  environment?: {
    userAgent?: string;
    viewportWidth?: number;
    viewportHeight?: number;
  };
}

export interface VariableDeclaration {
  /** Variable name — referenced as {{name}} in step values */
  name: string;
  /** Human-readable description */
  description: string;
  /** Type hint for validation */
  type: 'string' | 'number' | 'boolean' | 'string[]';
  /** Whether this variable must be provided at runtime */
  required: boolean;
  /** Default value if not provided */
  default?: unknown;
  /** AI generation prompt — when set, this variable can be auto-generated using this prompt */
  generationPrompt?: string;
}

// ────────────────────────────────────────────────────────────────
//  Element targeting
// ────────────────────────────────────────────────────────────────

/** Multi-strategy element targeting with fallback chain */
export interface ElementTarget {
  /** Primary CSS selector */
  selector: string;
  /** Fallback selectors tried in order if primary fails */
  fallbackSelectors?: string[];
  /** ARIA label for accessibility-based lookup */
  ariaLabel?: string;
  /** Text content for text-based lookup */
  textContent?: string;
  /** Natural language description for find_interactive */
  description?: string;
  /** Expected bounds at record time (for fuzzy validation) */
  expectedBounds?: ElementBounds;
  /** Expected visible text at record time */
  expectedText?: string;
  /** Placeholder text (inputs, textareas) — useful for identifying form fields */
  placeholder?: string;
  /** Title attribute — tooltip text, useful for icon buttons */
  title?: string;
  /** Alt attribute — alternative text for images/icons */
  alt?: string;
  /** HTML name attribute — stable form field identifier */
  name?: string;
  /** data-testid or data-test-id — developer-set stable identifier */
  dataTestId?: string;
  /**
   * Contextual information captured at record time, used to disambiguate
   * when multiple elements match (e.g., 2 "Create" buttons on the same page).
   */
  context?: ElementContext;
}

/** Contextual clues about where an element lives on the page */
export interface ElementContext {
  /** Parent chain: tag+id+role up to 4 ancestors (e.g., ["div#sidebar", "nav[role=navigation]"]) */
  ancestors?: string[];
  /** Nearest landmark/section element */
  landmark?: {
    tag: string;
    id?: string;
    role?: string;
    ariaLabel?: string;
  };
  /** Nearest heading in the DOM (search backward through siblings, then up) */
  nearestHeading?: {
    level: string;   // e.g., "h2"
    text: string;    // e.g., "Song Settings"
  };
  /** Sibling elements with their text (what's next to this element) */
  siblings?: Array<{
    tag: string;
    text: string;
    position: 'before' | 'after';
  }>;
  /** Associated form label text */
  label?: string;
  /**
   * Disambiguation index: which occurrence of this text among same-tag elements.
   * e.g., nthWithSameText=2, totalWithSameText=3 means "2nd of 3 elements with this text"
   */
  nthWithSameText?: number;
  /** Total count of same-tag elements with identical text */
  totalWithSameText?: number;
}

export interface ElementBounds {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Tolerance in pixels for position drift */
  tolerance: number;
  /** Position as percentage of viewport (0-100). Resolution-independent. */
  pctX?: number;    // center X as % of viewport width
  pctY?: number;    // center Y as % of viewport height
  pctW?: number;    // width as % of viewport width
  pctH?: number;    // height as % of viewport height
  /** Viewport dimensions at record time */
  viewportW?: number;
  viewportH?: number;
}

/** Result from resolving an element target */
export interface ResolvedElement {
  /** The selector that matched */
  matchedBy: 'selector' | 'fallback' | 'ariaLabel' | 'textContent' | 'description' | 'placeholder' | 'percentage';
  /** The actual selector or description used */
  matchedValue: string;
  /** Element position from the bridge */
  position?: { left: number; top: number; width: number; height: number };
  /** Whether bounds validation passed (null if no expectedBounds) */
  boundsValid?: boolean | null;
  /** Actual text content of the element */
  textContent?: string;
}

// ────────────────────────────────────────────────────────────────
//  Conditions (preconditions, postconditions, assertions)
// ────────────────────────────────────────────────────────────────

export type Precondition =
  | { type: 'url_matches'; pattern: string }
  | { type: 'url_contains'; substring: string }
  | { type: 'element_exists'; target: ElementTarget }
  | { type: 'element_visible'; target: ElementTarget }
  | { type: 'element_text_matches'; target: ElementTarget; pattern: string };

export type Postcondition =
  | { type: 'url_changed' }
  | { type: 'url_matches'; pattern: string }
  | { type: 'element_appeared'; target: ElementTarget }
  | { type: 'element_disappeared'; target: ElementTarget }
  | { type: 'element_text_changed'; target: ElementTarget };

export type WaitCondition =
  | { type: 'element_visible'; target: ElementTarget }
  | { type: 'element_hidden'; target: ElementTarget }
  | { type: 'url_matches'; pattern: string }
  | { type: 'url_contains'; substring: string }
  | { type: 'text_appears'; text: string }
  | { type: 'text_disappears'; text: string }
  | { type: 'delay'; ms: number }
  | { type: 'network_idle'; timeoutMs?: number };

export type AssertCondition =
  | { type: 'element_exists'; target: ElementTarget }
  | { type: 'element_visible'; target: ElementTarget }
  | { type: 'element_text_matches'; target: ElementTarget; pattern: string }
  | { type: 'url_matches'; pattern: string }
  | { type: 'url_contains'; substring: string }
  | { type: 'page_title_contains'; text: string }
  | { type: 'variable_equals'; variable: string; value: unknown };

// ────────────────────────────────────────────────────────────────
//  Step types
// ────────────────────────────────────────────────────────────────

/** Base fields shared by all steps */
export interface StepBase {
  /** Unique step ID within this workflow */
  id: string;
  /** Human-readable label */
  label: string;
  /** Step type discriminator */
  type: string;
  /** Preconditions that must pass before executing */
  preconditions?: Precondition[];
  /** Postconditions to verify after executing */
  postconditions?: Postcondition[];
  /** Retry configuration */
  retry?: RetryConfig;
  /** Timeout for this step in ms */
  timeoutMs?: number;
  /** Optional screenshot reference (file path or base64 thumbnail) */
  screenshotRef?: string;
  /** Optional notes added during recording */
  notes?: string;
}

export interface RetryConfig {
  maxAttempts: number;
  delayMs: number;
  backoffMultiplier?: number;
}

/** Navigate to a URL */
export interface NavigateStep extends StepBase {
  type: 'navigate';
  /** URL to navigate to (supports {{variables}}) */
  url: string;
  /** Wait for this selector to appear after navigation */
  waitForSelector?: string;
  /** Wait this many ms after navigation */
  waitMs?: number;
}

/** Click an element */
/** Configuration for post-click verification: re-click if DOM doesn't change at click coords */
export interface VerifyClickConfig {
  /** Whether verification is enabled */
  enabled: boolean;
  /** Max re-click attempts before giving up (default: 3) */
  maxAttempts?: number;
  /** Wait before checking DOM after click, in ms (default: 400) */
  verifyDelayMs?: number;
  /** Wait before re-clicking on failure, in ms (default: 600) */
  retryDelayMs?: number;
}

export interface ClickStep extends StepBase {
  type: 'click';
  target: ElementTarget;
  /** Click variant */
  clickType?: 'single' | 'double' | 'right' | 'hover';
  /** Delay after click in ms */
  delayAfterMs?: number;
  /** Post-click verification: re-click if DOM doesn't change at click coords */
  verifyClick?: VerifyClickConfig;
}

/** Type text into an element */
export interface TypeStep extends StepBase {
  type: 'type';
  target: ElementTarget;
  /** Text to type (supports {{variables}}) */
  value: string;
  /** Whether to clear the field first */
  clearFirst?: boolean;
  /** Delay after typing in ms */
  delayAfterMs?: number;
}

/** Wait for a condition */
export interface WaitStep extends StepBase {
  type: 'wait';
  condition: WaitCondition;
}

/** Assert a condition (fails the workflow if false) */
export interface AssertStep extends StepBase {
  type: 'assert';
  condition: AssertCondition;
  /** Error message if assertion fails */
  errorMessage?: string;
}

/** Trigger or wait for a browser download */
export interface DownloadStep extends StepBase {
  type: 'download';
  /** Element to click to trigger the download */
  trigger: ElementTarget;
  /** Expected filename pattern (regex) */
  expectedFilenamePattern?: string;
  /** How long to wait for download to complete in ms */
  waitMs?: number;
}

/** Capture recent browser downloads and store their file paths in a variable */
export interface CaptureDownloadStep extends StepBase {
  type: 'capture_download';
  /** Regex pattern to filter downloads by filename (optional) */
  filenamePattern?: string;
  /** Max files to capture (default: 1) */
  maxFiles?: number;
  /** Only consider downloads started within this many ms (default: 30000) */
  lookbackMs?: number;
  /** Timeout in ms to wait for in-progress downloads to complete (default: 60000) */
  waitTimeoutMs?: number;
  /** Variable name to store the captured file paths array (default: 'downloadedFiles') */
  outputVariable?: string;
}

/** Move a file from one location to another */
export interface MoveFileStep extends StepBase {
  type: 'move_file';
  /** Source path (supports {{variables}} and globs) */
  source: string;
  /** Destination path (supports {{variables}}) */
  destination: string;
}

/** Scroll the page or an element */
export interface ScrollStep extends StepBase {
  type: 'scroll';
  /** Target element to scroll into view (omit for page scroll) */
  target?: ElementTarget;
  /** Scroll direction */
  direction: 'up' | 'down' | 'left' | 'right';
  /** Scroll amount (ticks) */
  amount?: number;
}

/** Press keyboard keys */
export interface KeyboardStep extends StepBase {
  type: 'keyboard';
  /** Key or key combination (e.g., "Enter", "Escape", "a") */
  key: string;
  /** Modifier keys */
  modifiers?: ('ctrl' | 'shift' | 'alt' | 'cmd')[];
}

/** Call another workflow */
export interface SubWorkflowStep extends StepBase {
  type: 'sub_workflow';
  /** Path to the workflow file (relative to extension dir or absolute) */
  workflowPath: string;
  /** Variable bindings passed to the sub-workflow */
  variables?: Record<string, unknown>;
}

/** Conditional branching */
export interface ConditionalStep extends StepBase {
  type: 'conditional';
  condition: AssertCondition;
  /** Steps to execute if condition is true */
  thenSteps: WorkflowStep[];
  /** Steps to execute if condition is false */
  elseSteps?: WorkflowStep[];
}

/** Loop over items in a variable */
export interface LoopStep extends StepBase {
  type: 'loop';
  /** Variable name containing the array to iterate */
  overVariable: string;
  /** Variable name for the current item */
  itemVariable: string;
  /** Variable name for the current index */
  indexVariable?: string;
  /** Steps to execute for each item */
  steps: WorkflowStep[];
}

/** Try/catch error handling */
export interface TryCatchStep extends StepBase {
  type: 'try_catch';
  /** Steps to try */
  trySteps: WorkflowStep[];
  /** Steps to execute on failure */
  catchSteps: WorkflowStep[];
  /** Variable name to store the error message */
  errorVariable?: string;
}

/** Set a runtime variable from a value source */
export interface SetVariableStep extends StepBase {
  type: 'set_variable';
  /** Variable name to set */
  variable: string;
  /** Value source */
  source: VariableSource;
}

export type VariableSource =
  | { type: 'literal'; value: unknown }
  | { type: 'element_text'; target: ElementTarget }
  | { type: 'element_attribute'; target: ElementTarget; attribute: string }
  | { type: 'url' }
  | { type: 'url_param'; param: string }
  | { type: 'regex'; input: string; pattern: string; group?: number };

/** Union of all step types */
export type WorkflowStep =
  | NavigateStep
  | ClickStep
  | TypeStep
  | WaitStep
  | AssertStep
  | DownloadStep
  | CaptureDownloadStep
  | MoveFileStep
  | ScrollStep
  | KeyboardStep
  | SubWorkflowStep
  | ConditionalStep
  | LoopStep
  | TryCatchStep
  | SetVariableStep;

// ────────────────────────────────────────────────────────────────
//  Execution types
// ────────────────────────────────────────────────────────────────

export interface ExecutionOptions {
  /** Runtime variable values */
  variables: Record<string, unknown>;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Callback for progress reporting */
  onProgress?: (event: ExecutionProgressEvent) => void;
  /** Whether to stop on first step failure (default: true) */
  stopOnFailure?: boolean;
  /** Timeout for the entire workflow in ms */
  timeoutMs?: number;
}

export interface ExecutionResult {
  success: boolean;
  stepsExecuted: number;
  stepsTotal: number;
  /** Final variable values (including set_variable results) */
  variables: Record<string, unknown>;
  /** Per-step results */
  stepResults: StepResult[];
  /** Overall error if workflow failed */
  error?: string;
  durationMs: number;
}

export interface StepResult {
  stepId: string;
  stepLabel: string;
  status: 'success' | 'failed' | 'skipped';
  durationMs: number;
  error?: string;
  retryCount?: number;
}

export type ExecutionProgressEvent =
  | { type: 'step_start'; stepId: string; stepLabel: string; index: number; total: number }
  | { type: 'step_complete'; stepId: string; stepLabel: string; result: StepResult }
  | { type: 'step_retry'; stepId: string; stepLabel: string; attempt: number; maxAttempts: number; error: string }
  | { type: 'precondition_check'; stepId: string; condition: Precondition; passed: boolean }
  | { type: 'postcondition_check'; stepId: string; condition: Postcondition; passed: boolean }
  | { type: 'workflow_complete'; result: ExecutionResult };

// ────────────────────────────────────────────────────────────────
//  Bridge server interface (subset used by workflow engine)
// ────────────────────────────────────────────────────────────────

/** Minimal bridge server interface for the workflow executor */
export interface BridgeInterface {
  send(action: string, params?: Record<string, unknown>): Promise<unknown>;
  readonly isConnected: boolean;
}

// ────────────────────────────────────────────────────────────────
//  Recording event types (from Chrome extension)
// ────────────────────────────────────────────────────────────────

export interface RecordingEvent {
  type: 'recording_event';
  event: 'click' | 'input' | 'change' | 'keydown' | 'navigate';
  element: {
    selector: string;
    fallbackSelectors: string[];
    ariaLabel?: string;
    textContent?: string;
    description?: string;
    bounds: {
      left: number; top: number; width: number; height: number;
      pctX?: number; pctY?: number; pctW?: number; pctH?: number;
      viewportW?: number; viewportH?: number;
    };
    tag: string;
    role?: string;
    inputType?: string;
    value?: string;
    /** Placeholder text from inputs/textareas */
    placeholder?: string;
    /** Title attribute (tooltip) */
    title?: string;
    /** Alt attribute (images/icons) */
    alt?: string;
    /** HTML name attribute */
    name?: string;
    /** data-testid or data-test-id */
    dataTestId?: string;
    /** Contextual information for disambiguating similar elements */
    context?: {
      ancestors?: string[];
      landmark?: { tag: string; id?: string; role?: string; ariaLabel?: string };
      nearestHeading?: { level: string; text: string };
      siblings?: Array<{ tag: string; text: string; position: 'before' | 'after' }>;
      label?: string;
      nthWithSameText?: number;
      totalWithSameText?: number;
    };
  };
  page: {
    url: string;
    title: string;
  };
  keyboard?: {
    key: string;
    modifiers: string[];
  };
  timestamp: number;
}
