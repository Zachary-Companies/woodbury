import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolDefinition, ToolHandler } from './loop/index.js';
import { redactSecrets } from './redact.js';
import { createCheckpoint } from './git-checkpoint.js';

// ── Types ────────────────────────────────────────────────────

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface RiskCheck {
  id: number;
  timestamp: number;
  action: string;
  riskLevel: RiskLevel;
  justification: string;
  guidance: string;
  requiresApproval: boolean;
  dryRun: boolean;
  checkpointRef?: string;
}

// ── Guidance map ─────────────────────────────────────────────

const RISK_GUIDANCE: Record<RiskLevel, string> = {
  low: 'Proceed normally. Low-risk action documented.',
  medium: 'Proceed with care. Double-check the target and parameters before executing.',
  high: 'CAUTION: Verify you have the correct target. Consider creating a backup or dry-run first.',
  critical:
    'REQUIRES USER APPROVAL.\n'
    + 'You MUST give a <final_answer> that:\n'
    + '1. Explains what you want to do\n'
    + '2. Why it is necessary\n'
    + '3. The risk and rollback plan\n'
    + '4. Asks user to confirm\n'
    + '\n'
    + 'DO NOT execute this action. Wait for approval.',
};

const VALID_RISK_LEVELS: RiskLevel[] = ['low', 'medium', 'high', 'critical'];

// ── Tool definition ──────────────────────────────────────────

export const preflightCheckDefinition: ToolDefinition = {
  name: 'preflight_check',
  description:
    'Document a risk assessment before performing a dangerous action. '
    + 'Call this BEFORE file deletions, production deployments, database modifications, '
    + 'force-push, or any irreversible operation. NOT needed for reads, tests, or normal commits.',
  parameters: [
    {
      name: 'action',
      type: 'string',
      description: 'What you are about to do (e.g. "Delete all files in dist/")',
      required: true,
    },
    {
      name: 'risk_level',
      type: 'string',
      description: 'Risk level: low, medium, high, or critical',
      required: true,
    },
    {
      name: 'justification',
      type: 'string',
      description: 'Why this action is necessary and why the risk is acceptable',
      required: true,
    },
    {
      name: 'dry_run',
      type: 'boolean',
      description: 'If true, record the check but do NOT approve execution. Use to evaluate risk without committing.',
      required: false,
    },
  ],
  dangerous: false,
};

// ── Guard ────────────────────────────────────────────────────

const RISK_TOOL_NAMES = new Set(['preflight_check']);

export function isRiskTool(name: string): boolean {
  return RISK_TOOL_NAMES.has(name);
}

// ── Disk I/O ─────────────────────────────────────────────────

function riskLogPath(workingDirectory: string): string {
  return join(workingDirectory, '.woodbury-work', 'risk-log.json');
}

export async function loadRiskLog(workingDirectory: string): Promise<RiskCheck[]> {
  try {
    const raw = await readFile(riskLogPath(workingDirectory), 'utf-8');
    return JSON.parse(raw) as RiskCheck[];
  } catch {
    return [];
  }
}

async function saveRiskLog(workingDirectory: string, log: RiskCheck[]): Promise<void> {
  const dir = join(workingDirectory, '.woodbury-work');
  await mkdir(dir, { recursive: true });
  await writeFile(riskLogPath(workingDirectory), JSON.stringify(log, null, 2), 'utf-8');
}

// ── Factory ──────────────────────────────────────────────────

export interface RiskGateToolsHandle {
  preflightHandler: ToolHandler;
  getRiskLog: (workingDirectory: string) => Promise<RiskCheck[]>;
}

export function createRiskGateTools(): RiskGateToolsHandle {

  const preflightHandler: ToolHandler = async (params, context) => {
    const rawAction = params.action as string;
    const riskLevel = params.risk_level as string;
    const rawJustification = params.justification as string;
    const dryRun = params.dry_run === true || params.dry_run === 'true';

    if (!rawAction) return 'Error: "action" is required.';
    if (!rawJustification) return 'Error: "justification" is required.';
    if (!VALID_RISK_LEVELS.includes(riskLevel as RiskLevel)) {
      return `Error: Invalid risk_level "${riskLevel}". Use: ${VALID_RISK_LEVELS.join(', ')}`;
    }

    const level = riskLevel as RiskLevel;
    const guidance = RISK_GUIDANCE[level];
    const requiresApproval = level === 'critical';

    // Redact secrets before persisting
    const action = redactSecrets(rawAction);
    const justification = redactSecrets(rawJustification);

    const log = await loadRiskLog(context.workingDirectory);
    const nextId = log.length > 0 ? Math.max(...log.map((r) => r.id)) + 1 : 1;

    const check: RiskCheck = {
      id: nextId,
      timestamp: Date.now(),
      action,
      riskLevel: level,
      justification,
      guidance,
      requiresApproval,
      dryRun,
    };

    // Auto git checkpoint for high/critical risk actions
    if (level === 'high' || level === 'critical') {
      try {
        const checkpoint = await createCheckpoint(context.workingDirectory, action);
        if (checkpoint.ref) check.checkpointRef = checkpoint.ref;
      } catch { /* best-effort */ }
    }

    log.push(check);
    await saveRiskLog(context.workingDirectory, log);

    const lines = [
      `Preflight check #${check.id} recorded.`,
      ``,
      `Action: ${action}`,
      `Risk level: ${level.toUpperCase()}`,
      `Justification: ${justification}`,
      ``,
      `Guidance: ${guidance}`,
    ];

    if (check.checkpointRef) {
      const shortRef = check.checkpointRef.slice(0, 8);
      lines.push(
        ``,
        `Git checkpoint: ${shortRef}`,
        `Rollback: git stash apply ${shortRef}`,
      );
    }

    if (requiresApproval) {
      lines.push(
        ``,
        `⛔ CRITICAL — This action REQUIRES user approval.`,
        `You MUST give a <final_answer> explaining what you want to do, why, the risk, and a rollback plan.`,
        `DO NOT execute this action until the user explicitly confirms.`,
      );
    }

    if (dryRun) {
      lines.push(
        ``,
        `🔍 DRY RUN: This check has been recorded but is NOT approved for execution.`,
        `The action was evaluated for risk assessment purposes only.`,
      );
    }

    return lines.join('\n');
  };

  const getRiskLog = (workingDirectory: string) => loadRiskLog(workingDirectory);

  return {
    preflightHandler,
    getRiskLog,
  };
}
