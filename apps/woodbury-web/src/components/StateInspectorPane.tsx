'use client'

import { WorkingSetItem, PinnedFact, GoalState, TaskState, QueueState, ContextInfo } from '@/types'
import { File, Link, StickyNote, Target, CheckSquare, Clock, Brain, Plus, X } from 'lucide-react'
import { useState } from 'react'

interface StateInspectorPaneProps {
  workingSet: WorkingSetItem[]
  pinnedFacts: PinnedFact[]
  goal: GoalState
  tasks: TaskState[]
  queue: QueueState | null
  context: ContextInfo
  onAddToWorkingSet: (item: WorkingSetItem) => void
  onRemoveFromWorkingSet: (index: number) => void
  onPinFact: (fact: string) => void
}

export function StateInspectorPane({
  workingSet,
  pinnedFacts,
  goal,
  tasks,
  queue,
  context,
  onAddToWorkingSet,
  onRemoveFromWorkingSet,
  onPinFact
}: StateInspectorPaneProps) {
  const [activeTab, setActiveTab] = useState<'context' | 'goal' | 'tasks' | 'memory'>('context')
  const [newFactInput, setNewFactInput] = useState('')

  const contextUsagePercent = (context.totalTokens / context.maxTokens) * 100
  const isNearLimit = contextUsagePercent > 80

  const getItemIcon = (item: WorkingSetItem) => {
    switch (item.type) {
      case 'file': return <File className="w-4 h-4" />
      case 'url': return <Link className="w-4 h-4" />
      case 'note': return <StickyNote className="w-4 h-4" />
    }
  }

  const formatFileSize = (bytes?: number) => {
    if (!bytes) return ''
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  }

  const handleAddFact = () => {
    if (newFactInput.trim()) {
      onPinFact(newFactInput.trim())
      setNewFactInput('')
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header with tabs */}
      <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="p-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Brain className="w-5 h-5" />
            State Inspector
          </h2>
        </div>
        <div className="flex border-t border-gray-200 dark:border-gray-700">
          {[
            { id: 'context', label: 'Context', icon: File },
            { id: 'goal', label: 'Goal', icon: Target },
            { id: 'tasks', label: 'Tasks', icon: CheckSquare },
            { id: 'memory', label: 'Memory', icon: Brain }
          ].map(tab => {
            const Icon = tab.icon
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex-1 px-3 py-2 text-sm font-medium flex items-center justify-center gap-2 ${
                  activeTab === tab.id
                    ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 border-b-2 border-blue-500'
                    : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'context' && (
          <div className="p-4 space-y-4">
            {/* Context Budget */}
            <div>
              <div className="flex justify-between items-center mb-2">
                <span className="text-sm font-medium">Context Usage</span>
                <span className={`text-xs ${isNearLimit ? 'text-red-500' : 'text-gray-500'}`}>
                  {context.totalTokens.toLocaleString()} / {context.maxTokens.toLocaleString()} tokens
                </span>
              </div>
              <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                <div 
                  className={`h-2 rounded-full transition-all ${
                    isNearLimit ? 'bg-red-500' : contextUsagePercent > 60 ? 'bg-yellow-500' : 'bg-green-500'
                  }`}
                  style={{ width: `${Math.min(contextUsagePercent, 100)}%` }}
                />
              </div>
              {isNearLimit && (
                <p className="text-xs text-red-500 mt-1">⚠️ Approaching limit - consider /summarize</p>
              )}
            </div>

            {/* Context Breakdown */}
            <div>
              <h3 className="text-sm font-medium mb-2">Breakdown</h3>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between">
                  <span>System prompt:</span>
                  <span>{context.breakdown.systemPrompt.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span>Working set:</span>
                  <span>{context.breakdown.workingSet.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span>Conversation:</span>
                  <span>{context.breakdown.conversation.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span>Tool outputs:</span>
                  <span>{context.breakdown.toolOutputs.toLocaleString()}</span>
                </div>
              </div>
            </div>

            {/* Working Set */}
            <div>
              <div className="flex justify-between items-center mb-2">
                <h3 className="text-sm font-medium">Working Set ({workingSet.length})</h3>
                <button className="p-1 text-gray-400 hover:text-gray-600">
                  <Plus className="w-4 h-4" />
                </button>
              </div>
              {workingSet.length === 0 ? (
                <p className="text-xs text-gray-500">No files or URLs in working set</p>
              ) : (
                <div className="space-y-2">
                  {workingSet.map((item, index) => (
                    <div key={index} className="flex items-center gap-2 p-2 bg-gray-50 dark:bg-gray-800 rounded text-xs">
                      {getItemIcon(item)}
                      <div className="flex-1 min-w-0">
                        <div className="truncate font-medium">{item.title}</div>
                        {item.size && (
                          <div className="text-gray-500">{formatFileSize(item.size)}</div>
                        )}
                      </div>
                      <button
                        onClick={() => onRemoveFromWorkingSet(index)}
                        className="p-1 text-gray-400 hover:text-red-500"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'goal' && (
          <div className="p-4 space-y-4">
            {goal.objective ? (
              <>
                <div>
                  <h3 className="text-sm font-medium mb-2">Objective</h3>
                  <p className="text-sm text-gray-700 dark:text-gray-300">{goal.objective}</p>
                </div>
                
                {goal.successCriteria && goal.successCriteria.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium mb-2">Success Criteria</h3>
                    <ul className="space-y-1">
                      {goal.successCriteria.map((criteria, index) => (
                        <li key={index} className="text-xs flex items-start gap-2">
                          <CheckSquare className="w-3 h-3 mt-0.5 text-gray-400" />
                          {criteria}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                
                {goal.constraints && goal.constraints.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium mb-2">Constraints</h3>
                    <ul className="space-y-1">
                      {goal.constraints.map((constraint, index) => (
                        <li key={index} className="text-xs text-gray-600 dark:text-gray-400">
                          • {constraint}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <div className="text-center text-gray-500">
                <Target className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No goal set</p>
                <p className="text-xs mt-1">Use /goal to define your objective</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'tasks' && (
          <div className="p-4 space-y-4">
            {/* Queue Status */}
            {queue && (
              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3">
                <div className="flex items-center gap-2 mb-2">
                  <Clock className="w-4 h-4 text-blue-500" />
                  <span className="text-sm font-medium">Queue Progress</span>
                </div>
                <div className="text-xs text-gray-600 dark:text-gray-400">
                  {queue.completed} / {queue.total} completed • {queue.pending} pending
                </div>
                {queue.currentItem && (
                  <div className="mt-2 text-xs">
                    <span className="font-medium">Current:</span> {queue.currentItem.name}
                  </div>
                )}
              </div>
            )}
            
            {/* Tasks */}
            {tasks.length > 0 ? (
              <div>
                <h3 className="text-sm font-medium mb-2">Tasks ({tasks.length})</h3>
                <div className="space-y-2">
                  {tasks.map(task => {
                    const statusColors = {
                      pending: 'bg-gray-100 text-gray-700',
                      in_progress: 'bg-blue-100 text-blue-700',
                      completed: 'bg-green-100 text-green-700',
                      blocked: 'bg-red-100 text-red-700',
                      deleted: 'bg-gray-100 text-gray-500'
                    }
                    return (
                      <div key={task.id} className="border border-gray-200 dark:border-gray-700 rounded p-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-medium truncate">{task.subject}</div>
                            {task.description && (
                              <div className="text-xs text-gray-500 mt-1 line-clamp-2">{task.description}</div>
                            )}
                          </div>
                          <span className={`px-2 py-1 rounded text-xs font-medium ${statusColors[task.status]}`}>
                            {task.status.replace('_', ' ')}
                          </span>
                        </div>
                        {task.status === 'blocked' && task.blockedReason && (
                          <div className="mt-2 text-xs text-red-600 dark:text-red-400">
                            Blocked: {task.blockedReason}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : (
              <div className="text-center text-gray-500">
                <CheckSquare className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No tasks</p>
                <p className="text-xs mt-1">Complex work will create tasks automatically</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'memory' && (
          <div className="p-4 space-y-4">
            {/* Add new fact */}
            <div>
              <h3 className="text-sm font-medium mb-2">Pin New Fact</h3>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newFactInput}
                  onChange={(e) => setNewFactInput(e.target.value)}
                  placeholder="Important constraint or insight..."
                  className="flex-1 px-2 py-1 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                  onKeyDown={(e) => e.key === 'Enter' && handleAddFact()}
                />
                <button
                  onClick={handleAddFact}
                  disabled={!newFactInput.trim()}
                  className="px-3 py-1 bg-blue-500 text-white rounded text-xs hover:bg-blue-600 disabled:bg-gray-300"
                >
                  Pin
                </button>
              </div>
            </div>
            
            {/* Pinned facts */}
            <div>
              <h3 className="text-sm font-medium mb-2">Pinned Facts ({pinnedFacts.length})</h3>
              {pinnedFacts.length === 0 ? (
                <p className="text-xs text-gray-500">No pinned facts yet</p>
              ) : (
                <div className="space-y-2">
                  {pinnedFacts.map(fact => (
                    <div key={fact.id} className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded p-2">
                      <p className="text-xs">{fact.content}</p>
                      <div className="flex justify-between items-center mt-1">
                        <span className="text-xs text-gray-500">
                          {new Date(fact.timestamp).toLocaleTimeString()}
                        </span>
                        <button className="text-xs text-red-500 hover:text-red-700">Remove</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
