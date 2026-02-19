/**
 * WebSocket Agent Tests
 * Tests the real-time agent communication system
 */

import { WebSocketAgent } from '@/server/WebSocketAgent';
import { TimelineEvent } from '@/types';

// Mock WebSocket server
class MockWebSocketServer {
  clients: MockWebSocket[] = [];
  
  on(event: string, callback: (ws: MockWebSocket) => void) {
    if (event === 'connection') {
      // Store callback for later use in tests
    }
  }
  
  addClient(ws: MockWebSocket) {
    this.clients.push(ws);
  }
}

class MockWebSocket {
  readyState: number = 1; // OPEN
  
  send(data: string) {
    // Mock send functionality
  }
  
  on(event: string, callback: (...args: any[]) => void) {
    // Mock event handling
  }
}

describe('WebSocketAgent', () => {
  let agent: WebSocketAgent;
  let mockWsServer: MockWebSocketServer;

  beforeEach(() => {
    mockWsServer = new MockWebSocketServer();
    agent = new WebSocketAgent({
      model: 'claude-sonnet-4-20250514',
      workingDirectory: '/test',
      wsServer: mockWsServer as any
    });
  });

  afterEach(() => {
    // Clean up resources
  });

  it('should initialize with correct configuration', () => {
    expect(agent).toBeDefined();
    expect(agent.getModel()).toBe('claude-sonnet-4-20250514');
    expect(agent.getWorkingDirectory()).toBe('/test');
  });

  it('should handle WebSocket connections', () => {
    const mockWs = new MockWebSocket();
    
    // Test connection handling
    agent.handleConnection(mockWs as any);
    
    expect(agent.getConnectedClients()).toContain(mockWs);
  });

  it('should stream timeline events to connected clients', async () => {
    const mockWs = new MockWebSocket();
    const sendSpy = jest.spyOn(mockWs, 'send');
    
    agent.handleConnection(mockWs as any);
    
    const event: TimelineEvent = {
      id: 'test-1',
      type: 'user_input',
      timestamp: Date.now(),
      content: 'Test message',
      metadata: {}
    };
    
    agent.broadcastEvent(event);
    
    expect(sendSpy).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'timeline_event',
        data: event
      })
    );
  });

  it('should handle tool approval requests', async () => {
    const mockWs = new MockWebSocket();
    agent.handleConnection(mockWs as any);
    
    const approvalRequest = {
      type: 'approve_tool',
      toolCallId: 'tool-123'
    };
    
    const result = await agent.handleMessage(mockWs as any, JSON.stringify(approvalRequest));
    
    expect(result).toBeDefined();
    expect(agent.getPendingApprovals()).not.toContain('tool-123');
  });

  it('should handle tool rejection requests', async () => {
    const mockWs = new MockWebSocket();
    agent.handleConnection(mockWs as any);
    
    const rejectionRequest = {
      type: 'reject_tool',
      toolCallId: 'tool-123',
      reason: 'Too dangerous'
    };
    
    const result = await agent.handleMessage(mockWs as any, JSON.stringify(rejectionRequest));
    
    expect(result).toBeDefined();
    expect(agent.getRejectedTools()).toContain('tool-123');
  });

  it('should export run bundles', () => {
    const timeline: TimelineEvent[] = [
      {
        id: '1',
        type: 'user_input',
        timestamp: Date.now(),
        content: 'Test input',
        metadata: {}
      }
    ];
    
    agent.setTimeline(timeline);
    
    const bundle = agent.exportRunBundle();
    
    expect(bundle.runId).toBeDefined();
    expect(bundle.timeline).toEqual(timeline);
    expect(bundle.model).toBe('claude-sonnet-4-20250514');
    expect(bundle.timestamp).toBeDefined();
  });

  it('should handle replay requests', async () => {
    const bundle = {
      runId: 'test-run',
      timestamp: '2024-01-01T00:00:00Z',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'Test prompt',
      initialContext: [],
      timeline: [],
      artifacts: { files: {}, diffs: [] }
    };
    
    const result = await agent.replayFromBundle(bundle);
    
    expect(result.success).toBe(true);
    expect(agent.getTimeline()).toEqual(bundle.timeline);
  });

  it('should track working set changes', () => {
    const workingSetItem = {
      type: 'file' as const,
      path: 'test.ts',
      title: 'test.ts',
      size: 1024,
      lastModified: Date.now()
    };
    
    agent.addToWorkingSet(workingSetItem);
    
    expect(agent.getWorkingSet()).toContain(workingSetItem);
  });

  it('should handle context management', () => {
    const initialContext = agent.getContextInfo();
    
    expect(initialContext.totalTokens).toBeGreaterThan(0);
    expect(initialContext.maxTokens).toBeGreaterThan(0);
    expect(initialContext.breakdown).toBeDefined();
  });

  it('should cleanup resources on shutdown', () => {
    const mockWs1 = new MockWebSocket();
    const mockWs2 = new MockWebSocket();
    
    agent.handleConnection(mockWs1 as any);
    agent.handleConnection(mockWs2 as any);
    
    expect(agent.getConnectedClients()).toHaveLength(2);
    
    agent.shutdown();
    
    expect(agent.getConnectedClients()).toHaveLength(0);
  });
});

// Mock global WebSocket for testing
global.WebSocket = MockWebSocket as any;
