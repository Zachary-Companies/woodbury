'use client'

import { useState } from 'react'
import { ApprovalRequest } from '@/types'

interface ApprovalGateProps {
  request: ApprovalRequest
  onApprove: (reason?: string) => void
  onReject: (reason?: string) => void
}

function RiskIndicator({ level }: { level: string }) {
  const colors = {
    safe: 'bg-green-100 text-green-800 border-green-200',
    medium: 'bg-yellow-100 text-yellow-800 border-yellow-200',
    high: 'bg-orange-100 text-orange-800 border-orange-200',
    critical: 'bg-red-100 text-red-800 border-red-200'
  }
  
  return (
    <div className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium border ${colors[level as keyof typeof colors] || colors.medium}`}>
      <div className="w-2 h-2 rounded-full bg-current mr-2" />
      {level.toUpperCase()} RISK
    </div>
  )
}

export default function ApprovalGate({ request, onApprove, onReject }: ApprovalGateProps) {
  const [reason, setReason] = useState('')
  const [showReason, setShowReason] = useState(false)
  
  const handleApprove = () => {
    onApprove(reason || undefined)
    setReason('')
    setShowReason(false)
  }
  
  const handleReject = () => {
    onReject(reason || 'Rejected by user')
    setReason('')
    setShowReason(false)
  }
  
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background border border-border rounded-lg shadow-lg max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="p-6 border-b border-border">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold">Approval Required</h2>
            <RiskIndicator level={request.toolCall.riskLevel} />
          </div>
          
          <div className="text-lg font-medium text-foreground">
            Execute tool: <code className="bg-muted px-2 py-1 rounded font-mono text-sm">{request.toolCall.name}</code>
          </div>
        </div>
        
        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Justification */}
          <div>
            <h3 className="font-medium mb-2">Justification</h3>
            <div className="bg-muted rounded-lg p-4 text-sm">
              {request.justification}
            </div>
          </div>
          
          {/* Risk Assessment */}
          <div>
            <h3 className="font-medium mb-2">Risk Assessment</h3>
            <div className="bg-muted rounded-lg p-4 text-sm">
              {request.riskAssessment}
            </div>
          </div>
          
          {/* Tool Arguments */}
          <div>
            <h3 className="font-medium mb-2">Tool Arguments</h3>
            <div className="bg-muted rounded-lg p-4">
              <pre className="text-sm overflow-x-auto">
                {JSON.stringify(request.toolCall.args, null, 2)}
              </pre>
            </div>
          </div>
          
          {/* Preview Data (if available) */}
          {request.previewData && (
            <div>
              <h3 className="font-medium mb-2">Preview</h3>
              <div className="bg-muted rounded-lg p-4">
                {request.previewData.type === 'diff' ? (
                  <div className="font-mono text-sm space-y-1">
                    {request.previewData.lines.map((line: any, i: number) => (
                      <div key={i} className={`${
                        line.type === 'add' ? 'bg-green-100 text-green-800' :
                        line.type === 'remove' ? 'bg-red-100 text-red-800' :
                        'text-muted-foreground'
                      } px-2 py-0.5 rounded`}>
                        <span className="inline-block w-8 text-right mr-2 text-xs opacity-60">
                          {line.number}
                        </span>
                        <span className="mr-2">
                          {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
                        </span>
                        {line.content}
                      </div>
                    ))}
                  </div>
                ) : (
                  <pre className="text-sm overflow-x-auto">
                    {typeof request.previewData === 'string' 
                      ? request.previewData 
                      : JSON.stringify(request.previewData, null, 2)
                    }
                  </pre>
                )}
              </div>
            </div>
          )}
          
          {/* Reason Input (if shown) */}
          {showReason && (
            <div>
              <h3 className="font-medium mb-2">Reason (Optional)</h3>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Add a reason for your decision..."
                className="w-full px-3 py-2 border border-input rounded-lg bg-background resize-none"
                rows={3}
              />
            </div>
          )}
        </div>
        
        {/* Actions */}
        <div className="p-6 border-t border-border flex items-center justify-between">
          <button
            onClick={() => setShowReason(!showReason)}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            {showReason ? 'Hide' : 'Add'} reason
          </button>
          
          <div className="space-x-3">
            <button
              onClick={handleReject}
              className="px-4 py-2 border border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground rounded-md transition-colors"
            >
              Reject
            </button>
            <button
              onClick={handleApprove}
              className="px-4 py-2 bg-primary text-primary-foreground hover:bg-primary/90 rounded-md transition-colors"
            >
              Approve
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
