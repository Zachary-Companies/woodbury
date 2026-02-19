import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import Timeline from '@/components/Timeline'
import { TimelineEvent } from '@/types'

const mockEvents: TimelineEvent[] = [
  {
    id: '1',
    type: 'thought',
    timestamp: new Date('2024-01-01T10:00:00Z'),
    data: { content: 'Thinking about the problem' },
    status: 'completed'
  },
  {
    id: '2',
    type: 'tool_call',
    timestamp: new Date('2024-01-01T10:01:00Z'),
    data: {
      name: 'file_read',
      args: { path: '/test/file.txt' },
      riskLevel: 'safe'
    },
    status: 'completed'
  },
  {
    id: '3',
    type: 'tool_result',
    timestamp: new Date('2024-01-01T10:02:00Z'),
    data: {
      success: true,
      data: 'File contents here'
    },
    status: 'completed'
  }
]

describe('Timeline Component', () => {
  it('renders empty state when no events', () => {
    render(<Timeline events={[]} />)
    
    expect(screen.getByText('Timeline')).toBeInTheDocument()
    expect(screen.getByText('0 events')).toBeInTheDocument()
    expect(screen.getByText('No timeline events yet')).toBeInTheDocument()
  })

  it('displays events with correct count', () => {
    render(<Timeline events={mockEvents} />)
    
    expect(screen.getByText('3 events')).toBeInTheDocument()
  })

  it('renders different event types with appropriate icons', () => {
    render(<Timeline events={mockEvents} />)
    
    // Check that thought event is rendered
    expect(screen.getByText('Thought')).toBeInTheDocument()
    
    // Check that tool call event is rendered with tool name
    expect(screen.getByText('Tool Call')).toBeInTheDocument()
    expect(screen.getByText('(file_read)')).toBeInTheDocument()
    
    // Check that tool result event is rendered
    expect(screen.getByText('Tool Result')).toBeInTheDocument()
  })

  it('displays timestamps correctly', () => {
    render(<Timeline events={mockEvents} />)
    
    // Check that timestamps are displayed (format may vary based on locale)
    expect(screen.getByText(/10:00/)).toBeInTheDocument()
    expect(screen.getByText(/10:01/)).toBeInTheDocument()
    expect(screen.getByText(/10:02/)).toBeInTheDocument()
  })

  it('expands and collapses event details on click', () => {
    render(<Timeline events={mockEvents} />)
    
    const toolCallEvent = screen.getByText('Tool Call')
    
    // Initially collapsed
    expect(screen.getByText('↓ Click to expand details')).toBeInTheDocument()
    
    // Click to expand
    fireEvent.click(toolCallEvent.closest('.cursor-pointer')!)
    
    // Should show expanded content
    expect(screen.getByText('↑ Click to collapse')).toBeInTheDocument()
    expect(screen.getByText('Tool: file_read')).toBeInTheDocument()
    expect(screen.getByText('Risk Level:')).toBeInTheDocument()
    
    // Click to collapse
    fireEvent.click(toolCallEvent.closest('.cursor-pointer')!)
    
    // Should be collapsed again
    expect(screen.getByText('↓ Click to expand details')).toBeInTheDocument()
  })

  it('shows risk levels with appropriate styling', () => {
    const highRiskEvent: TimelineEvent = {
      id: '4',
      type: 'tool_call',
      timestamp: new Date(),
      data: {
        name: 'shell_execute',
        args: { command: 'rm -rf /' },
        riskLevel: 'critical'
      }
    }
    
    render(<Timeline events={[highRiskEvent]} />)
    
    const eventElement = screen.getByText('Tool Call')
    fireEvent.click(eventElement.closest('.cursor-pointer')!)
    
    // Should show critical risk level with appropriate styling
    expect(screen.getByText('critical')).toBeInTheDocument()
    expect(screen.getByText('critical')).toHaveClass('bg-red-100', 'text-red-800')
  })

  it('displays tool arguments in expanded view', () => {
    render(<Timeline events={mockEvents} />)
    
    const toolCallEvent = screen.getByText('Tool Call')
    fireEvent.click(toolCallEvent.closest('.cursor-pointer')!)
    
    // Should show arguments
    expect(screen.getByText('Arguments:')).toBeInTheDocument()
    expect(screen.getByText('{
  "path": "/test/file.txt"
}')).toBeInTheDocument()
  })

  it('displays tool results with success/failure status', () => {
    render(<Timeline events={mockEvents} />)
    
    const toolResultEvent = screen.getByText('Tool Result')
    fireEvent.click(toolResultEvent.closest('.cursor-pointer')!)
    
    // Should show success status
    expect(screen.getByText('Status:')).toBeInTheDocument()
    expect(screen.getByText('Success')).toBeInTheDocument()
    expect(screen.getByText('Success')).toHaveClass('bg-green-100', 'text-green-800')
    
    // Should show result data
    expect(screen.getByText('Result:')).toBeInTheDocument()
    expect(screen.getByText('"File contents here"')).toBeInTheDocument()
  })
})
