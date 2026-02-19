/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Timeline } from '@/components/Timeline';
import { TimelineEvent, ToolCallEvent } from '@/types';

const mockTimeline: TimelineEvent[] = [
  {
    id: '1',
    type: 'user_input',
    timestamp: Date.now() - 60000,
    content: 'Please read the README file',
    metadata: {}
  },
  {
    id: '2', 
    type: 'agent_thinking',
    timestamp: Date.now() - 50000,
    content: 'I need to read the README file to understand the project',
    metadata: {}
  },
  {
    id: '3',
    type: 'tool_call',
    timestamp: Date.now() - 40000,
    content: 'Reading README.md',
    metadata: {},
    toolCall: {
      id: 'tool-1',
      tool: 'file_read',
      status: 'success',
      args: { path: 'README.md' },
      result: 'File content here...',
      riskLevel: 'safe',
      timestamp: Date.now() - 40000
    }
  },
  {
    id: '4',
    type: 'tool_call', 
    timestamp: Date.now() - 30000,
    content: 'Writing output file',
    metadata: {},
    toolCall: {
      id: 'tool-2',
      tool: 'file_write',
      status: 'waiting_approval',
      args: { path: 'output.txt', content: 'Hello world' },
      riskLevel: 'medium',
      timestamp: Date.now() - 30000
    }
  }
];

const mockPendingApprovals: ToolCallEvent[] = [
  {
    id: 'tool-2',
    tool: 'file_write',
    status: 'waiting_approval',
    args: { path: 'output.txt', content: 'Hello world' },
    riskLevel: 'medium',
    timestamp: Date.now() - 30000
  }
];

describe('Timeline Component', () => {
  const defaultProps = {
    timeline: mockTimeline,
    pendingApprovals: mockPendingApprovals,
    onApprove: jest.fn(),
    onReject: jest.fn(),
    onRerun: jest.fn()
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders timeline header correctly', () => {
    render(<Timeline {...defaultProps} />);
    
    expect(screen.getByText('Run Timeline')).toBeInTheDocument();
  });

  it('displays all timeline events', () => {
    render(<Timeline {...defaultProps} />);
    
    expect(screen.getByText('user input')).toBeInTheDocument();
    expect(screen.getByText('agent thinking')).toBeInTheDocument();
    expect(screen.getByText('file_read')).toBeInTheDocument(); 
    expect(screen.getByText('file_write')).toBeInTheDocument();
  });

  it('displays risk levels correctly', () => {
    render(<Timeline {...defaultProps} />);
    
    expect(screen.getByText('safe')).toBeInTheDocument();
    expect(screen.getByText('medium')).toBeInTheDocument();
  });

  it('allows expanding and collapsing events', () => {
    render(<Timeline {...defaultProps} />);
    
    // Find expandable event
    const fileReadEvent = screen.getByText('file_read').closest('.border');
    expect(fileReadEvent).toBeInTheDocument();
    
    // Should show collapsed initially (▶)
    expect(screen.getAllByText('▶')).toHaveLength(4);
    
    // Click to expand
    fireEvent.click(fileReadEvent!);
    
    // Should show expanded content
    expect(screen.getByText('Arguments:')).toBeInTheDocument();
    expect(screen.getByText('Result:')).toBeInTheDocument();
    expect(screen.getByText('▼')).toBeInTheDocument();
  });

  it('shows approval buttons for pending approval events', () => {
    render(<Timeline {...defaultProps} />);
    
    // Find the pending approval event and expand it
    const fileWriteEvent = screen.getByText('file_write').closest('.border');
    fireEvent.click(fileWriteEvent!);
    
    // Should show approval buttons
    expect(screen.getByText('✓ Approve')).toBeInTheDocument();
    expect(screen.getByText('✗ Reject')).toBeInTheDocument();
    expect(screen.getByText('↻ Edit & Rerun')).toBeInTheDocument();
  });

  it('calls approval callbacks when buttons are clicked', () => {
    render(<Timeline {...defaultProps} />);
    
    // Find and expand the pending approval event
    const fileWriteEvent = screen.getByText('file_write').closest('.border');
    fireEvent.click(fileWriteEvent!);
    
    // Click approve button
    fireEvent.click(screen.getByText('✓ Approve'));
    expect(defaultProps.onApprove).toHaveBeenCalledWith('tool-2');
    
    // Click reject button  
    fireEvent.click(screen.getByText('✗ Reject'));
    expect(defaultProps.onReject).toHaveBeenCalledWith('tool-2');
    
    // Click rerun button
    fireEvent.click(screen.getByText('↻ Edit & Rerun'));
    expect(defaultProps.onRerun).toHaveBeenCalledWith('tool-2');
  });

  it('displays empty state when no events', () => {
    render(<Timeline {...defaultProps} timeline={[]} />);
    
    expect(screen.getByText('No events yet')).toBeInTheDocument();
    expect(screen.getByText("Start a conversation to see the agent's thinking process")).toBeInTheDocument();
  });

  it('formats timestamps correctly', () => {
    render(<Timeline {...defaultProps} />);
    
    // Should show formatted times (testing that time formatting doesn't crash)
    const timeElements = screen.getAllByText(/\d{1,2}:\d{2}:\d{2}/);
    expect(timeElements.length).toBeGreaterThan(0);
  });

  it('truncates long content in event headers', () => {
    const longContentEvent: TimelineEvent = {
      id: '5',
      type: 'user_input',
      timestamp: Date.now(),
      content: 'This is a very long message that should be truncated in the event header display because it exceeds the character limit that we have set',
      metadata: {}
    };
    
    render(<Timeline {...defaultProps} timeline={[longContentEvent]} />);
    
    // Should show truncated content with ellipsis
    expect(screen.getByText(/This is a very long message that should be truncated/)).toBeInTheDocument();
    expect(screen.getByText(/\.\.\./)).toBeInTheDocument();
  });
});
