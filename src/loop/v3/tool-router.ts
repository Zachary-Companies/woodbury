import type { NativeToolDefinition } from '../v2/types/tool-types.js';
import { SkillRegistry, type SkillExecutionPlan } from './skill-registry.js';

const skillRegistry = new SkillRegistry();

export function selectSkillExecution(
  allTools: NativeToolDefinition[],
  userMessage: string,
  taskDescription = '',
): SkillExecutionPlan {
  return skillRegistry.select(allTools, userMessage, taskDescription);
}

export function selectTools(
  allTools: NativeToolDefinition[],
  userMessage: string,
  taskDescription = '',
): NativeToolDefinition[] {
  return selectSkillExecution(allTools, userMessage, taskDescription).allowedTools;
}
