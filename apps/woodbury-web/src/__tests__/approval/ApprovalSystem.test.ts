/**
 * Approval System Tests
 * Tests the risk-based approval gates for dangerous tool operations
 */

import { ApprovalSystem, ToolRiskAssessment } from '@/components/ApprovalSystem';
import { RiskLevel, ToolCallEvent } from '@/types';

// Mock tool configurations based on woodbury's existing tools
const TOOL_RISK_CONFIG = {
  // Safe tools (auto-execute)
  file_read: 'safe',
  list_directory: 'safe',
  grep: 'safe',
  git: 'safe', // Only for read operations like status, log, diff
  web_fetch: 'safe', // GET requests
  
  // Medium risk (show diff/preview)
  file_write: 'medium',
  code_execute: 'medium', // Read-only execution
  test_run: 'medium',
  
  // High risk (require approval)  
  shell_execute: 'high',
  database_query: 'high', // Write operations
  web_crawl: 'high',
  
  // Critical risk (explicit confirmation)
  git_push: 'critical',
  git_force_push: 'critical',
  file_delete: 'critical',
  database_drop: 'critical'
} as Record<string, RiskLevel>;

describe('ApprovalSystem', () => {
  let approvalSystem: ApprovalSystem;
  
  beforeEach(() => {
    approvalSystem = new ApprovalSystem(TOOL_RISK_CONFIG);
  });
  
  it('should assess tool risk levels correctly', () => {
    expect(approvalSystem.assessRisk('file_read', {})).toBe('safe');
    expect(approvalSystem.assessRisk('file_write', {})).toBe('medium');
    expect(approvalSystem.assessRisk('shell_execute', {})).toBe('high');
    expect(approvalSystem.assessRisk('git_push', {})).toBe('critical');
  });
  
  it('should auto-approve safe tools', async () => {
    const toolCall: ToolCallEvent = {
      id: 'tool-1',
      tool: 'file_read',
      status: 'pending',
      args: { path: 'README.md' },
      riskLevel: 'safe',
      timestamp: Date.now()
    };
    
    const result = await approvalSystem.requestApproval(toolCall);
    
    expect(result.approved).toBe(true);
    expect(result.autoApproved).toBe(true);
    expect(result.reason).toContain('safe');
  });
  
  it('should require approval for high risk tools', async () => {
    const toolCall: ToolCallEvent = {
      id: 'tool-2',
      tool: 'shell_execute',
      status: 'pending',
      args: { command: 'rm -rf /' },
      riskLevel: 'high',
      timestamp: Date.now()
    };
    
    const approvalPromise = approvalSystem.requestApproval(toolCall);
    
    // Should be pending approval
    expect(approvalSystem.getPendingApprovals()).toContain('tool-2');
    
    // Simulate user approval
    approvalSystem.approve('tool-2');
    
    const result = await approvalPromise;
    expect(result.approved).toBe(true);
    expect(result.autoApproved).toBe(false);
  });
  
  it('should handle tool rejection', async () => {
    const toolCall: ToolCallEvent = {
      id: 'tool-3',
      tool: 'database_query',
      status: 'pending',
      args: { query: 'DROP TABLE users' },
      riskLevel: 'high',
      timestamp: Date.now()
    };
    
    const approvalPromise = approvalSystem.requestApproval(toolCall);
    
    // Simulate user rejection
    approvalSystem.reject('tool-3', 'Too dangerous');
    
    const result = await approvalPromise;
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('Too dangerous');
  });
  
  it('should show diff preview for file operations', () => {
    const toolCall: ToolCallEvent = {
      id: 'tool-4',
      tool: 'file_write',
      status: 'pending',
      args: {
        path: 'src/test.ts',
        content: 'console.log("Hello World");'
      },
      riskLevel: 'medium',
      timestamp: Date.now()
    };
    
    const preview = approvalSystem.generatePreview(toolCall);
    
    expect(preview.type).toBe('diff');
    expect(preview.data).toContain('src/test.ts');
    expect(preview.data).toContain('console.log');
  });
  
  it('should format shell command preview safely', () => {
    const toolCall: ToolCallEvent = {
      id: 'tool-5', 
      tool: 'shell_execute',
      status: 'pending',
      args: {
        command: 'npm install express',
        cwd: '/project'
      },
      riskLevel: 'high',
      timestamp: Date.now()
    };
    
    const preview = approvalSystem.generatePreview(toolCall);
    
    expect(preview.type).toBe('command');
    expect(preview.data).toContain('npm install express');
    expect(preview.data).toContain('/project');
  });
  
  it('should assess git operations with context', () => {
    // Safe git operations
    expect(approvalSystem.assessRisk('git', { subcommand: 'status' })).toBe('safe');
    expect(approvalSystem.assessRisk('git', { subcommand: 'log' })).toBe('safe');
    expect(approvalSystem.assessRisk('git', { subcommand: 'diff' })).toBe('safe');
    
    // Dangerous git operations
    expect(approvalSystem.assessRisk('git', { subcommand: 'push' })).toBe('high');
    expect(approvalSystem.assessRisk('git', { subcommand: 'push', args: ['--force'] })).toBe('critical');
    expect(approvalSystem.assessRisk('git', { subcommand: 'reset', args: ['--hard'] })).toBe('high');
  });
  
  it('should handle database operations by query type', () => {
    // Safe database operations
    expect(approvalSystem.assessRisk('database_query', { query: 'SELECT * FROM users' })).toBe('safe');
    
    // Dangerous database operations
    expect(approvalSystem.assessRisk('database_query', { query: 'UPDATE users SET password = null' })).toBe('high');
    expect(approvalSystem.assessRisk('database_query', { query: 'DROP TABLE users' })).toBe('critical');
    expect(approvalSystem.assessRisk('database_query', { query: 'DELETE FROM users' })).toBe('high');
  });
  
  it('should provide context-aware risk explanations', () => {
    const assessment = approvalSystem.assessWithExplanation('shell_execute', {
      command: 'sudo rm -rf /system'
    });
    
    expect(assessment.riskLevel).toBe('critical');
    expect(assessment.explanation).toContain('destructive');
    expect(assessment.explanation).toContain('sudo');
    expect(assessment.recommendations).toContain('backup');
  });
  
  it('should track approval history', () => {
    const toolCall: ToolCallEvent = {
      id: 'tool-6',
      tool: 'file_write',
      status: 'pending',
      args: { path: 'test.txt', content: 'test' },
      riskLevel: 'medium',
      timestamp: Date.now()
    };
    
    approvalSystem.approve('tool-6');
    
    const history = approvalSystem.getApprovalHistory();
    expect(history).toHaveLength(1);
    expect(history[0].toolCallId).toBe('tool-6');
    expect(history[0].approved).toBe(true);
  });
  
  it('should timeout pending approvals', async () => {
    const toolCall: ToolCallEvent = {
      id: 'tool-7',
      tool: 'shell_execute',
      status: 'pending',
      args: { command: 'sleep 10' },
      riskLevel: 'high',
      timestamp: Date.now()
    };
    
    // Set short timeout for test
    approvalSystem.setApprovalTimeout(100); // 100ms
    
    const result = await approvalSystem.requestApproval(toolCall);
    
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('timeout');
  }, 1000);
});

// Integration test with real woodbury preflight_check system
describe('Integration with existing preflight_check', () => {
  it('should integrate with woodbury risk assessment', () => {
    // Test that approval system works with existing preflight_check tool
    const mockPreflightResult = {
      riskLevel: 'high' as RiskLevel,
      justification: 'File deletion operation',
      action: 'Delete important configuration file'
    };
    
    const approvalSystem = new ApprovalSystem(TOOL_RISK_CONFIG);
    const assessment = approvalSystem.integratePreflightCheck(mockPreflightResult);
    
    expect(assessment.requiresApproval).toBe(true);
    expect(assessment.riskLevel).toBe('high');
    expect(assessment.explanation).toContain('File deletion operation');
  });
});
