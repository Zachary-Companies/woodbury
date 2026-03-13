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
  /** Conditions that must be true after all steps succeed */
  expectations?: Expectation[];
  /** Retry the entire workflow if steps or expectations fail */
  retry?: RetryConfig;
}

export interface WorkflowMetadata {
  createdAt: string;
  updatedAt: string;
  recordedBy: 'manual' | 'recorder';
  /** Recording mode used: 'standard' (CSS selectors) or 'accessibility' (roles/labels/SVG fingerprints) */
  recordingMode?: 'standard' | 'accessibility';
  environment?: {
    userAgent?: string;
    viewportWidth?: number;
    viewportHeight?: number;
  };
  /** Path to the ONNX model trained for this workflow's visual verification */
  modelPath?: string;
  /** Currently active model version (SemVer string, e.g. "1.2.0") */
  modelVersion?: string;
  /** Training status for this workflow's model */
  trainingStatus?: 'pending' | 'training' | 'complete' | 'failed';
  /** Training run metadata (most recent run) */
  trainingRun?: {
    startedAt: string;
    completedAt?: string;
    bestAuc?: number;
    epochs?: number;
    error?: string;
    /** Version produced by this training run */
    version?: string;
    /** Whether this run's model became the active version */
    promoted?: boolean;
    /** Remote worker name (if dispatched remotely) */
    worker?: string;
  };
}

/** A single model version entry in the version registry */
export interface ModelVersionEntry {
  version: string;
  bestAuc: number;
  epochs: number;
  backbone: string;
  embedDim: number;
  trainedAt: string;
  durationMs: number;
  worker?: string;
  status: 'complete' | 'failed';
  /** Whether this version was promoted to active when trained */
  promotedOverActive: boolean;
  /** Absolute path to the encoder.onnx for this version */
  modelPath: string;
}

