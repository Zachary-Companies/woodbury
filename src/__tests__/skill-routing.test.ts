import { selectSkillExecution, selectTools } from '../loop/v3/tool-router';
import { SkillRegistry } from '../loop/v3/skill-registry';
import { SkillPolicyStore } from '../loop/v3/skill-policy-store';
import { StrategicPlanner } from '../loop/v3/strategic-planner';
import type { NativeToolDefinition } from '../loop/v2/types/tool-types';
import type { Goal, MemoryRecord, TaskGraph } from '../loop/v3/types';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeTool(name: string, description = ''): NativeToolDefinition {
  return {
    name,
    description,
    input_schema: {
      type: 'object',
      properties: {},
    },
  };
}

const TOOLSET: NativeToolDefinition[] = [
  makeTool('file_read', 'Read files'),
  makeTool('file_write', 'Write files'),
  makeTool('list_directory', 'List directories'),
  makeTool('file_search', 'Find files'),
  makeTool('grep', 'Search text'),
  makeTool('shell_execute', 'Run shell commands'),
  makeTool('code_execute', 'Run code'),
  makeTool('git', 'Git operations'),
  makeTool('test_run', 'Run tests'),
  makeTool('browser', 'Browser automation'),
  makeTool('browser_query', 'Query browser DOM'),
  makeTool('screenshot', 'Take screenshots'),
  makeTool('vision_analyze', 'Analyze screenshots'),
  makeTool('web_fetch', 'Fetch URLs'),
  makeTool('workflow_execute', 'Execute workflow'),
  makeTool('mcp__intelligence__generate_pipeline', 'Generate pipeline'),
  makeTool('mcp__intelligence__compose_tools', 'Compose tools into workflow'),
  makeTool('mcp__claude-code__plan', 'Plan code changes'),
  makeTool('delegate', 'Delegate to subagent'),
  makeTool('memory_recall', 'Recall memories'),
];

