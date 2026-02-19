import { WebSocket, WebSocketServer } from 'ws'
import { TimelineEvent, ApprovalRequest, REPLState, ToolCall, RiskLevel } from '@/types'

/**
 * WebSocket agent that extends the existing woodbury agent system
 * Provides real-time communication between the web UI and agent execution
 */
export class WebSocketAgent {
  private wss: WebSocketServer
  private clients: Set<WebSocket> = new Set()
  private currentState: REPLState
  private pendingApprovals: Map<string, ApprovalRequest> = new Map()
  
  constructor(port: number = 8080) {
    this.wss = new WebSocketServer({ port })
    this.currentState = this.getInitialState()
    this.setupWebSocketServer()
  }
  
  private getInitialState(): REPLState {
    return {
      conversation: [],
      timeline: [],
      workingSet: [],
      context: {
        variables: {},
        constraints: [],
        goals: [],
        budget: {
          toolCalls: 0,
          maxToolCalls: 100
        },
        permissions: {
          allowedTools: [],
          blockedTools: [],
          requireApproval: ['shell_execute', 'file_write', 'git']
        }
      },
      isRunning: false
    }
  }
  
  private setupWebSocketServer() {
    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws)
      console.log('Client connected')
      
      // Send current state to new client
      this.sendToClient(ws, {
        type: 'state_update',
        data: this.currentState,
        timestamp: new Date()
      })
      
      ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString())
          this.handleClientMessage(ws, message)
        } catch (error) {
          console.error('Invalid message from client:', error)
        }
      })
      
      ws.on('close', () => {
        this.clients.delete(ws)
        console.log('Client disconnected')
      })
    })
    
    console.log(`WebSocket server listening on port 8080`)
  }
  
  private handleClientMessage(ws: WebSocket, message: any) {
    switch (message.type) {
      case 'user_input':
        this.handleUserInput(message.data)
        break
        
      case 'approval_response':
        this.handleApprovalResponse(message.data)
        break
        
      case 'export_run':
        this.handleExportRun(ws)
        break
        
      case 'import_run':
        this.handleImportRun(message.data)
        break
        
      default:
        console.warn('Unknown message type:', message.type)
    }
  }
  
  private async handleUserInput(input: string) {
    // Add user message to conversation
    this.addConversationMessage({
      id: `msg-${Date.now()}`,
      type: 'user',
      content: input,
      timestamp: new Date()
    })
    
    this.updateState({ isRunning: true })
    
    // Process the input (this would integrate with existing woodbury agent)
    try {
      await this.processUserRequest(input)
    } catch (error) {
      console.error('Error processing user request:', error)
      this.addTimelineEvent({
        id: `error-${Date.now()}`,
        type: 'tool_result',
        timestamp: new Date(),
        data: {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        },
        status: 'failed'
      })
    } finally {
      this.updateState({ isRunning: false })
    }
  }
  
  private async processUserRequest(input: string) {
    // This is a mock implementation - in reality this would integrate
    // with the existing woodbury agent system
    
    // Add thinking event
    this.addTimelineEvent({
      id: `thought-${Date.now()}`,
      type: 'thought',
      timestamp: new Date(),
      data: {
        content: `Processing request: "${input}"`
      }
    })
    
    // Simulate tool execution
    await this.simulateToolExecution(input)
    
    // Add response
    this.addConversationMessage({
      id: `msg-${Date.now()}`,
      type: 'assistant',
      content: `I've processed your request: "${input}"`,
      timestamp: new Date()
    })
  }
  
  private async simulateToolExecution(input: string) {
    // Determine what tool to "execute" based on input
    let toolName = 'file_read'
    let riskLevel: RiskLevel = 'safe'
    
    if (input.toLowerCase().includes('write') || input.toLowerCase().includes('create')) {
      toolName = 'file_write'
      riskLevel = 'medium'
    } else if (input.toLowerCase().includes('delete') || input.toLowerCase().includes('remove')) {
      toolName = 'shell_execute'
      riskLevel = 'high'
    } else if (input.toLowerCase().includes('install') || input.toLowerCase().includes('deploy')) {
      toolName = 'shell_execute'
      riskLevel = 'critical'
    }
    
    const toolCall: ToolCall = {
      name: toolName,
      args: { target: input },
      riskLevel,
      requiresApproval: riskLevel !== 'safe'
    }
    
    // Add tool call event
    const toolCallEvent: TimelineEvent = {
      id: `tool-${Date.now()}`,
      type: 'tool_call',
      timestamp: new Date(),
      data: toolCall,
      status: toolCall.requiresApproval ? 'pending' : 'completed'
    }
    
    this.addTimelineEvent(toolCallEvent)
    
    if (toolCall.requiresApproval) {
      // Create approval request
      const approvalRequest: ApprovalRequest = {
        id: toolCallEvent.id,
        toolCall,
        justification: `This tool is needed to process the user's request: "${input}"`,
        riskAssessment: this.generateRiskAssessment(toolCall),
        previewData: this.generatePreviewData(toolCall)
      }
      
      this.pendingApprovals.set(approvalRequest.id, approvalRequest)
      
      // Send approval request to clients
      this.broadcastToClients({
        type: 'approval_request',
        data: approvalRequest,
        timestamp: new Date()
      })
      
      // Wait for approval (in real implementation)
      // For demo, we'll just wait a bit and auto-approve
      await new Promise(resolve => setTimeout(resolve, 2000))
      
      if (this.pendingApprovals.has(approvalRequest.id)) {
        // Auto-approve for demo
        await this.executeApprovedTool(approvalRequest)
      }
    } else {
      // Execute immediately
      await this.executeTool(toolCall)
    }
  }
  
  private generateRiskAssessment(toolCall: ToolCall): string {
    switch (toolCall.riskLevel) {
      case 'critical':
        return 'This operation could significantly impact system state or data. Review carefully before approving.'
      case 'high':
        return 'This operation may modify important files or system configuration. Ensure this is intended.'
      case 'medium':
        return 'This operation will modify files or data. Verify the target and content are correct.'
      default:
        return 'This is a read-only operation with minimal risk.'
    }
  }
  
  private generatePreviewData(toolCall: ToolCall): any {
    if (toolCall.name === 'file_write') {
      return {
        type: 'diff',
        lines: [
          { number: 1, type: 'context', content: 'existing content...' },
          { number: 2, type: 'remove', content: '- old line' },
          { number: 3, type: 'add', content: '+ new line' },
          { number: 4, type: 'context', content: 'more content...' }
        ]
      }
    }
    
    return `Preview of ${toolCall.name} operation with args: ${JSON.stringify(toolCall.args)}`
  }
  
  private handleApprovalResponse(data: any) {
    const { requestId, approved, reason } = data
    const request = this.pendingApprovals.get(requestId)
    
    if (!request) {
      console.warn('Approval response for unknown request:', requestId)
      return
    }
    
    this.pendingApprovals.delete(requestId)
    
    // Update timeline event
    const event = this.currentState.timeline.find(e => e.id === requestId)
    if (event) {
      event.status = approved ? 'approved' : 'rejected'
    }
    
    if (approved) {
      this.executeApprovedTool(request)
    } else {
      // Add rejection event
      this.addTimelineEvent({
        id: `reject-${Date.now()}`,
        type: 'tool_result',
        timestamp: new Date(),
        data: {
          success: false,
          error: `Operation rejected: ${reason || 'No reason provided'}`
        },
        status: 'rejected'
      })
    }
    
    this.broadcastStateUpdate()
  }
  
  private async executeApprovedTool(request: ApprovalRequest) {
    await this.executeTool(request.toolCall)
  }
  
  private async executeTool(toolCall: ToolCall) {
    // Simulate tool execution
    await new Promise(resolve => setTimeout(resolve, 1000))
    
    // Add result event
    this.addTimelineEvent({
      id: `result-${Date.now()}`,
      type: 'tool_result',
      timestamp: new Date(),
      data: {
        success: true,
        data: `Result of ${toolCall.name} operation`,
        metadata: { tool: toolCall.name }
      },
      status: 'completed'
    })
    
    // Update budget
    this.updateState({
      context: {
        ...this.currentState.context,
        budget: {
          ...this.currentState.context.budget,
          toolCalls: (this.currentState.context.budget.toolCalls || 0) + 1
        }
      }
    })
  }
  
  private handleExportRun(ws: WebSocket) {
    const runBundle = {
      id: `run-${Date.now()}`,
      timeline: this.currentState.timeline,
      conversation: this.currentState.conversation,
      finalState: this.currentState,
      metadata: {
        startTime: new Date(Date.now() - 3600000), // 1 hour ago
        endTime: new Date(),
        model: 'woodbury-agent',
        version: '1.0.0',
        totalTokens: 1500,
        totalCost: 0.05
      },
      artifacts: []
    }
    
    this.sendToClient(ws, {
      type: 'run_bundle',
      data: runBundle,
      timestamp: new Date()
    })
  }
  
  private handleImportRun(runBundle: any) {
    // Import a previous run
    this.currentState = {
      ...runBundle.finalState,
      isRunning: false
    }
    
    this.broadcastStateUpdate()
  }
  
  private addConversationMessage(message: any) {
    this.currentState.conversation.push(message)
    this.broadcastStateUpdate()
  }
  
  private addTimelineEvent(event: TimelineEvent) {
    this.currentState.timeline.push(event)
    this.broadcastToClients({
      type: 'timeline_event',
      data: event,
      timestamp: new Date()
    })
  }
  
  private updateState(updates: Partial<REPLState>) {
    this.currentState = { ...this.currentState, ...updates }
    this.broadcastStateUpdate()
  }
  
  private broadcastStateUpdate() {
    this.broadcastToClients({
      type: 'state_update',
      data: this.currentState,
      timestamp: new Date()
    })
  }
  
  private broadcastToClients(message: any) {
    const messageStr = JSON.stringify(message)
    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageStr)
      }
    })
  }
  
  private sendToClient(client: WebSocket, message: any) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message))
    }
  }
  
  public close() {
    this.wss.close()
  }
}

// Export for standalone usage
if (require.main === module) {
  const agent = new WebSocketAgent()
  console.log('WebSocket Agent started')
  
  process.on('SIGINT', () => {
    console.log('Shutting down WebSocket Agent')
    agent.close()
    process.exit(0)
  })
}