/** Version registry stored in model/versions.json */
export interface ModelVersionRegistry {
  activeVersion: string;
  versions: ModelVersionEntry[];
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
//  Accessibility-first recording types
// ────────────────────────────────────────────────────────────────

/** Descriptor for a shadow DOM host in the path from document root to target element */
export interface ShadowHostDescriptor {
  /** Tag name of the shadow host element */
  tag: string;
  /** ID attribute, if present */
  id?: string;
  /** aria-label attribute, if present */
  ariaLabel?: string;
  /** ARIA role, if present */
  role?: string;
  /** CSS selector fallback for this host */
  selector?: string;
}

/** Visual fingerprint of an SVG element for matching across layouts */
export interface SvgFingerprint {
  /** Perceptual hash (32×32 average hash → hex string) */
  hash: string;
  /** Rendered dimensions of the SVG */
  dimensions: { width: number; height: number };
  /** SVG's aria-label or <title> text, if present */
  label?: string;
  /** Whether the SVG is inline (in the DOM) vs referenced via <img> or <use> */
  inline: boolean;
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
  /** ARIA/implicit role of the element (e.g. 'button', 'link', 'textbox') — accessibility mode */
  role?: string;
  /** Shadow DOM path from document root to the target element — accessibility mode */
  shadowPath?: ShadowHostDescriptor[];
  /** Visual fingerprint of an SVG element for layout-independent matching — accessibility mode */
  svgFingerprint?: SvgFingerprint;
  /**
   * Compact accessibility query string for element lookup — accessibility mode.
   * Format: `role:button[name:Submit]`
   */
  accessibilityQuery?: string;
  /** Path to reference image captured during recording (for visual verification) */
  referenceImage?: string;
  /** Bounding region to constrain visual search (viewport percentages) */
  searchBounds?: {
    pctX: number;  // left edge as % of viewport width
    pctY: number;  // top edge as % of viewport height
    pctW: number;  // width as % of viewport width
    pctH: number;  // height as % of viewport height
  };
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
  matchedBy: 'selector' | 'fallback' | 'ariaLabel' | 'textContent' | 'description' | 'placeholder' | 'percentage' | 'visual' | 'accessibilityQuery' | 'svgFingerprint' | 'labelAssociation' | 'contextual';
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
  | { type: 'variable_equals'; variable: string; value: unknown }
  | { type: 'expression'; expression: string };

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
  /** Extract URL dynamically from a DOM element's attribute at runtime */
  selectorSource?: {
    /** CSS selector to find the element */
    selector: string;
    /** Attribute name to extract (e.g. 'href', 'src', 'data-url') */
    attribute: string;
  };
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

/** Click the first element matching a CSS selector (bypasses element resolver / visual verification) */
export interface ClickSelectorStep extends StepBase {
  type: 'click_selector';
  /** CSS selector to match */
  selector: string;
  /** Optional CSS selector for a shadow DOM host — queries selector inside its .shadowRoot */
  shadowDomSelector?: string;
  /** Optional text content to match (checks text nodes, placeholder, title, alt) */
  textContent?: string;
  /** If true, text must match exactly; otherwise partial match (default: false) */
  exactMatch?: boolean;
  /** Click variant */
  clickType?: 'single' | 'double' | 'right';
  /** Delay after click in ms */
  delayAfterMs?: number;
}

/** Type text into an element */
export interface TypeStep extends StepBase {
  type: 'type';
  target: ElementTarget;
  /** Text to type (supports {{variables}}) */
  value: string;
  /** Whether to clear the field first */
  clearFirst?: boolean;
  /** Skip clicking the element before typing (assumes field is already focused) */
  skipClick?: boolean;
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

/** Navigate an OS file selection dialog to select a file */
export interface FileDialogStep extends StepBase {
  type: 'file_dialog';
  /** Absolute file path to select (supports {{variables}}) */
  filePath: string;
  /** Optional element to click first to open the file dialog */
  trigger?: ElementTarget;
  /** Variable name to store the resolved file path (default: 'selectedFile') */
  outputVariable?: string;
  /** Delay in ms before interacting with the dialog (default: 2000) */
  delayBeforeMs?: number;
  /** Delay in ms after dialog completes (default: 1000) */
  delayAfterMs?: number;
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

/** Descriptor for verifying which element has focus after keyboard navigation */
export interface ExpectedFocusDescriptor {
  /** Inner text of the expected focused element */
  text?: string;
  /** aria-label attribute */
  ariaLabel?: string;
  /** ARIA role (e.g., 'button', 'menuitem', 'tab') */
  role?: string;
  /** HTML tag name (e.g., 'input', 'button') */
  tag?: string;
  /** CSS selector for verification */
  selector?: string;
  /** Input placeholder text */
  placeholder?: string;
}

/** A single action within a keyboard_nav sequence */
export interface KeyboardNavAction {
  /** Key to press */
  key: 'tab' | 'shift_tab' | 'arrow_up' | 'arrow_down'
     | 'arrow_left' | 'arrow_right' | 'enter' | 'space' | 'escape';
  /** Times to press (default 1). Ignored when matchText is set. */
  count?: number;
  /** Search mode: keep pressing until focused element's text matches.
   *  Supports {{variables}}. */
  matchText?: string;
}

/** Keyboard-based navigation with action sequencing, focus verification, and self-healing */
export interface KeyboardNavStep extends StepBase {
  type: 'keyboard_nav';
  /** Ordered list of key actions to perform */
  actions: KeyboardNavAction[];
  /** Optional: verify focused element after entire sequence */
  expectedFocus?: ExpectedFocusDescriptor;
  /** Self-heal the last action's count if expectedFocus doesn't match (default true) */
  autoFix?: boolean;
  /** Max presses for any search-mode action or autoFix (default 20) */
  maxSearchDistance?: number;
  /** Delay after entire sequence in ms */
  delayAfterMs?: number;
}

/** Call another workflow */
export interface SubWorkflowStep extends StepBase {
  type: 'sub_workflow';
  /** Path to the workflow file (relative to extension dir or absolute) */
  workflowPath: string;
  /** Variable bindings passed to the sub-workflow */
  variables?: Record<string, unknown>;
}

/** Function-based condition (only available in .workflow.js code workflows) */
export type ConditionFunction = (variables: Record<string, unknown>) => boolean | Promise<boolean>;

/** Conditional branching */
export interface ConditionalStep extends StepBase {
  type: 'conditional';
  condition: AssertCondition | ConditionFunction;
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

// ────────────────────────────────────────────────────────────────
//  Desktop Automation Steps (native app coordinate-based)
// ────────────────────────────────────────────────────────────────

/** Click at absolute screen coordinates (desktop / native app automation) */
/** Launch an application by name at OS level */
export interface DesktopLaunchAppStep extends StepBase {
  type: 'desktop_launch_app';
  /** Application name (e.g., "Blender", "Spotify", "Notepad") */
  appName: string;
  /** Delay after launch in ms (default: 2000) to let app initialize */
  delayAfterMs?: number;
}

export interface DesktopClickStep extends StepBase {
  type: 'desktop_click';
  /** Absolute screen X coordinate (top-left origin) */
  x: number;
  /** Absolute screen Y coordinate (top-left origin) */
  y: number;
  /** Click variant */
  action: 'click' | 'double_click' | 'right_click';
  /** Frontmost application name at time of recording (metadata) */
  app?: string;
  /** Human-readable description of what was clicked */
  description?: string;
  /** Path to reference screenshot captured at time of recording */
  screenshotRef?: string;
  /** Delay after click in ms (default: 500) */
  delayAfterMs?: number;
}

/** Type text at OS level (not into a browser element) */
export interface DesktopTypeStep extends StepBase {
  type: 'desktop_type';
  /** Text to type (supports {{variables}}) */
  value: string;
  /** Delay after typing in ms (default: 300) */
  delayAfterMs?: number;
}

/** Press a keyboard key/combo at OS level */
export interface DesktopKeyboardStep extends StepBase {
  type: 'desktop_keyboard';
  /** Key name (e.g., "Return", "Escape", "a") */
  key: string;
  /** Modifier keys */
  modifiers?: ('ctrl' | 'shift' | 'alt' | 'cmd')[];
  /** Delay after keypress in ms (default: 300) */
  delayAfterMs?: number;
}

/** Inject or clear CSS styles on elements matching a selector */
export interface InjectStyleStep extends StepBase {
  type: 'inject_style';
  /** CSS selector to target */
  selector: string;
  /** CSS property/value pairs to apply, e.g. { position: 'absolute', display: 'none' } */
  styles?: Record<string, string>;
  /** 'apply' (default) to inject styles, 'clear' to revert previously injected styles */
  action?: 'apply' | 'clear';
}

/** Union of all step types */
export type WorkflowStep =
  | NavigateStep
  | ClickStep
  | ClickSelectorStep
  | TypeStep
  | WaitStep
  | AssertStep
  | DownloadStep
  | CaptureDownloadStep
  | MoveFileStep
  | FileDialogStep
  | ScrollStep
  | KeyboardStep
  | KeyboardNavStep
  | SubWorkflowStep
  | ConditionalStep
  | LoopStep
  | TryCatchStep
  | SetVariableStep
  | DesktopLaunchAppStep
  | DesktopClickStep
  | DesktopTypeStep
  | DesktopKeyboardStep
  | InjectStyleStep;

// ────────────────────────────────────────────────────────────────
//  Expectations (workflow-level outcome checks)
// ────────────────────────────────────────────────────────────────

/** Check that a directory contains at least N files matching a pattern */
export interface FileCountExpectation {
  type: 'file_count';
  /** Directory path (supports {{variables}}) */
  directory: string;
  /** Glob pattern for filename matching (e.g., "*.mp3"). Default: "*" */
  pattern?: string;
  /** Minimum number of files required */
  minCount: number;
  /** Optional maximum (undefined = no upper limit) */
  maxCount?: number;
  /** Human-readable description */
  description?: string;
}

/** Check that a specific file path exists */
export interface FileExistsExpectation {
  type: 'file_exists';
  /** File path (supports {{variables}}) */
  path: string;
  /** Optionally check minimum file size in bytes */
  minSizeBytes?: number;
  description?: string;
}

/** Check that a runtime variable was set to a non-empty value */
export interface VariableNotEmptyExpectation {
  type: 'variable_not_empty';
  /** Variable name to check */
  variable: string;
  description?: string;
}

/** Check that a runtime variable equals a specific value */
export interface VariableEqualsExpectation {
  type: 'variable_equals';
  variable: string;
  value: unknown;
  description?: string;
}

export type Expectation =
  | FileCountExpectation
  | FileExistsExpectation
  | VariableNotEmptyExpectation
  | VariableEqualsExpectation;

export interface ExpectationResult {
  expectation: Expectation;
  passed: boolean;
  /** Human-readable description of what was checked and the outcome */
  detail: string;
}

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
  /** Visual verifier instance for ML-based element verification (optional) */
  visualVerifier?: import('./visual-verifier.js').VisualVerifier | null;
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
  /** Results of expectation checks (only present when expectations are defined) */
  expectationResults?: ExpectationResult[];
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
  | { type: 'expectation_check'; expectation: Expectation; passed: boolean; detail: string }
  | { type: 'workflow_retry'; attempt: number; maxAttempts: number; failedExpectations: string[] }
  | { type: 'workflow_complete'; result: ExecutionResult };

// ────────────────────────────────────────────────────────────────
//  Composition (visual workflow graph)
// ────────────────────────────────────────────────────────────────

/** A composition connects multiple workflows into a directed graph */
export interface CompositionDocument {
  version: '1.0';
  id: string;
  name: string;
  description?: string;
  folder?: string;
  nodes: CompositionNode[];
  edges: CompositionEdge[];
  metadata?: {
    createdAt: string;
    updatedAt: string;
    viewport?: { panX: number; panY: number; zoom: number };
  };
}

/** What to do when a pipeline node fails or its expectations are not met */
export interface NodeFailurePolicy {
  /** 'stop' = halt pipeline (default), 'skip' = skip and continue, 'retry' = retry the node */
  action: 'stop' | 'skip' | 'retry';
  /** Retry configuration (only used when action is 'retry') */
  retry?: RetryConfig;
}

/** A node in the composition graph — references a workflow */
export interface CompositionNode {
  id: string;
  workflowId: string;
  position: { x: number; y: number };
  label?: string;
  inputOverrides?: Record<string, unknown>;
  /** Override or add expectations for this node (merged with workflow defaults) */
  expectations?: Expectation[];
  /** What to do when this node fails or expectations fail */
  onFailure?: NodeFailurePolicy;
  /** Approval gate configuration (only when workflowId is '__approval_gate__') */
  approvalGate?: ApprovalGateConfig;
  /** Script node configuration (only when workflowId is '__script__') */
  script?: ScriptNodeConfig;
  /** Output node configuration (only when workflowId is '__output__') */
  outputNode?: OutputNodeConfig;
  /** Image viewer configuration (only when workflowId is '__image_viewer__') */
  imageViewer?: ImageViewerNodeConfig;
  /** Media player configuration (only when workflowId is '__media__') */
  mediaPlayer?: MediaNodeConfig;
  /** Branch node configuration (only when workflowId is '__branch__') */
  branchNode?: BranchNodeConfig;
  /** Delay node configuration (only when workflowId is '__delay__') */
  delayNode?: DelayNodeConfig;
  /** Gate node configuration (only when workflowId is '__gate__') */
  gateNode?: GateNodeConfig;
  /** ForEach loop configuration (only when workflowId is '__for_each__') */
  forEachNode?: ForEachLoopConfig;
  /** Switch node configuration (only when workflowId is '__switch__') */
  switchNode?: SwitchNodeConfig;
  /** Port name aliases for external display (e.g., in sub-pipeline usage) */
  portAliases?: Record<string, string>;
  /** Asset node configuration (only when workflowId is '__asset__') */
  asset?: AssetNodeConfig;
  /** Text node configuration (only when workflowId is '__text__') */
  textNode?: TextNodeConfig;
  /** Variable node configuration (only when workflowId is '__variable__') */
  variableNode?: VariableNodeConfig;
  /** Get Variable node configuration (only when workflowId is '__get_variable__') */
  getVariableNode?: GetVariableNodeConfig;
  /** File operation node configuration (only when workflowId is '__file_op__') */
  fileOp?: FileOpNodeConfig;
  /** JSON keys/extract node configuration (only when workflowId is '__json_keys__') */
  jsonKeysNode?: JsonKeysNodeConfig;
  /** Tool node configuration (only when workflowId is '__tool__') */
  toolNode?: ToolNodeConfig;
  /** File write node configuration (only when workflowId is '__file_write__') */
  fileWriteNode?: FileWriteNodeConfig;
  /** File read node configuration (only when workflowId is '__file_read__') */
  fileReadNode?: FileReadNodeConfig;
  /** Junction/hub node configuration (only when workflowId is '__junction__') */
  junctionNode?: JunctionNodeConfig;
  /** Whether to cache this node's output and skip re-execution when inputs are unchanged */
  idempotent?: boolean;
  /** Sub-pipeline reference (only when workflowId starts with 'comp:') */
  compositionRef?: { compositionId: string };
}

/** Configuration for an approval gate node in a composition */
export interface ApprovalGateConfig {
  /** Message to display to the reviewer */
  message: string;
  /** Variable names from upstream nodes to preview in the approval dialog */
  previewVariables?: string[];
  /** Timeout in ms — auto-reject if no response within this duration (0 = no timeout) */
  timeoutMs?: number;
  /** What to do if rejected: 'stop' halts the pipeline (default), 'skip' continues */
  onReject?: 'stop' | 'skip';
}

/** Declaration of a script node input or output port */
export interface PortDeclaration {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'string[]';
  description?: string;
  required?: boolean;
  default?: unknown;
}

/** Configuration for a script node in a composition */
export interface ScriptNodeConfig {
  /** Natural language description of what this node does */
  description: string;
  /** Generated JavaScript code (async function body) */
  code: string;
  /** Declared input ports (parsed from @input annotations) */
  inputs: PortDeclaration[];
  /** Declared output ports (parsed from @output annotations) */
  outputs: PortDeclaration[];
  /** Agent conversation history for iterative refinement */
  chatHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Persisted generation transcript for script creation/refinement/repair runs */
  generationTranscript?: Array<{
    stage: 'request' | 'generation' | 'repair' | 'fallback' | 'validation' | 'tests' | 'verification';
    title: string;
    content: string;
  }>;
}

/** Configuration for an output node in a composition — collects pipeline results */
export interface OutputNodeConfig {
  /** Dynamic input ports — values flowing in become pipeline outputs */
  ports: PortDeclaration[];
}

/** Configuration for an image viewer node in a composition */
export interface ImageViewerNodeConfig {
  /** Path to image file — can use {{variables}} */
  filePath: string;
  /** Display width in pixels */
  width: number;
  /** Display height in pixels */
  height: number;
}

/** Configuration for a media player node — plays video, audio, images, PDF, text */
export interface MediaNodeConfig {
  /** How to resolve the media source */
  sourceMode: 'file_path' | 'url' | 'asset_id';
  /** File path (sourceMode='file_path') — supports {{variable}} syntax */
  filePath: string;
  /** URL (sourceMode='url') — supports {{variable}} syntax */
  url: string;
  /** Asset ID (sourceMode='asset_id') */
  assetId: string;
  /** Force a specific media type instead of auto-detection from extension */
  mediaType: 'auto' | 'image' | 'video' | 'audio' | 'pdf' | 'text';
  /** Display width in pixels */
  width: number;
  /** Display height in pixels */
  height: number;
  /** Optional display label */
  title: string;
  /** Auto-play video/audio when pipeline runs */
  autoPlay: boolean;
  /** Default volume 0-1 */
  defaultVolume: number;
  /** Loop playback for video/audio */
  loop: boolean;
  /** Playback speed (1.0 = normal) */
  playbackRate: number;
  /** Image fit mode */
  imageFit: 'contain' | 'cover' | 'actual';
}

/** Configuration for a branch node — conditional if/else routing */
export interface BranchNodeConfig {
  /** Condition expression — can use {{variable}} syntax, evaluated as truthy/falsy */
  condition: string;
}

/** Configuration for a delay node — timed pause */
export interface DelayNodeConfig {
  /** Delay in milliseconds */
  delayMs: number;
}

/** Configuration for a gate node — conditional pass-through */
export interface GateNodeConfig {
  /** Whether the gate is open by default */
  defaultOpen: boolean;
  /** What to do when the gate is closed: 'skip' downstream, 'stop' pipeline, or 'fail' pipeline (mark as error) */
  onClosed: 'skip' | 'stop' | 'fail';
}

/** Configuration for a for-each loop node — iterate over array */
export interface ForEachLoopConfig {
  /** Variable name for the current item, exposed to downstream nodes */
  itemVariable: string;
  /** Maximum number of iterations (safety cap) */
  maxIterations: number;
}

/** Configuration for a switch node — multi-way routing */
export interface SwitchNodeConfig {
  /** Named cases to match against the input value */
  cases: Array<{ value: string; port: string }>;
  /** Output port name for when no case matches */
  defaultPort: string;
}

/** Configuration for an asset node in a composition */
export interface AssetNodeConfig {
  /** Operation mode */
  mode: 'pick' | 'save' | 'list' | 'remove' | 'generate_path';
  /** Collection slug to operate on */
  collectionSlug?: string;
  /** Selected asset ID (pick mode) */
  assetId?: string;
  /** Category filter (pick/list modes) */
  category?: string;
  /** Comma-separated tags (save mode) */
  tags?: string;
  /** Default name for saved assets (save mode) */
  defaultName?: string;
  /** If true, save mode references files in place rather than copying them */
  referenceOnly?: boolean;
  /** Base output directory (generate_path mode) */
  outputDirectory?: string;
  /** Name pattern with tokens like {name}, {datetime}, {uuid} (generate_path mode) */
  namePattern?: string;
  /** File extension including dot, e.g. ".json" (generate_path mode) */
  fileExtension?: string;
}

/** Configuration for a text input node in a composition */
export interface TextNodeConfig {
  /** The text content to output */
  value: string;
}

/** Configuration for a variable node in a composition */
export interface VariableNodeConfig {
  /** Value type */
  type: 'string' | 'number' | 'array' | 'boolean';
  /** Initial value as JSON string (parsed at execution time) */
  initialValue: string;
  /** Whether this variable should appear as a top-level pipeline form input */
  exposeAsInput?: boolean;
  /** Stable external input key used in pipeline forms and run payloads */
  inputName?: string;
  /** Optional helper text for the generated pipeline form */
  description?: string;
  /** Whether the generated pipeline form should require this value */
  required?: boolean;
  /** Optional AI generation prompt for the generated pipeline form */
  generationPrompt?: string;
}

/** Configuration for a Get Variable node — reads a Variable node's value by reference */
export interface GetVariableNodeConfig {
  /** ID of the Variable node to read from */
  targetNodeId: string;
}

/** Configuration for a file operation node in a composition */
export interface FileOpNodeConfig {
  /** File operation to perform */
  operation: 'copy' | 'move' | 'delete' | 'mkdir' | 'list';
}

/** Configuration for a JSON keys/extract node in a composition */
export interface JsonKeysNodeConfig {
  /** Optional JSONPath or dot-notation path to focus extraction (e.g., "categories.0.topics") */
  defaultPath?: string;
}

/** Configuration for a tool node in a composition — calls extension tools directly */
export interface ToolNodeConfig {
  /** Selected tool name (e.g., 'nanobanana', 'web_fetch', 'shell_execute') */
  selectedTool: string;
  /** Default values for tool parameters (used when input port is not connected) */
  paramDefaults?: Record<string, any>;
  /** Cached parameter schema so ports render without live tools cache */
  paramSchema?: { properties?: Record<string, any>; required?: string[] };
}

/** Configuration for a file write node — writes text or JSON content to a file */
export interface FileWriteNodeConfig {
  /** Write mode: 'overwrite' replaces file, 'append' adds to end */
  mode: 'overwrite' | 'append';
  /** Content format: 'auto' detects JSON objects, 'json' always pretty-prints, 'text' writes raw */
  format: 'auto' | 'json' | 'text';
  /** Whether to pretty-print JSON output (default true) */
  prettyPrint?: boolean;
}

/** Configuration for a file read node — reads a text file and returns JSON object or string */
export interface FileReadNodeConfig {
  /** Parse mode: 'auto' tries JSON first then falls back to string, 'json' always parses as JSON, 'text' always returns raw string */
  parseMode: 'auto' | 'json' | 'text';
}

/** Configuration for a junction/hub node — pass-through wiring point with mirrored input/output ports */
export interface JunctionNodeConfig {
  /** Dynamic pass-through ports — each port appears on both input and output sides */
  ports: Array<{ name: string; type: string; description: string }>;
}

/** Runtime state of a pending approval gate */
export interface PendingApproval {
  id: string;
  runId: string;
  nodeId: string;
  compositionId: string;
  compositionName: string;
  message: string;
  previewVariables?: Record<string, unknown>;
  createdAt: string;
  timeoutMs?: number;
}

/** An edge connecting an output port of one node to an input port of another */
export interface CompositionEdge {
  id: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
}

// ────────────────────────────────────────────────────────────────
//  Run History
// ────────────────────────────────────────────────────────────────

/** Result of a single node in a pipeline run */
export interface NodeRunResult {
  nodeId: string;
  workflowId: string;
  workflowName: string;
  status: 'completed' | 'failed' | 'skipped';
  durationMs: number;
  stepsTotal: number;
  stepsCompleted: number;
  error?: string;
  outputVariables?: Record<string, unknown>;
  expectationResults?: Array<{ description: string; passed: boolean; detail: string }>;
  retryAttempts?: number;
}

/** Persisted record of a single workflow or pipeline run */
export interface RunRecord {
  /** Unique identifier, e.g. "run-1708963200000-abc12" */
  id: string;
  /** Whether this was a single workflow run or a pipeline (composition) run */
  type: 'workflow' | 'pipeline';
  /** ID of the workflow or composition that was run */
  sourceId: string;
  /** Human-readable name */
  name: string;
  /** ISO timestamp when execution started */
  startedAt: string;
  /** ISO timestamp when execution completed */
  completedAt?: string;
  /** Total duration in milliseconds */
  durationMs: number;
  /** Final status */
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  /** Error message if failed or cancelled */
  error?: string;
  /** Per-node results (pipeline runs only) */
  nodeResults?: NodeRunResult[];
  /** Total nodes (pipeline runs only) */
  nodesTotal?: number;
  /** Nodes completed successfully (pipeline runs only) */
  nodesCompleted?: number;
  /** Total steps (workflow runs only) */
  stepsTotal?: number;
  /** Steps completed (workflow runs only) */
  stepsCompleted?: number;
  /** Per-step results (workflow runs only) */
  stepResults?: Array<{ index: number; label: string; type: string; status: string; error?: string }>;
  /** Input variables passed at run start */
  variables: Record<string, unknown>;
  /** Files produced during execution */
  outputFiles?: string[];
  /** Collected pipeline outputs from the output node (pipeline runs only) */
  pipelineOutputs?: Record<string, unknown>;
  /** Batch ID if this run is part of a batch */
  batchId?: string;
  /** Schedule ID if triggered by a schedule */
  scheduleId?: string;
}

// ────────────────────────────────────────────────────────────────
//  Batching
// ────────────────────────────────────────────────────────────────

/** A pool of values for a single variable */
export interface VariablePool {
  variableName: string;
  values: unknown[];
}

/**
 * Configuration for running a pipeline in batch mode
 *
 * - `zip` mode: iterate pools in parallel (like Python's zip). Length = min pool length.
 * - `product` mode: Cartesian product of all pools. Length = product of all pool lengths.
 */
export interface BatchConfig {
  pools: VariablePool[];
  mode: 'zip' | 'product';
  /** Delay in ms between each iteration (default: 2000) */
  delayBetweenMs: number;
}

// ────────────────────────────────────────────────────────────────
//  Scheduling
// ────────────────────────────────────────────────────────────────

/**
 * A schedule that triggers a composition run at specified intervals.
 *
 * Uses simplified cron syntax: minute hour day-of-month month day-of-week
 * Supports: *, specific values, comma lists, ranges (1-5), and step values (e.g. every 5 minutes).
 */
export interface Schedule {
  id: string;
  compositionId: string;
  compositionName: string;
  /** Simplified cron expression: "minute hour dom month dow" */
  cron: string;
  /** Whether this schedule is active */
  enabled: boolean;
  /** Variables to pass to each triggered run */
  variables?: Record<string, unknown>;
  /** ISO timestamp of last triggered run */
  lastRunAt?: string;
  /** Run ID of last triggered run */
  lastRunId?: string;
  /** Human-readable description */
  description?: string;
  /** ISO timestamp when created */
  createdAt: string;
}

// ────────────────────────────────────────────────────────────────
//  Bridge server interface (subset used by workflow engine)
// ────────────────────────────────────────────────────────────────

/** Minimal bridge server interface for the workflow executor */
export interface BridgeInterface {
  send(action: string, params?: Record<string, unknown>, timeout?: number): Promise<unknown>;
  readonly isConnected: boolean;
}

// ────────────────────────────────────────────────────────────────
//  Recording event types (from Chrome extension)
// ────────────────────────────────────────────────────────────────

export interface RecordingEvent {
  type: 'recording_event';
  event: 'click' | 'input' | 'change' | 'keydown' | 'navigate' | 'file_dialog';
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
    /** Shadow DOM path from document root to element — accessibility mode */
    shadowPath?: ShadowHostDescriptor[];
    /** Visual fingerprint of SVG element — accessibility mode */
    svgFingerprint?: SvgFingerprint;
    /** Computed accessible name (WAI-ARIA algorithm) — accessibility mode */
    accessibleName?: string;
    /** Computed ARIA role (explicit or implicit from tag) — accessibility mode */
    computedRole?: string;
  };
  page: {
    url: string;
    title: string;
  };
  keyboard?: {
    key: string;
    modifiers: string[];
  };
  /** Metadata about the element that received focus after a keyboard event */
  focusedElement?: {
    focused: boolean;
    tag: string;
    text?: string;
    ariaLabel?: string;
    role?: string;
    selector?: string;
    placeholder?: string;
    id?: string;
    name?: string;
  };
  timestamp: number;
}
