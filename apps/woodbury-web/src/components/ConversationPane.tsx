'use client'

import { useState } from 'react'
import { Send, Terminal } from 'lucide-react'

interface ConversationPaneProps {
  isRunning: boolean
  onSendMessage: (message: string) => void
  onSlashCommand: (command: string) => void
}

export function ConversationPane({ isRunning, onSendMessage, onSlashCommand }: ConversationPaneProps) {
  const [input, setInput] = useState('')
  const [history] = useState<Array<{ type: 'user' | 'assistant', content: string }>>([])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || isRunning) return

    if (input.startsWith('/')) {
      onSlashCommand(input)
    } else {
      onSendMessage(input)
    }
    setInput('')
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Terminal className="w-5 h-5" />
          Conversation
        </h2>
      </div>

      {/* Message History */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {history.length === 0 ? (
          <div className="text-center text-gray-500 mt-8">
            <Terminal className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p className="text-sm">Welcome to Woodbury REPL</p>
            <p className="text-xs mt-2">Type a message or use slash commands like /tools, /plan, /ctx</p>
          </div>
        ) : (
          history.map((msg, i) => (
            <div key={i} className={`${msg.type === 'user' ? 'text-right' : 'text-left'}`}>
              <div className={`inline-block max-w-[80%] p-3 rounded-lg ${
                msg.type === 'user' 
                  ? 'bg-blue-500 text-white' 
                  : 'bg-gray-100 dark:bg-gray-700'
              }`}>
                {msg.content}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Input Form */}
      <div className="p-4 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={isRunning ? "Agent is running..." : "Type a message or /command"}
            disabled={isRunning}
            className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md 
                     focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
                     disabled:bg-gray-100 dark:disabled:bg-gray-700 disabled:cursor-not-allowed
                     bg-white dark:bg-gray-700"
          />
          <button
            type="submit"
            disabled={!input.trim() || isRunning}
            className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 
                     disabled:bg-gray-300 dark:disabled:bg-gray-600 disabled:cursor-not-allowed
                     transition-colors flex items-center gap-2"
          >
            <Send className="w-4 h-4" />
            Send
          </button>
        </form>
        
        {/* Command hints */}
        <div className="mt-2 text-xs text-gray-500">
          <span className="font-medium">Commands:</span> /plan, /tools, /ctx, /add, /pin, /export, /help
        </div>
      </div>
    </div>
  )
}
