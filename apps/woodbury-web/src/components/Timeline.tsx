'use client'

import { useState, useCallback } from 'react'
import { TimelineEvent } from '@/types'

interface TimelineProps {
  events: TimelineEvent[]
}

const getEventIcon = (type: string) => {
  switch (type) {
    case 'thought': return '💭'
    case 'tool_call': return '🔧'
    case 'tool_result': return '📊'
    case 'approval_request': return '⚠️'
    case 'state_change': return '🔄'
    default: return '•'
  }
}

const getEventColor = (type: string, status?: string) => {
  if (status === 'failed') return 'text-destructive'
  if (status === 'pending') return 'text-yellow-600'
  if (status === 'approved') return 'text-green-600'
  if (status === 'rejected') return 'text-destructive'
  
  switch (type) {
    case 'thought': return 'text-blue-600'
    case 'tool_call': return 'text-purple-600'
    case 'tool_result': return 'text-green-600'
    case 'approval_request': return 'text-orange-600'
    case 'state_change': return 'text-gray-600'
    default: return 'text-foreground'
  }
}

function EventDetails({ event }: { event: TimelineEvent }) {
  if (event.type === 'tool_call') {
    return (
      <div className="mt-2 bg-muted rounded p-3 text-sm">
        <div className="font-medium mb-2">Tool: {event.data.name}</div>
        <div className="mb-2">
          <span className="text-muted-foreground">Risk Level:</span>
          <span className={`ml-2 px-2 py-1 rounded text-xs ${
            event.data.riskLevel === 'critical' ? 'bg-red-100 text-red-800' :
            event.data.riskLevel === 'high' ? 'bg-orange-100 text-orange-800' :
            event.data.riskLevel === 'medium' ? 'bg-yellow-100 text-yellow-800' :
            'bg-green-100 text-green-800'
          }`}>
            {event.data.riskLevel}
          </span>
        </div>
        <div>
          <div className="text-muted-foreground mb-1">Arguments:</div>
          <pre className="bg-background p-2 rounded text-xs overflow-x-auto">
            {JSON.stringify(event.data.args, null, 2)}
          </pre>
        </div>
      </div>
    )
  }
  
  if (event.type === 'tool_result') {
    return (
      <div className="mt-2 bg-muted rounded p-3 text-sm">
        <div className="mb-2">
          <span className="text-muted-foreground">Status:</span>
          <span className={`ml-2 px-2 py-1 rounded text-xs ${
            event.data.success ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
          }`}>
            {event.data.success ? 'Success' : 'Failed'}
          </span>
        </div>
        {event.data.error && (
          <div className="mb-2">
            <div className="text-muted-foreground mb-1">Error:</div>
            <div className="bg-red-50 text-red-800 p-2 rounded text-xs">
              {event.data.error}
            </div>
          </div>
        )}
        <div>
          <div className="text-muted-foreground mb-1">Result:</div>
          <pre className="bg-background p-2 rounded text-xs overflow-x-auto max-h-40">
            {typeof event.data.data === 'string' ? event.data.data : JSON.stringify(event.data.data, null, 2)}
          </pre>
        </div>
      </div>
    )
  }
  
  if (event.type === 'thought') {
    return (
      <div className="mt-2 text-sm text-muted-foreground italic">
        {event.data.content}
      </div>
    )
  }
  
  return (
    <div className="mt-2 bg-muted rounded p-3 text-sm">
      <pre className="text-xs overflow-x-auto">
        {JSON.stringify(event.data, null, 2)}
      </pre>
    </div>
  )
}

export default function Timeline({ events }: TimelineProps) {
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set())
  
  const toggleExpanded = useCallback((eventId: string) => {
    setExpandedEvents(prev => {
      const newSet = new Set(prev)
      if (newSet.has(eventId)) {
        newSet.delete(eventId)
      } else {
        newSet.add(eventId)
      }
      return newSet
    })
  }, [])
  
  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-border">
        <h2 className="text-lg font-semibold">Timeline</h2>
        <div className="text-sm text-muted-foreground mt-1">
          {events.length} events
        </div>
      </div>
      
      <div className="flex-1 overflow-y-auto p-4">
        {events.length > 0 ? (
          <div className="space-y-4">
            {events.map((event, index) => {
              const isExpanded = expandedEvents.has(event.id)
              const colorClass = getEventColor(event.type, event.status)
              
              return (
                <div key={event.id} className="relative">
                  {/* Timeline line */}
                  {index < events.length - 1 && (
                    <div className="absolute left-4 top-8 w-px h-8 bg-border" />
                  )}
                  
                  {/* Event */}
                  <div 
                    className="flex items-start space-x-3 cursor-pointer hover:bg-muted/50 p-2 rounded"
                    onClick={() => toggleExpanded(event.id)}
                  >
                    <div className={`text-lg ${colorClass} flex-shrink-0 w-8 h-8 flex items-center justify-center`}>
                      {getEventIcon(event.type)}
                    </div>
                    
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <div className={`font-medium ${colorClass}`}>
                          {event.type.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}
                          {event.type === 'tool_call' && event.data.name && (
                            <span className="ml-2 text-sm font-normal text-muted-foreground">
                              ({event.data.name})
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground flex-shrink-0 ml-2">
                          {event.timestamp.toLocaleTimeString()}
                        </div>
                      </div>
                      
                      {event.status && (
                        <div className="mt-1">
                          <span className={`inline-block px-2 py-1 rounded text-xs ${
                            event.status === 'completed' ? 'bg-green-100 text-green-800' :
                            event.status === 'failed' ? 'bg-red-100 text-red-800' :
                            event.status === 'pending' ? 'bg-yellow-100 text-yellow-800' :
                            event.status === 'approved' ? 'bg-blue-100 text-blue-800' :
                            event.status === 'rejected' ? 'bg-red-100 text-red-800' :
                            'bg-gray-100 text-gray-800'
                          }`}>
                            {event.status}
                          </span>
                        </div>
                      )}
                      
                      {isExpanded && <EventDetails event={event} />}
                      
                      <div className="mt-1 text-xs text-muted-foreground">
                        {isExpanded ? '↑ Click to collapse' : '↓ Click to expand details'}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="text-center text-muted-foreground py-8">
            <div className="text-4xl mb-2">⏳</div>
            <div>No timeline events yet</div>
            <div className="text-sm">Events will appear here as the agent works</div>
          </div>
        )}
      </div>
    </div>
  )
}
