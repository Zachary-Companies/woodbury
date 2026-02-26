/**
 * Workflow Automation System
 *
 * Provides a structured, executable workflow format for browser automation.
 * Workflows capture interactions as JSON with CSS selectors, fallback strategies,
 * fuzzy position validation, variable substitution, and composition.
 */

// Types
export type {
  WorkflowDocument,
  WorkflowMetadata,
  VariableDeclaration,
  ElementTarget,
  ElementBounds,
  ResolvedElement,
  WorkflowStep,
  StepBase,
  RetryConfig,
  NavigateStep,
  ClickStep,
  TypeStep,
  WaitStep,
  AssertStep,
  DownloadStep,
  MoveFileStep,
  ScrollStep,
  KeyboardStep,
  SubWorkflowStep,
  ConditionalStep,
  LoopStep,
  TryCatchStep,
  SetVariableStep,
  VariableSource,
  Precondition,
  Postcondition,
  WaitCondition,
  AssertCondition,
  ExecutionOptions,
  ExecutionResult,
  StepResult,
  ExecutionProgressEvent,
  BridgeInterface,
  RecordingEvent,
} from './types.js';

// Engine
export { WorkflowExecutor } from './executor.js';
export { ElementResolver } from './resolver.js';
export { ConditionValidator } from './validator.js';

// Variable substitution
export {
  substituteString,
  substituteObject,
  hasVariables,
  extractVariableNames,
} from './variable-sub.js';

// Loader
export {
  loadWorkflow,
  discoverWorkflows,
  findWorkflowById,
  loadWorkflowsFromDir,
} from './loader.js';
export type { DiscoveredWorkflow } from './loader.js';

// Recorder
export { WorkflowRecorder } from './recorder.js';
export type { RecorderStatus, RecorderResult } from './recorder.js';
