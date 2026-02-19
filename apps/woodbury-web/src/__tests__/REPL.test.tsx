import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import REPL from '@/components/REPL'

// Mock WebSocket
class MockWebSocket {
  constructor(public url: string) {}
  send = jest.fn()
  close = jest.fn()
  addEventListener = jest.fn()
  removeEventListener = jest.fn()
}

global.WebSocket = MockWebSocket as any

describe('REPL Component', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders the 3-pane layout correctly', () => {
    render(<REPL />)
    
    // Check for the three main panes
    expect(screen.getByText('Conversation')).toBeInTheDocument()
    expect(screen.getByText('Timeline')).toBeInTheDocument()
    expect(screen.getByText('State Inspector')).toBeInTheDocument()
  })

  it('displays input field and send button', () => {
    render(<REPL />)
    
    const input = screen.getByPlaceholderText('Enter your request...')
    const sendButton = screen.getByText('Send')
    
    expect(input).toBeInTheDocument()
    expect(sendButton).toBeInTheDocument()
  })

  it('handles user input submission', async () => {
    render(<REPL />)
    
    const input = screen.getByPlaceholderText('Enter your request...')
    const sendButton = screen.getByText('Send')
    
    fireEvent.change(input, { target: { value: 'test message' } })
    fireEvent.click(sendButton)
    
    // Check that the message appears in conversation
    await waitFor(() => {
      expect(screen.getByText('test message')).toBeInTheDocument()
    })
    
    // Check that input is cleared and button shows running state
    expect(input).toHaveValue('')
    await waitFor(() => {
      expect(screen.getByText('Running...')).toBeInTheDocument()
    })
  })

  it('displays working set and context information', () => {
    render(<REPL />)
    
    // Check initial empty states
    expect(screen.getByText('Working Set')).toBeInTheDocument()
    expect(screen.getByText('Context')).toBeInTheDocument()
    expect(screen.getByText('No items in working set')).toBeInTheDocument()
    expect(screen.getByText('No active goals')).toBeInTheDocument()
  })

  it('shows timeline events count', () => {
    render(<REPL />)
    
    expect(screen.getByText('0 events')).toBeInTheDocument()
  })

  it('disables input when running', async () => {
    render(<REPL />)
    
    const input = screen.getByPlaceholderText('Enter your request...')
    const sendButton = screen.getByText('Send')
    
    fireEvent.change(input, { target: { value: 'test' } })
    fireEvent.click(sendButton)
    
    // Input and button should be disabled while running
    await waitFor(() => {
      expect(input).toBeDisabled()
      expect(screen.getByText('Running...')).toBeDisabled()
    })
  })
})
