/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { REPL } from '@/components/REPL';

// Mock the Timeline component to isolate REPL testing
jest.mock('@/components/Timeline', () => ({
  Timeline: ({ timeline }: any) => (
    <div data-testid="timeline-mock">
      Timeline with {timeline.length} events
    </div>
  ),
}));

describe('REPL Component', () => {
  it('renders the 3-pane layout correctly', () => {
    render(<REPL />);
    
    // Verify all three panes are rendered
    expect(screen.getByText('Conversation')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-mock')).toBeInTheDocument();
    expect(screen.getByText('State Inspector')).toBeInTheDocument();
  });

  it('shows correct initial state', () => {
    render(<REPL />);
    
    // Should show not running initially
    expect(screen.getByText('Running: false')).toBeInTheDocument();
    
    // Should show event count
    expect(screen.getByText(/Events:/)).toBeInTheDocument();
  });

  it('applies correct CSS classes for layout', () => {
    render(<REPL />);
    
    const mainContainer = screen.getByText('Conversation').closest('.flex');
    expect(mainContainer).toHaveClass('h-screen');
    expect(mainContainer).toHaveClass('bg-gray-50');
    expect(mainContainer).toHaveClass('dark:bg-gray-900');
  });

  it('renders all three panes with correct widths', () => {
    render(<REPL />);
    
    const conversationPane = screen.getByText('Conversation').closest('div.w-1\/3');
    const timelinePane = screen.getByTestId('timeline-mock').closest('div.w-1\/3');
    const statePane = screen.getByText('State Inspector').closest('div.w-1\/3');
    
    expect(conversationPane).toBeInTheDocument();
    expect(timelinePane).toBeInTheDocument();
    expect(statePane).toBeInTheDocument();
  });

  it('passes timeline data to Timeline component', () => {
    render(<REPL />);
    
    // Should show the mocked timeline with sample events
    expect(screen.getByText(/Timeline with \d+ events/)).toBeInTheDocument();
  });
});