describe('skill routing', () => {
  it('selects workflow skill and hides direct code-writing tools for pipeline requests', () => {
    const selection = selectSkillExecution(
      TOOLSET,
      'Build a pipeline that summarizes RSS feeds and posts a daily briefing',
      'Create an automation pipeline for content publishing',
    );

    expect(selection.skill.name).toBe('workflow_or_pipeline_build');
    expect(selection.allowedToolNames).toContain('mcp__intelligence__generate_pipeline');
    expect(selection.allowedToolNames).toContain('mcp__intelligence__compose_tools');
    expect(selection.allowedToolNames).not.toContain('workflow_execute');
    expect(selection.allowedToolNames).not.toContain('workflow_play');
    expect(selection.allowedToolNames).not.toContain('file_write');
    expect(selection.allowedToolNames).not.toContain('shell_execute');
  });

  it('selects browser skill for browser-driven work', () => {
    const selection = selectSkillExecution(
      TOOLSET,
      'Open the website, click the login button, and inspect the page state',
      'Navigate and inspect the page',
    );

    expect(selection.skill.name).toBe('browser_automation');
    expect(selection.allowedToolNames).toEqual(expect.arrayContaining(['browser', 'browser_query', 'screenshot']));
  });

  it('selects dashboard ui skill for chat panel changes and keeps coding tools available', () => {
    const selection = selectSkillExecution(
      TOOLSET,
      'Update the dashboard chat panel CSS and render logic',
      'Edit config-dashboard chat workspace behavior',
    );

    expect(selection.skill.name).toBe('dashboard_or_ui_change');
    expect(selection.allowedToolNames).toContain('file_write');
    expect(selection.allowedToolNames).toContain('shell_execute');
  });

  it('legacy selectTools returns the selected skill tool scope', () => {
    const tools = selectTools(
      TOOLSET,
      'Fix the TypeScript bug and run the tests',
      'Change code and verify it',
    );

    expect(tools.map(tool => tool.name)).toContain('file_write');
    expect(tools.map(tool => tool.name)).toContain('test_run');
  });

  it('honors planner-selected skills instead of reselecting independently', () => {
    const registry = new SkillRegistry();
    const selection = registry.select(
      TOOLSET,
      'Fix the TypeScript bug and run the tests',
      'Inspect the repository structure before editing',
      'repo_explore',
    );

    expect(selection.skill.name).toBe('repo_explore');
    expect(selection.reason).toContain('Planner assigned repo_explore');
    expect(selection.allowedToolNames).not.toContain('file_write');
  });

  it('includes previous skill and handoff metadata in the selection result', () => {
    const registry = new SkillRegistry();
    const selection = registry.select(
      TOOLSET,
      'Fix the route and verify it',
      'Implement the fix in the route',
      'code_change',
      {
        skill: {
          name: 'repo_explore',
          description: 'Explore the repo',
          whenToUse: 'Use for inspection',
          promptGuidance: 'Inspect first',
        },
        reason: 'Planner assigned repo_explore',
        matchedKeywords: ['inspect'],
        allowedToolNames: ['file_read'],
        hardBannedToolNames: ['file_write'],
        escalationActive: false,
        recoveryHints: [],
      },
    );

    expect(selection.previousSkillName).toBe('repo_explore');
    expect(selection.previousSkillReason).toContain('repo_explore');
  });

  it('keeps workflow hard bans in place unless the user explicitly escalates', () => {
    const registry = new SkillRegistry();
    const normal = registry.select(
      TOOLSET,
      'Build a workflow pipeline for daily summaries',
      'Create the workflow and keep using the composition tools',
    );
    const escalated = registry.select(
      TOOLSET,
      'Build a workflow pipeline and escalate to edit the files directly if needed',
      'Create the workflow and edit the files directly if the tools fail',
    );

    expect(normal.skill.name).toBe('workflow_or_pipeline_build');
    expect(normal.allowedToolNames).not.toContain('file_write');
    expect(normal.hardBannedToolNames).toContain('file_write');
    expect(escalated.escalationActive).toBe(true);
    expect(escalated.allowedToolNames).toContain('file_write');
  });

  it('applies learned recovery hints to skill guidance', () => {
    const learnedMemories: MemoryRecord[] = [
      {
        id: 'm1',
        type: 'procedural',
        title: 'Skill update for test_and_verify',
        content: 'Check failing test output before editing again.',
        tags: ['skill-update', 'test_and_verify', 'recovery-hint'],
        confidence: 0.8,
        triggerPattern: 'test|jest|verify',
        accessCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    const registry = new SkillRegistry({
      getSkillMemories(skillName: string) {
        return skillName === 'test_and_verify' ? learnedMemories : [];
      },
    } as any);

    const selection = registry.select(
      TOOLSET,
      'Run the Jest tests and verify the build',
      'Validate the implementation through tests',
    );

    expect(selection.skill.name).toBe('test_and_verify');
    expect(selection.recoveryHints).toContain('Check failing test output before editing again.');
    expect(selection.skill.promptGuidance).toContain('Check failing test output before editing again.');
  });

  it('applies approved policy-store updates separately from memory blobs', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'woodbury-skill-policy-'));
    const store = new SkillPolicyStore(join(tempDir, 'skill-policies.json'));
    const suggested = store.persistSuggestedUpdates([
      {
        kind: 'skill_update',
        skillName: 'repo_explore',
        updateType: 'applicability',
        applicabilityPattern: 'inspect|trace',
        guidance: 'Use repo_explore whenever the task starts with inspection and tracing.',
        confidence: 0.9,
      },
    ]);
    store.updateReviewStatus(suggested[0].id, 'approved');

    const registry = new SkillRegistry(undefined, store);
    const selection = registry.select(
      TOOLSET,
      'Inspect and trace the route behavior',
      'Trace the current repository implementation',
    );

    expect(selection.skill.name).toBe('repo_explore');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('planner annotates clean handoffs from exploration to implementation and verification', () => {
    const planner = new StrategicPlanner(
      {} as any,
      { query: () => [] } as any,
      {} as any,
      'anthropic',
      'test-model',
      'system',
    );
    const goal: Goal = {
      id: 'g1',
      objective: 'Fix the chat route and verify it with tests',
      successCriteria: [],
      constraints: [],
      forbiddenActions: [],
      priority: 'normal',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const graph: TaskGraph = {
      executionOrder: ['t1', 't2', 't3'],
      nodes: [
        {
          id: 't1', goalId: 'g1', description: 'Explore and inspect the existing chat route', status: 'ready', dependsOn: [], blocks: ['t2'], maxRetries: 2, retryCount: 0, validators: [], createdAt: new Date().toISOString(),
        },
        {
          id: 't2', goalId: 'g1', description: 'Implement the fix in the chat route', status: 'pending', dependsOn: ['t1'], blocks: ['t3'], maxRetries: 2, retryCount: 0, validators: [], createdAt: new Date().toISOString(),
        },
        {
          id: 't3', goalId: 'g1', description: 'Run tests and verify the fix', status: 'pending', dependsOn: ['t2'], blocks: [], maxRetries: 2, retryCount: 0, validators: [], createdAt: new Date().toISOString(),
        },
      ],
    };

    const annotated = planner.applySkillTransitions(graph, goal);
    expect(annotated.nodes.find(node => node.id === 't1')?.preferredSkill).toBe('repo_explore');
    expect(annotated.nodes.find(node => node.id === 't2')?.preferredSkill).toBe('code_change');
    expect(annotated.nodes.find(node => node.id === 't2')?.preferredSkillReason).toContain('repo_explore');
    expect(annotated.nodes.find(node => node.id === 't3')?.preferredSkill).toBe('test_and_verify');
    expect(annotated.nodes.find(node => node.id === 't3')?.preferredSkillReason).toContain('code_change');
  });

  it('planner generates the four-stage pipeline lifecycle for reusable pipeline goals', async () => {
    const planner = new StrategicPlanner(
      {} as any,
      { query: () => [] } as any,
      {} as any,
      'anthropic',
      'test-model',
      'system',
    );
    const goal: Goal = {
      id: 'g2',
      objective: 'Create a pipeline that summarizes RSS feeds and posts a daily briefing',
      successCriteria: [],
      constraints: [],
      forbiddenActions: [],
      priority: 'normal',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const plans = await planner.generatePlans(goal);
    const best = planner.selectBest(plans);
    const preferredSkills = best.taskGraph.nodes.map(node => node.preferredSkill);

    expect(best.taskGraph.nodes).toHaveLength(4);
    expect(preferredSkills).toEqual([
      'pipeline_design',
      'pipeline_generate',
      'pipeline_validate_and_repair',
      'pipeline_verify',
    ]);
  });
});