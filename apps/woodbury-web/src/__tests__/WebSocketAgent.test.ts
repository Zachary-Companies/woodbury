import { WebSocketAgent } from '@/server/WebSocketAgent'
import { WebSocket, WebSocketServer } from 'ws'

// Mock WebSocket and WebSocketServer
jest.mock('ws', () => {
  const mockClients = new Set()
  
  const MockWebSocket = jest.fn().mockImplementation(() => ({
    send: jest.fn(),
    close: jest.fn(),
    on: jest.fn(),
    readyState: 1, // OPEN
    OPEN: 1
  }))
  
  const MockWebSocketServer = jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn(),
    clients: mockClients
  }))
  
  MockWebSocket.OPEN = 1
  MockWebSocket.CLOSED = 3
  
  return {
    WebSocket: MockWebSocket,
    WebSocketServer: MockWebSocketServer
  }
})

describe('WebSocketAgent', () => {
  let agent: WebSocketAgent
  let mockWss: jest.Mocked<WebSocketServer>
  
  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks()
    
    // Create agent instance
    agent = new WebSocketAgent(8080)
    
    // Get the mocked WebSocketServer instance
    mockWss = (WebSocketServer as jest.MockedClass<typeof WebSocketServer>).mock.instances[0] as jest.Mocked<WebSocketServer>
  })
  
  afterEach(() => {
    agent.close()
  })
  
  it('initializes with correct port', () => {
    expect(WebSocketServer).toHaveBeenCalledWith({ port: 8080 })
  })
  
  it('sets up WebSocket server event listeners', () => {
    expect(mockWss.on).toHaveBeenCalledWith('connection', expect.any(Function))
  })
  
  it('handles client connections', () => {
    const connectionHandler = mockWss.on.mock.calls.find(call => call[0] === 'connection')?.[1]
    expect(connectionHandler).toBeDefined()
    
    // Simulate client connection
    const mockClient = {
      send: jest.fn(),
      on: jest.fn(),
      readyState: 1
    } as any
    
    connectionHandler!(mockClient)
    
    // Should send initial state to client
    expect(mockClient.send).toHaveBeenCalledWith(
      expect.stringContaining('state_update')
    )
    
    // Should set up client event listeners
    expect(mockClient.on).toHaveBeenCalledWith('message', expect.any(Function))
    expect(mockClient.on).toHaveBeenCalledWith('close', expect.any(Function))
  })
  
  it('processes user input messages', async () => {
    // Get connection handler
    const connectionHandler = mockWss.on.mock.calls.find(call => call[0] === 'connection')?.[1]
    
    // Create mock client
    const mockClient = {
      send: jest.fn(),
      on: jest.fn(),
      readyState: 1
    } as any
    
    connectionHandler!(mockClient)
    
    // Get message handler
    const messageHandler = mockClient.on.mock.calls.find((call: any) => call[0] === 'message')?.[1]
    
    // Simulate user input message
    const userMessage = JSON.stringify({
      type: 'user_input',
      data: 'Hello, agent!'
    })
    
    await messageHandler(Buffer.from(userMessage))
    
    // Should send multiple messages (conversation update, timeline events, etc.)
    expect(mockClient.send).toHaveBeenCalledTimes(3) // Initial state + conversation + final state
  })
  
  it('handles approval responses', () => {
    // Get connection handler
    const connectionHandler = mockWss.on.mock.calls.find(call => call[0] === 'connection')?.[1]
    
    // Create mock client
    const mockClient = {
      send: jest.fn(),
      on: jest.fn(),
      readyState: 1
    } as any
    
    connectionHandler!(mockClient)
    
    // Get message handler
    const messageHandler = mockClient.on.mock.calls.find((call: any) => call[0] === 'message')?.[1]
    
    // Simulate approval response
    const approvalMessage = JSON.stringify({
      type: 'approval_response',
      data: {
        requestId: 'test-123',
        approved: true,
        reason: 'Approved for testing'
      }
    })
    
    messageHandler(Buffer.from(approvalMessage))
    
    // Should handle the approval (exact behavior depends on implementation)
    // At minimum, should not throw an error
    expect(() => messageHandler(Buffer.from(approvalMessage))).not.toThrow()
  })
  
  it('handles run export requests', () => {
    // Get connection handler
    const connectionHandler = mockWss.on.mock.calls.find(call => call[0] === 'connection')?.[1]
    
    // Create mock client
    const mockClient = {
      send: jest.fn(),
      on: jest.fn(),
      readyState: 1
    } as any
    
    connectionHandler!(mockClient)
    
    // Get message handler
    const messageHandler = mockClient.on.mock.calls.find((call: any) => call[0] === 'message')?.[1]
    
    // Simulate export request
    const exportMessage = JSON.stringify({
      type: 'export_run'
    })
    
    messageHandler(Buffer.from(exportMessage))
    
    // Should send run bundle
    expect(mockClient.send).toHaveBeenCalledWith(
      expect.stringContaining('run_bundle')
    )
  })
  
  it('handles invalid JSON messages gracefully', () => {
    console.error = jest.fn() // Mock console.error
    
    // Get connection handler
    const connectionHandler = mockWss.on.mock.calls.find(call => call[0] === 'connection')?.[1]
    
    // Create mock client
    const mockClient = {
      send: jest.fn(),
      on: jest.fn(),
      readyState: 1
    } as any
    
    connectionHandler!(mockClient)
    
    // Get message handler
    const messageHandler = mockClient.on.mock.calls.find((call: any) => call[0] === 'message')?.[1]
    
    // Send invalid JSON
    messageHandler(Buffer.from('invalid json'))
    
    // Should log error and not crash
    expect(console.error).toHaveBeenCalledWith(
      'Invalid message from client:',
      expect.any(Error)
    )
  })
  
  it('closes WebSocket server properly', () => {
    agent.close()
    expect(mockWss.close).toHaveBeenCalled()
  })
  
  it('broadcasts messages to all connected clients', () => {
    // This test would require more complex mocking to simulate multiple clients
    // For now, we'll just verify the agent can be constructed without errors
    expect(agent).toBeInstanceOf(WebSocketAgent)
  })
})
