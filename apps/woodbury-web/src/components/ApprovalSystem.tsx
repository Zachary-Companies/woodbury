'use client'

import { ToolCall, RiskLevel } from '@/types'

/**
 * Risk assessment system for tool operations
 * Categorizes tools by risk level and determines approval requirements
 */
export class ApprovalSystem {
  private static readonly RISK_CATEGORIES = {
    // Safe operations - no approval needed
    safe: [
      'file_read',
      'list_directory', 
      'file_search',
      'grep',
      'git_status',
      'git_log',
      'git_show',
      'web_fetch',
      'web_crawl',
      'duckduckgo_search',
      'api_search',
      'memory_recall'
    ],
    
    // Medium risk - approval recommended
    medium: [
      'file_write',
      'git_add',
      'git_commit',
      'test_run',
      'code_execute',
      'database_query',
      'memory_save'
    ],
    
    // High risk - approval required
    high: [
      'shell_execute',
      'git_push',
      'git_merge',
      'git_rebase',
      'file_delete',
      'directory_delete'
    ],
    
    // Critical risk - strong approval required with review
    critical: [
      'git_reset_hard',
      'git_force_push',
      'system_shutdown',
      'rm_rf',
      'format_disk',
      'drop_database'
    ]
  }
  
  /**
   * Assess the risk level of a tool call
   */
  static assessRisk(toolName: string, args: Record<string, any>): RiskLevel {
    // Check direct tool categorization
    for (const [level, tools] of Object.entries(this.RISK_CATEGORIES)) {
      if (tools.includes(toolName)) {
        return level as RiskLevel
      }
    }
    
    // Context-based risk assessment
    return this.assessContextualRisk(toolName, args)
  }
  
  /**
   * Perform contextual risk assessment based on arguments
   */
  private static assessContextualRisk(toolName: string, args: Record<string, any>): RiskLevel {
    // Shell execute with dangerous commands
    if (toolName === 'shell_execute') {
      const command = args.command?.toLowerCase() || ''
      
      if (command.includes('rm -rf') || command.includes('del /s') || command.includes('format')) {
        return 'critical'
      }
      if (command.includes('sudo') || command.includes('chmod 777') || command.includes('install')) {
        return 'high'
      }
      if (command.includes('git push') || command.includes('npm publish')) {
        return 'high'
      }
      return 'medium'
    }
    
    // File operations on critical paths
    if (toolName === 'file_write') {
      const path = args.path?.toLowerCase() || ''
      
      if (path.includes('package.json') || path.includes('.env') || path.includes('config')) {
        return 'medium'
      }
      if (path.includes('system') || path.includes('/etc/') || path.includes('windows/system32')) {
        return 'critical'
      }
    }
    
    // Git operations with force
    if (toolName.startsWith('git_')) {
      const force = args.force || args['--force'] || false
      if (force) {
        return 'critical'
      }
    }
    
    // Database operations on production
    if (toolName === 'database_query') {
      const query = args.query?.toLowerCase() || ''
      const isProduction = args.connectionString?.includes('prod') || false
      
      if (isProduction && (query.includes('drop') || query.includes('delete') || query.includes('truncate'))) {
        return 'critical'
      }
      if (query.includes('delete') || query.includes('update') || query.includes('insert')) {
        return 'medium'
      }
    }
    
    // Default to safe if unknown
    return 'safe'
  }
  
  /**
   * Check if a tool call requires approval
   */
  static requiresApproval(toolName: string, args: Record<string, any>): boolean {
    const riskLevel = this.assessRisk(toolName, args)
    return riskLevel !== 'safe'
  }
  
  /**
   * Generate human-readable risk assessment
   */
  static generateRiskAssessment(toolCall: ToolCall): string {
    const { name, args, riskLevel } = toolCall
    
    const baseAssessments = {
      safe: 'This is a read-only operation with minimal risk to system state.',
      medium: 'This operation will modify files or data. Review the changes carefully.',
      high: 'This operation may significantly impact system configuration or data. Ensure this action is necessary and the parameters are correct.',
      critical: 'This operation could cause irreversible damage or system-wide changes. Only approve if absolutely necessary and you understand the full implications.'
    }
    
    let assessment = baseAssessments[riskLevel]
    
    // Add tool-specific context
    if (name === 'shell_execute') {
      assessment += ` The command "${args.command}" will be executed in the system shell.`
    } else if (name === 'file_write') {
      assessment += ` The file "${args.path}" will be modified or created.`
    } else if (name.startsWith('git_')) {
      assessment += ` This will perform a Git operation: ${name.replace('git_', '')}.`
    } else if (name === 'database_query') {
      assessment += ` This will execute a database query against the specified connection.`
    }
    
    return assessment
  }
  
  /**
   * Generate preview data for tool operations
   */
  static generatePreview(toolCall: ToolCall): any {
    const { name, args } = toolCall
    
    if (name === 'file_write') {
      return {
        type: 'file_operation',
        operation: 'write',
        target: args.path,
        preview: args.content ? args.content.substring(0, 500) + (args.content.length > 500 ? '...' : '') : '[No content preview]'
      }
    }
    
    if (name === 'shell_execute') {
      return {
        type: 'shell_command',
        command: args.command,
        workingDirectory: args.cwd || process.cwd(),
        environment: 'Current shell environment'
      }
    }
    
    if (name === 'database_query') {
      return {
        type: 'database_operation',
        query: args.query,
        connection: args.connectionString ? '[REDACTED]' : 'Default connection',
        estimatedRows: 'Unknown'
      }
    }
    
    if (name.startsWith('git_')) {
      return {
        type: 'git_operation',
        operation: name.replace('git_', ''),
        repository: process.cwd(),
        arguments: Object.keys(args).filter(key => key !== 'subcommand').join(', ') || 'None'
      }
    }
    
    return {
      type: 'generic_operation',
      tool: name,
      arguments: JSON.stringify(args, null, 2)
    }
  }
}

export default ApprovalSystem
