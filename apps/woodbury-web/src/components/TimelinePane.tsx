'use client'

import { TimelineEvent, ToolCallEvent } from '@/types'
import { Clock, ChevronDown, ChevronRight, Play, X, CheckCircle, AlertCircle } from 'lucide-react'
import { useState } from 'react'

interface TimelinePaneProps {
  timeline: TimelineEvent[]
  pendingApprovals: ToolCallEvent[]
  onApprove: (toolCallId: string) => void
  onReject: (toolCallId: string) => void
  onRerun: (toolCallId: string) => void
}

export function TimelinePane({ timeline, pendingApprovals, onApprove, onReject, onRerun }: TimelinePaneProps) {
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set())

  const toggleExpanded = (eventId: string) => {
    const newExpanded = new Set(expandedEvents)
    if (newExpanded.has(eventId)) {
      newExpanded.delete(eventId)
    } else {
      newExpanded.add(eventId)
    }
    setExpandedEvents(newExpanded)
  }

  const formatTimestamp = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString()
  }

  const getEventIcon = (event: TimelineEvent) => {
    switch (event.type) {
      case 'agent_thinking':
        return <div className="w-2 h-2 bg-agent-thinking rounded-full animate-pulse" />
      case 'tool_call':
        if (event.toolCall?.status === 'success') {
          return <CheckCircle className="w-4 h-4 text-agent-success" />
        } else if (event.toolCall?.status === 'error') {
          return <AlertCircle className="w-4 h-4 text-agent-error" />
        } else if (event.toolCall?.status === 'waiting_approval') {
          return <Play className="w-4 h-4 text-agent-approval animate-pulse" />
        }
        return <div className="w-2 h-2 bg-agent-pending rounded-full animate-pulse" />
      case 'user_input':
        return <div className="w-2 h-2 bg-blue-500 rounded-full" />
      case 'approval_request':
        return <AlertCircle className="w-4 h-4 text-agent-approval" />
      case 'state_change':
        return <div className="w-2 h-2 bg-purple-500 rounded-full" />
      default:
        return <div className="w-2 h-2 bg-gray-400 rounded-full" />
    }
  }

  const getRiskColor = (riskLevel?: string) => {
    switch (riskLevel) {
      case 'safe': return 'text-risk-safe'
      case 'medium': return 'text-risk-medium'
      case 'high': return 'text-risk-high'
      case 'critical': return 'text-risk-critical'
      default: return 'text-gray-500'
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Clock className="w-5 h-5" />
          Run Timeline
        </h2>
      </div>

      {/* Timeline Events */}
      <div className="flex-1 overflow-y-auto timeline-scroll">
        {timeline.length === 0 ? (
          <div className="text-center text-gray-500 mt-8 p-4">
            <Clock className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p className="text-sm">No events yet</p>
            <p className="text-xs mt-2">Start a conversation to see the agent's thinking process</p>
          </div>
        ) : (
          <div className="p-4 space-y-3">
            {timeline.map((event) => {
              const isExpanded = expandedEvents.has(event.id)
              return (
                <div key={event.id} className="border border-gray-200 dark:border-gray-700 rounded-lg">
                  {/* Event Header */}
                  <div 
                    className="p-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 flex items-start gap-3"
                    onClick={() => toggleExpanded(event.id)}
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      {getEventIcon(event)}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">
                            {event.type === 'tool_call' ? event.toolCall?.tool : event.type.replace('_', ' ')}
                          </span>
                          {event.toolCall?.riskLevel && (
                            <span className={`text-xs px-2 py-1 rounded-full bg-gray-100 dark:bg-gray-700 ${
                              getRiskColor(event.toolCall.riskLevel)
                            }`}>
                              {event.toolCall.riskLevel}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-gray-500 truncate">
                          {formatTimestamp(event.timestamp)} • {event.content.slice(0, 60)}
                          {event.content.length > 60 && '...'}
                        </div>
                      </div>
                    </div>
                    {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  </div>

                  {/* Expanded Content */}
                  {isExpanded && (
                    <div className="px-3 pb-3 border-t border-gray-100 dark:border-gray-700">
                      <div className="mt-2 space-y-3">
                        {/* Event Content */}
                        <div className="text-sm">
                          <div className="font-medium text-gray-700 dark:text-gray-300 mb-1">Content:</div>
                          <div className="bg-gray-50 dark:bg-gray-800 rounded p-2 text-xs font-mono">
                            {event.content}
                          </div>
                        </div>

                        {/* Tool Call Details */}
                        {event.toolCall && (
                          <div className="space-y-2">
                            {/* Arguments */}
                            <div>
                              <div className="font-medium text-gray-700 dark:text-gray-300 mb-1 text-xs">Arguments:</div>
                              <div className="bg-blue-50 dark:bg-blue-900/20 rounded p-2 text-xs font-mono">
                                <pre>{JSON.stringify(event.toolCall.args, null, 2)}</pre>
                              </div>
                            </div>

                            {/* Result */}
                            {event.toolCall.result && (
                              <div>
                                <div className="font-medium text-gray-700 dark:text-gray-300 mb-1 text-xs">Result:</div>
                                <div className="bg-green-50 dark:bg-green-900/20 rounded p-2 text-xs font-mono max-h-32 overflow-y-auto">
                                  <pre>{JSON.stringify(event.toolCall.result, null, 2)}</pre>
                                </div>
                              </div>
                            )}

                            {/* Error */}
                            {event.toolCall.error && (
                              <div>
                                <div className="font-medium text-gray-700 dark:text-gray-300 mb-1 text-xs">Error:</div>
                                <div className="bg-red-50 dark:bg-red-900/20 rounded p-2 text-xs">
                                  {event.toolCall.error}
                                </div>
                              </div>
                            )}

                            {/* Approval Actions */}
                            {event.toolCall.status === 'waiting_approval' && (
                              <div className="flex gap-2 pt-2">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    onApprove(event.toolCall!.id)
                                  }}
                                  className="px-3 py-1 bg-green-500 text-white rounded text-xs hover:bg-green-600"
                                >
                                  ✓ Approve
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    onReject(event.toolCall!.id)
                                  }}
                                  className="px-3 py-1 bg-red-500 text-white rounded text-xs hover:bg-red-600"
                                >
                                  ✗ Reject
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    onRerun(event.toolCall!.id)
                                  }}
                                  className="px-3 py-1 bg-blue-500 text-white rounded text-xs hover:bg-blue-600"
                                >
                                  ↻ Edit & Rerun
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
