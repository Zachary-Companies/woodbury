'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import Timeline from './Timeline'
import ApprovalGate from './ApprovalGate'
import { REPLState, ConversationMessage, TimelineEvent, ApprovalRequest } from '@/types'

const initialState: REPLState = {
  conversation: [],
  timeline: [],
  workingSet: [],
  context: {
    variables: {},
    constraints: [],
    goals: [],
    budget: {},
    permissions: {
      allowedTools: [],
      blockedTools: [],
      requireApproval: []
    }
  },
  isRunning: false
}

export default function REPL() {
  const [state, setState] = useState<REPLState>(initialState)
  const [input, setInput] = useState('')
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  // WebSocket connection for real-time updates
  useEffect(() => {
    // In a real implementation, this would connect to the WebSocket server
    // wsRef.current = new WebSocket('ws://localhost:8080/repl')
    // Handle WebSocket messages, update state, etc.
    return () => {
      wsRef.current?.close()
    }
  }, [])

  const sendMessage = useCallback((content: string) => {
    const message: ConversationMessage = {
      id: `msg-${Date.now()}`,
      type: 'user',
      content,
      timestamp: new Date()
    }
    
    setState(prev => ({
      ...prev,
      conversation: [...prev.conversation, message],
      isRunning: true
    }))

    // In real implementation, send to WebSocket server
    // wsRef.current?.send(JSON.stringify({ type: 'user_input', data: content }))
    
    // Mock response for demo
    setTimeout(() => {
      const response: ConversationMessage = {
        id: `msg-${Date.now()}`,
        type: 'assistant',
        content: `Processing: ${content}`,
        timestamp: new Date()
      }
      
      setState(prev => ({
        ...prev,
        conversation: [...prev.conversation, response],
        isRunning: false
      }))
    }, 1000)
  }, [])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (input.trim() && !state.isRunning) {
      sendMessage(input.trim())
      setInput('')
    }
  }

  const handleApproval = useCallback((approved: boolean, reason?: string) => {
    if (pendingApproval) {
      // Handle approval/rejection
      console.log(`Approval ${approved ? 'granted' : 'denied'}:`, pendingApproval.id, reason)
      setPendingApproval(null)
    }
  }, [pendingApproval])

  return (
    <div className="flex h-full bg-background">
      {/* Left Pane - Conversation */}
      <div className="w-1/3 border-r border-border flex flex-col">
        <div className="p-4 border-b border-border">
          <h2 className="text-lg font-semibold">Conversation</h2>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {state.conversation.map((msg) => (
            <div key={msg.id} className={`p-3 rounded-lg ${
              msg.type === 'user' 
                ? 'bg-primary text-primary-foreground ml-8' 
                : 'bg-muted text-muted-foreground mr-8'
            }`}>
              <div className="text-sm opacity-75 mb-1">
                {msg.type} • {msg.timestamp.toLocaleTimeString()}
              </div>
              <div className="whitespace-pre-wrap">{msg.content}</div>
            </div>
          ))}
        </div>
        
        <form onSubmit={handleSubmit} className="p-4 border-t border-border">
          <div className="flex space-x-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Enter your request..."
              className="flex-1 px-3 py-2 border border-input rounded-md bg-background"
              disabled={state.isRunning}
            />
            <button
              type="submit"
              disabled={state.isRunning || !input.trim()}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md disabled:opacity-50"
            >
              {state.isRunning ? 'Running...' : 'Send'}
            </button>
          </div>
        </form>
      </div>

      {/* Center Pane - Timeline */}
      <div className="w-1/3 border-r border-border">
        <Timeline events={state.timeline} />
      </div>

      {/* Right Pane - State Inspector */}
      <div className="w-1/3 flex flex-col">
        <div className="p-4 border-b border-border">
          <h2 className="text-lg font-semibold">State Inspector</h2>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Working Set */}
          <div>
            <h3 className="font-medium mb-2">Working Set</h3>
            <div className="bg-muted rounded-lg p-3 text-sm">
              {state.workingSet.length > 0 ? (
                state.workingSet.map((item) => (
                  <div key={item.id} className="flex items-center space-x-2 mb-1">
                    <span className="text-muted-foreground">{item.type}:</span>
                    <span>{item.name}</span>
                  </div>
                ))
              ) : (
                <div className="text-muted-foreground">No items in working set</div>
              )}
            </div>
          </div>

          {/* Context */}
          <div>
            <h3 className="font-medium mb-2">Context</h3>
            <div className="bg-muted rounded-lg p-3 text-sm space-y-2">
              <div>
                <span className="text-muted-foreground">Goals:</span>
                <div className="ml-2">
                  {state.context.goals.length > 0 ? (
                    state.context.goals.map((goal, i) => (
                      <div key={i}>• {goal}</div>
                    ))
                  ) : (
                    <div className="text-muted-foreground">No active goals</div>
                  )}
                </div>
              </div>
              
              <div>
                <span className="text-muted-foreground">Budget:</span>
                <div className="ml-2">
                  {state.context.budget.toolCalls !== undefined && (
                    <div>Tool calls: {state.context.budget.toolCalls} / {state.context.budget.maxToolCalls || '∞'}</div>
                  )}
                  {state.context.budget.tokens !== undefined && (
                    <div>Tokens: {state.context.budget.tokens} / {state.context.budget.maxTokens || '∞'}</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Approval Gate Modal */}
      {pendingApproval && (
        <ApprovalGate
          request={pendingApproval}
          onApprove={(reason) => handleApproval(true, reason)}
          onReject={(reason) => handleApproval(false, reason)}
        />
      )}
    </div>
  )
}
