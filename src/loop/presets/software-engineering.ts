/**
 * Software Engineering Preset
 *
 * Pre-configured agent factories optimized for software engineering tasks.
 * Uses a curated 9-tool set, the SE system prompt, and project context discovery.
 */

import { Agent } from '../agent.js';
import { ToolRegistry } from '../tool-registry.js';
import { AgentConfig, Logger } from '../types.js';
import { SOFTWARE_ENGINEERING_PROMPT } from '../prompts/software-engineering.js';

// Core file tools
import { fileReadDefinition, fileReadHandler } from '../tools/file-read.js';
import { fileEditDefinition, fileEditHandler } from '../tools/file-edit.js';
import { fileWriteDefinition, fileWriteHandler } from '../tools/file-write.js';

// Search/navigation tools
import { grepDefinition, grepHandler } from '../tools/grep.js';
import { fileSearchDefinition, fileSearchHandler } from '../tools/file-search.js';
import { listDirectoryDefinition, listDirectoryHandler } from '../tools/list-directory.js';

// Execution tools
import { shellExecuteDefinition, shellExecuteHandler } from '../tools/shell-execute.js';
import { gitDefinition, gitHandler } from '../tools/git.js';
import { testRunnerDefinition, testRunnerHandler } from '../tools/test-runner.js';

export interface SoftwareAgentOptions {
  model?: string;
  provider?: 'openai' | 'anthropic' | 'groq';
  apiKey?: string;
  workingDirectory?: string;
  /** Additional instructions appended after the SE prompt */
  additionalSystemPrompt?: string;
  logger?: Logger;
  /** Max agentic loop iterations (default: 200) */
  maxIterations?: number;
  /** Max tokens per LLM response (default: 16384) */
  maxTokens?: number;
}

/**
 * Create a tool registry with only the 9 tools needed for software engineering.
 * Fewer tools = less prompt noise = better tool selection by the LLM.
 */
export function createSoftwareToolRegistry(logger?: Logger): ToolRegistry {
  const registry = new ToolRegistry(logger);

  // File tools — note file_edit is listed before file_write to signal preference
  registry.register(fileReadDefinition, fileReadHandler);
  registry.register(fileEditDefinition, fileEditHandler);
  registry.register(fileWriteDefinition, fileWriteHandler);

  // Search/navigation
  registry.register(grepDefinition, grepHandler);
  registry.register(fileSearchDefinition, fileSearchHandler);
  registry.register(listDirectoryDefinition, listDirectoryHandler);

  // Execution
  registry.register(shellExecuteDefinition, shellExecuteHandler);
  registry.register(gitDefinition, gitHandler);
  registry.register(testRunnerDefinition, testRunnerHandler);

  return registry;
}

/**
 * Create a V1 Agent pre-configured for software engineering tasks.
 *
 * Uses the SE system prompt, curated 9-tool set, and enables dangerous tools
 * (file_write and shell_execute are needed for real coding work).
 *
 * Project context (AGENT.md, CLAUDE.md) is discovered automatically at run time
 * by the Agent.run() method.
 */
export async function createSoftwareAgent(
  options: SoftwareAgentOptions = {}
): Promise<Agent> {
  const workingDir = options.workingDirectory || process.cwd();
  const logger = options.logger || console;

  let systemPrompt = SOFTWARE_ENGINEERING_PROMPT;
  if (options.additionalSystemPrompt) {
    systemPrompt += '\n\n' + options.additionalSystemPrompt;
  }

  const registry = createSoftwareToolRegistry(logger);

  const config: AgentConfig = {
    name: 'software-engineer',
    systemPrompt,
    model: options.model || 'claude-sonnet-4-20250514',
    provider: options.provider || 'anthropic',
    apiKey: options.apiKey,
    workingDirectory: workingDir,
    allowDangerousTools: true,
    maxIterations: options.maxIterations ?? 200,
    maxTokens: options.maxTokens ?? 16384,
    logger,
  };

  return new Agent(config, registry);
}
