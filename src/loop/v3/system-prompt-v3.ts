/**
 * V3 System Prompt Builder — Compact, chat-focused prompt for native tool calling.
 *
 * Builds a lightweight system prompt directly instead of wrapping the massive
 * terminal-agent base prompt (~78K chars). Includes only what the closure engine
 * needs: identity, environment, tool-calling guidance, project context, and
 * extension/MCP info.
 */

import { platform, homedir } from 'node:os';
import { loadProjectContext, loadContextDirectory } from '../../context-loader.js';
import type { McpServerInfo } from '../../system-prompt.js';
import type { NativeToolDefinition } from '../v2/types/tool-types.js';

/**
 * Build a compact V3 system prompt for the chat dashboard.
 * ~3-5K chars instead of ~78K — keeps input tokens manageable with 90+ tools.
 */
export async function buildV3SystemPrompt(
  workingDirectory: string,
  contextDir?: string,
  extensionPromptSections?: string[],
  tools?: NativeToolDefinition[],
  mcpServers?: McpServerInfo[],
): Promise<string> {
  const parts: string[] = [];
  const now = new Date();

  // ── Identity ─────────────────────────────────────────────
  parts.push(`You are Woodbury, an AI assistant with access to tools for coding, file management, image generation, web search, and more.`);

  // ── Environment ──────────────────────────────────────────
  parts.push(`
## Environment
- Platform: ${platform()}
- Home: ${homedir()}
- Working directory: ${workingDirectory}
- Date: ${now.toISOString().split('T')[0]}`);

  // ── Behavior ─────────────────────────────────────────────
  parts.push(`
## Behavior
- Be concise and helpful.
- Use tools to accomplish tasks rather than just explaining how.
- When you finish a task, give a brief summary of what you did.
- NEVER write secrets, API keys, or passwords to files or output.`);

  // ── Tool Calling (critical for native tool use) ──────────
  parts.push(`
## Tool Calling — CRITICAL
You MUST use tools to accomplish tasks. NEVER describe or narrate what you "would do" or pretend that work has been completed — actually call the tools to do the work.

The system handles tool calling natively. Simply decide which tool to use and provide the required parameters.

RULES:
- If the user asks you to create, generate, read, write, or search for something, USE THE TOOLS.
- NEVER respond with a fake summary of completed work. Every action must be backed by a real tool call.
- Only give a text summary AFTER you have actually executed the tools and received their results.
- After completing actions, verify your work when possible.`);

  // ── MCP servers ──────────────────────────────────────────
  if (mcpServers && mcpServers.length > 0) {
    const serverDescriptions = mcpServers.map((s) => {
      const toolList = s.toolNames.map((t) => `  - \`${t}\``).join('\n');
      return `### ${s.name}\nTools:\n${toolList}`;
    }).join('\n\n');

    // Check if intelligence server is available
    const hasIntelligence = mcpServers.some(s => s.name === 'intelligence');

    parts.push(`
## MCP Intelligence Servers
External AI tools available via MCP. Call them like built-in tools.

${serverDescriptions}`);

    // ── Intelligence tool preference guidance ──────────────
    if (hasIntelligence) {
      parts.push(`
## Intelligence Tools — MANDATORY
**RULE: When a user asks you to create, build, set up, make, or automate ANY multi-step process, you MUST call \`mcp__intelligence__generate_pipeline\` or \`mcp__intelligence__generate_workflow\`. Do NOT attempt to do the work yourself using other tools like shell_execute, file_write, list_directory, etc. The intelligence tools create saved compositions visible in the dashboard UI.**

**NEVER** browse the filesystem looking for existing pipelines or workflows. **NEVER** use shell_execute, file_read, or list_directory to manually create or inspect pipeline files. ALWAYS call the intelligence tools directly.

**NEVER** claim a pipeline was created unless you received a real successful result from an intelligence tool that includes a saved composition or composition id. If an intelligence tool fails, report the exact tool error. Do not speculate about causes like "response length" unless the tool output explicitly says that.

**NEVER** fall back to \`workflow_execute\` or \`workflow_play\` when the user asked for a reusable pipeline. Those are execution tools, not creation tools.

**Use \`mcp__intelligence__generate_pipeline\`** for:
- ANY multi-step data flow, processing, or automation request
- Fetching + processing + outputting data
- Summarizing, extracting, analyzing, or transforming information
- Creating reusable processes

**Use \`mcp__intelligence__generate_workflow\`** for:
- Repeatable processes with conditions or branching
- Scheduled/recurring automations

**Use \`mcp__intelligence__compose_tools\`** for:
- Combining multiple tools into one reusable operation

If \`generate_pipeline\` fails, either retry \`generate_pipeline\` with tighter constraints or tell the user the exact failure. Do not silently switch to ad-hoc file writing, shell commands, or one-off execution.

**WHY:** Doing work directly gives a one-time result. Intelligence tools create a saved pipeline in the dashboard that users can see, modify, and re-run. Non-technical users expect to see their creation in the UI.

**Pipeline architecture:** Most steps should use \`__script__\` nodes (custom JavaScript). Only use a real workflow node when the request involves a platform with a dedicated workflow (e.g., "post to Instagram"). The system auto-provides available workflows — you do NOT need to find or list them yourself.

**Examples — ALL of these MUST use intelligence tools:**
- "Summarize the top stories from Hacker News" → generate_pipeline
- "Create a pipeline to turn photos into cartoons" → generate_pipeline
- "Get the weather and send me a report" → generate_pipeline
- "Set up something that checks a website daily" → generate_workflow
- "Make me a cartoon character generator" → generate_pipeline
- "Help me automate my morning briefing" → generate_workflow`);
    }
  }

  // ── Extension instructions ───────────────────────────────
  if (extensionPromptSections && extensionPromptSections.length > 0) {
    parts.push(`
## Extension Instructions

${extensionPromptSections.join('\n\n')}`);
  }

  // ── Project context ──────────────────────────────────────
  const projectContext = await loadProjectContext(workingDirectory);
  if (projectContext) {
    parts.push(`
## Project Context
${projectContext}`);
  }

  // ── Additional context directory ─────────────────────────
  if (contextDir) {
    const dirContext = await loadContextDirectory(contextDir);
    if (dirContext) {
      parts.push(`
## Additional Context
${dirContext}`);
    }
  }

  // NOTE: Do NOT append tool documentation here. Tools are passed via the native
  // API `tools` parameter, which gives the model structured definitions it can
  // call directly. Duplicating them as text in the system prompt causes the model
  // to describe tool usage in prose instead of making actual tool_use API calls.

  return parts.join('\n');
}
