import { ApprovalSystem } from '@/components/ApprovalSystem'
import { ToolCall } from '@/types'

describe('ApprovalSystem', () => {
  describe('assessRisk', () => {
    it('categorizes safe tools correctly', () => {
      expect(ApprovalSystem.assessRisk('file_read', {})).toBe('safe')
      expect(ApprovalSystem.assessRisk('list_directory', {})).toBe('safe')
      expect(ApprovalSystem.assessRisk('grep', {})).toBe('safe')
      expect(ApprovalSystem.assessRisk('web_fetch', {})).toBe('safe')
    })

    it('categorizes medium risk tools correctly', () => {
      expect(ApprovalSystem.assessRisk('file_write', {})).toBe('medium')
      expect(ApprovalSystem.assessRisk('git_commit', {})).toBe('medium')
      expect(ApprovalSystem.assessRisk('test_run', {})).toBe('medium')
    })

    it('categorizes high risk tools correctly', () => {
      expect(ApprovalSystem.assessRisk('shell_execute', {})).toBe('high')
      expect(ApprovalSystem.assessRisk('git_push', {})).toBe('high')
      expect(ApprovalSystem.assessRisk('git_merge', {})).toBe('high')
    })

    it('categorizes critical risk tools correctly', () => {
      expect(ApprovalSystem.assessRisk('git_force_push', {})).toBe('critical')
      expect(ApprovalSystem.assessRisk('drop_database', {})).toBe('critical')
      expect(ApprovalSystem.assessRisk('rm_rf', {})).toBe('critical')
    })

    it('performs contextual risk assessment for shell_execute', () => {
      expect(ApprovalSystem.assessRisk('shell_execute', { command: 'ls -la' })).toBe('medium')
      expect(ApprovalSystem.assessRisk('shell_execute', { command: 'sudo apt install' })).toBe('high')
      expect(ApprovalSystem.assessRisk('shell_execute', { command: 'rm -rf /' })).toBe('critical')
      expect(ApprovalSystem.assessRisk('shell_execute', { command: 'git push origin main' })).toBe('high')
    })

    it('performs contextual risk assessment for file_write', () => {
      expect(ApprovalSystem.assessRisk('file_write', { path: 'test.txt' })).toBe('medium')
      expect(ApprovalSystem.assessRisk('file_write', { path: 'package.json' })).toBe('medium')
      expect(ApprovalSystem.assessRisk('file_write', { path: '/etc/passwd' })).toBe('critical')
      expect(ApprovalSystem.assessRisk('file_write', { path: 'C:\\Windows\\System32\\config' })).toBe('critical')
    })

    it('performs contextual risk assessment for database_query', () => {
      expect(ApprovalSystem.assessRisk('database_query', { query: 'SELECT * FROM users' })).toBe('safe')
      expect(ApprovalSystem.assessRisk('database_query', { query: 'UPDATE users SET active = 1' })).toBe('medium')
      expect(ApprovalSystem.assessRisk('database_query', { 
        query: 'DROP TABLE users', 
        connectionString: 'prod-db-connection' 
      })).toBe('critical')
    })

    it('returns safe for unknown tools', () => {
      expect(ApprovalSystem.assessRisk('unknown_tool', {})).toBe('safe')
    })
  })

  describe('requiresApproval', () => {
    it('returns false for safe tools', () => {
      expect(ApprovalSystem.requiresApproval('file_read', {})).toBe(false)
    })

    it('returns true for non-safe tools', () => {
      expect(ApprovalSystem.requiresApproval('file_write', {})).toBe(true)
      expect(ApprovalSystem.requiresApproval('shell_execute', {})).toBe(true)
      expect(ApprovalSystem.requiresApproval('git_force_push', {})).toBe(true)
    })
  })

  describe('generateRiskAssessment', () => {
    it('generates appropriate assessment for different risk levels', () => {
      const safeToolCall: ToolCall = {
        name: 'file_read',
        args: { path: 'test.txt' },
        riskLevel: 'safe',
        requiresApproval: false
      }

      const criticalToolCall: ToolCall = {
        name: 'shell_execute',
        args: { command: 'rm -rf /' },
        riskLevel: 'critical',
        requiresApproval: true
      }

      const safeAssessment = ApprovalSystem.generateRiskAssessment(safeToolCall)
      const criticalAssessment = ApprovalSystem.generateRiskAssessment(criticalToolCall)

      expect(safeAssessment).toContain('minimal risk')
      expect(criticalAssessment).toContain('irreversible damage')
      expect(criticalAssessment).toContain('rm -rf /')
    })

    it('includes tool-specific context', () => {
      const fileWriteCall: ToolCall = {
        name: 'file_write',
        args: { path: 'config.json', content: '{}' },
        riskLevel: 'medium',
        requiresApproval: true
      }

      const assessment = ApprovalSystem.generateRiskAssessment(fileWriteCall)
      expect(assessment).toContain('config.json')
      expect(assessment).toContain('modified or created')
    })
  })

  describe('generatePreview', () => {
    it('generates appropriate preview for file_write operations', () => {
      const toolCall: ToolCall = {
        name: 'file_write',
        args: { path: 'test.txt', content: 'Hello, World!' },
        riskLevel: 'medium',
        requiresApproval: true
      }

      const preview = ApprovalSystem.generatePreview(toolCall)
      
      expect(preview.type).toBe('file_operation')
      expect(preview.operation).toBe('write')
      expect(preview.target).toBe('test.txt')
      expect(preview.preview).toBe('Hello, World!')
    })

    it('generates appropriate preview for shell_execute operations', () => {
      const toolCall: ToolCall = {
        name: 'shell_execute',
        args: { command: 'ls -la', cwd: '/tmp' },
        riskLevel: 'high',
        requiresApproval: true
      }

      const preview = ApprovalSystem.generatePreview(toolCall)
      
      expect(preview.type).toBe('shell_command')
      expect(preview.command).toBe('ls -la')
      expect(preview.workingDirectory).toBe('/tmp')
    })

    it('truncates long content in previews', () => {
      const longContent = 'x'.repeat(1000)
      const toolCall: ToolCall = {
        name: 'file_write',
        args: { path: 'big.txt', content: longContent },
        riskLevel: 'medium',
        requiresApproval: true
      }

      const preview = ApprovalSystem.generatePreview(toolCall)
      
      expect(preview.preview).toHaveLength(503) // 500 chars + '...'
      expect(preview.preview.endsWith('...')).toBe(true)
    })

    it('handles generic operations', () => {
      const toolCall: ToolCall = {
        name: 'custom_tool',
        args: { param: 'value' },
        riskLevel: 'medium',
        requiresApproval: true
      }

      const preview = ApprovalSystem.generatePreview(toolCall)
      
      expect(preview.type).toBe('generic_operation')
      expect(preview.tool).toBe('custom_tool')
      expect(preview.arguments).toContain('"param": "value"')
    })
  })
})
