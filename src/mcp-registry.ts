/**
 * MCP Server Registry
 *
 * Built-in registry of known MCP servers with friendly metadata,
 * installation guidance, and availability checks. Used by the /mcp
 * command to help non-technical users discover, install, and manage
 * MCP intelligence servers.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface KnownMcpServer {
  /** Config key used in mcp-servers.json and tool prefixes */
  name: string;
  /** Human-friendly display name */
  displayName: string;
  /** One-line description of what this server does */
  description: string;
  /** Command to spawn */
  command: string;
  /** Command arguments */
  args: string[];
  /** Category for grouping in UI */
  category: 'ai-agent' | 'intelligence' | 'tools';
  /** Check if the server can be started (command exists, API keys set, etc.) */
  checkAvailable: () => Promise<{ available: boolean; missing: string[] }>;
  /** Step-by-step install instructions (plain text, shown in terminal) */
  setupGuide: string[];
}

function hasEnvKey(key: string): boolean {
  // Check process.env and common .env file locations
  if (process.env[key]) return true;

  // Check ~/.woodbury/.env
  try {
    const envPath = path.join(os.homedir(), '.woodbury', '.env');
    const content = fs.readFileSync(envPath, 'utf-8');
    return content.includes(`${key}=`);
  } catch { /* ignore */ }

  // Check ~/.agentic-loop/.env
  try {
    const envPath = path.join(os.homedir(), '.agentic-loop', '.env');
    const content = fs.readFileSync(envPath, 'utf-8');
    return content.includes(`${key}=`);
  } catch { /* ignore */ }

  return false;
}

function hasNpx(): boolean {
  try {
    execSync('which npx', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Built-in known MCP servers.
 */
export const knownServers: KnownMcpServer[] = [
  {
    name: 'claude-code',
    displayName: 'Claude Code',
    description: 'Delegates coding tasks to a Claude Code agent',
    command: 'npx',
    args: ['-y', '@anthropic-ai/claude-code', 'mcp', 'serve'],
    category: 'ai-agent',
    async checkAvailable() {
      const missing: string[] = [];
      if (!hasNpx()) missing.push('npx (install Node.js)');
      if (!hasEnvKey('ANTHROPIC_API_KEY')) missing.push('ANTHROPIC_API_KEY');
      return { available: missing.length === 0, missing };
    },
    setupGuide: [
      'Setting up Claude Code',
      '',
      '1. Install Node.js (if not already installed)',
      '   https://nodejs.org/',
      '',
      '2. Get an Anthropic API key',
      '   https://console.anthropic.com/',
      '',
      '3. Set your API key:',
      '   Add to ~/.woodbury/.env:',
      '   ANTHROPIC_API_KEY=sk-ant-...',
      '',
      '4. Enable the server:',
      '   /mcp enable claude-code',
      '',
      'Claude Code gives Woodbury access to a full coding agent',
      'that can read/write files, run commands, and search code.',
    ],
  },

  {
    name: 'codex',
    displayName: 'OpenAI Codex',
    description: 'Delegates coding tasks to an OpenAI Codex agent',
    command: 'npx',
    args: ['-y', '@openai/codex', 'mcp-server'],
    category: 'ai-agent',
    async checkAvailable() {
      const missing: string[] = [];
      if (!hasNpx()) missing.push('npx (install Node.js)');
      if (!hasEnvKey('OPENAI_API_KEY')) missing.push('OPENAI_API_KEY');
      return { available: missing.length === 0, missing };
    },
    setupGuide: [
      'Setting up OpenAI Codex',
      '',
      '1. Install Node.js (if not already installed)',
      '   https://nodejs.org/',
      '',
      '2. Get an OpenAI API key',
      '   https://platform.openai.com/api-keys',
      '',
      '3. Set your API key:',
      '   Add to ~/.woodbury/.env:',
      '   OPENAI_API_KEY=sk-...',
      '',
      '4. Enable the server:',
      '   /mcp enable codex',
      '',
      'Codex gives Woodbury access to OpenAI\'s coding agent',
      'for autonomous code generation and editing tasks.',
    ],
  },

  {
    name: 'intelligence',
    displayName: 'Woodbury Intelligence',
    description: 'AI-powered pipeline, workflow, and tool generation',
    command: 'node',
    args: [path.join(os.homedir(), 'Documents/GitHub/woodbury-intelligence/dist/index.js')],
    category: 'intelligence',
    async checkAvailable() {
      const missing: string[] = [];
      const indexPath = path.join(os.homedir(), 'Documents/GitHub/woodbury-intelligence/dist/index.js');
      if (!fs.existsSync(indexPath)) missing.push('woodbury-intelligence (not built)');
      if (!hasEnvKey('ANTHROPIC_API_KEY') && !hasEnvKey('OPENAI_API_KEY')) {
        missing.push('ANTHROPIC_API_KEY or OPENAI_API_KEY (need at least one)');
      }
      return { available: missing.length === 0, missing };
    },
    setupGuide: [
      'Setting up Woodbury Intelligence',
      '',
      '1. Build the intelligence server:',
      '   cd ~/Documents/GitHub/woodbury-intelligence',
      '   npm install && npm run build',
      '',
      '2. Set at least one API key in ~/.woodbury/.env:',
      '   ANTHROPIC_API_KEY=sk-ant-...  (for Claude)',
      '   OPENAI_API_KEY=sk-...         (for GPT)',
      '',
      '3. Enable the server:',
      '   /mcp enable intelligence',
      '',
      'Intelligence provides AI-powered generation of pipelines,',
      'workflows, tool compositions, failure diagnosis, and more.',
    ],
  },
];

/**
 * Look up a known server by name.
 */
export function getKnownServer(name: string): KnownMcpServer | undefined {
  return knownServers.find((s) => s.name === name);
}

/**
 * Get all known server names.
 */
export function getKnownServerNames(): string[] {
  return knownServers.map((s) => s.name);
}
