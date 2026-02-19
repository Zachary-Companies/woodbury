// Core REPL types
export interface REPLState {
  conversation: ConversationMessage[]
  timeline: TimelineEvent[]
  workingSet: WorkingSetItem[]
  context: ContextData
  currentGoal?: string
  isRunning: boolean
}

export interface ConversationMessage {
  id: string
  type: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
  metadata?: Record<string, any>
}

export interface TimelineEvent {
  id: string
  type: 'thought' | 'tool_call' | 'tool_result' | 'approval_request' | 'state_change'
  timestamp: Date
  data: any
  expanded?: boolean
  status?: 'pending' | 'approved' | 'rejected' | 'completed' | 'failed'
}

export interface ToolCall {
  name: string
  args: Record<string, any>
  riskLevel: RiskLevel
  requiresApproval: boolean
}

export interface ToolResult {
  success: boolean
  data: any
  error?: string
  metadata?: Record<string, any>
}

export type RiskLevel = 'safe' | 'medium' | 'high' | 'critical'

export interface ApprovalRequest {
  id: string
  toolCall: ToolCall
  justification: string
  riskAssessment: string
  previewData?: any
}

export interface WorkingSetItem {
  id: string
  type: 'file' | 'url' | 'note' | 'variable'
  name: string
  path?: string
  content?: string
  metadata?: Record<string, any>
}

export interface ContextData {
  variables: Record<string, any>
  constraints: string[]
  goals: string[]
  budget: {
    tokens?: number
    maxTokens?: number
    cost?: number
    maxCost?: number
    toolCalls?: number
    maxToolCalls?: number
  }
  permissions: {
    allowedTools: string[]
    blockedTools: string[]
    requireApproval: string[]
  }
}

// WebSocket message types
export interface WebSocketMessage {
  type: 'timeline_event' | 'approval_request' | 'state_update' | 'run_complete'
  data: any
  timestamp: Date
}

// Run export/import types
export interface RunBundle {
  id: string
  timeline: TimelineEvent[]
  conversation: ConversationMessage[]
  finalState: REPLState
  metadata: {
    startTime: Date
    endTime: Date
    model: string
    version: string
    totalTokens?: number
    totalCost?: number
  }
  artifacts: RunArtifact[]
}

export interface RunArtifact {
  type: 'file' | 'diff' | 'output'
  name: string
  content: string
  metadata?: Record<string, any>
}
