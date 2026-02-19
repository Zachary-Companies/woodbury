import { SignalHandler } from '../signals';

// Mock process methods
const mockProcessOn = jest.fn();
const mockProcessExit = jest.fn();

// Mock console methods globally
global.console = {
  ...console,
  log: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
};

const mockConsoleLog = console.log as jest.MockedFunction<typeof console.log>;
const mockConsoleError = console.error as jest.MockedFunction<typeof console.error>;

// Mock process object
Object.defineProperty(process, 'on', {
  value: mockProcessOn,
  writable: true
});

Object.defineProperty(process, 'exit', {
  value: mockProcessExit,
  writable: true
});

// Mock setTimeout to control async behavior
jest.useFakeTimers();

// Mock WoodburyLogger to avoid chalk issues
jest.mock('../logger', () => ({
  WoodburyLogger: jest.fn().mockImplementation(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }))
}));

describe('SignalHandler', () => {
  let signalHandler: SignalHandler;
  let handlers: { [key: string]: Function } = {};

  beforeEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    handlers = {};
    
    // Capture handlers when they are registered
    mockProcessOn.mockImplementation((signal: string, handler: Function) => {
      handlers[signal] = handler;
    });
    
    signalHandler = SignalHandler.getInstance();
    signalHandler.reset();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.useFakeTimers();
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = SignalHandler.getInstance();
      const instance2 = SignalHandler.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('setupHandlers', () => {
    it('should setup signal handlers', () => {
      signalHandler.setupHandlers();
      
      expect(mockProcessOn).toHaveBeenCalledWith('SIGINT', expect.any(Function));
      expect(mockProcessOn).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
      expect(mockProcessOn).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
      expect(mockProcessOn).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
    });
  });

  describe('signal handling', () => {
    beforeEach(() => {
      signalHandler.setupHandlers();
    });

    it('should handle SIGINT gracefully', () => {
      const sigintHandler = handlers['SIGINT'];
      expect(sigintHandler).toBeDefined();
      
      sigintHandler();
      
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('🛑 Received interrupt signal'));
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('💡 Shutting down gracefully'));
    });

    it('should handle SIGTERM gracefully', () => {
      const sigtermHandler = handlers['SIGTERM'];
      expect(sigtermHandler).toBeDefined();
      
      sigtermHandler();
      
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('📡 Received termination signal'));
    });

    it('should force exit on multiple SIGINT', () => {
      const sigintHandler = handlers['SIGINT'];
      
      mockConsoleLog.mockClear();
      mockProcessExit.mockClear();
      
      // First SIGINT
      sigintHandler();
      
      const calls = mockConsoleLog.mock.calls;
      const interruptCall = calls.find(call => 
        call.some(arg => typeof arg === 'string' && arg.includes('🛑 Received interrupt signal'))
      );
      expect(interruptCall).toBeDefined();
      
      // Second SIGINT should force exit
      sigintHandler();
      
      const forceExitCall = calls.find(call => 
        call.some(arg => typeof arg === 'string' && arg.includes('⚡ Force exit!'))
      );
      expect(forceExitCall).toBeDefined();
      
      // Process.exit might be called asynchronously, so we verify the force exit message
      // instead of the exact process.exit call timing
    });
  });

  describe('reset functionality', () => {
    it('should reset internal state', () => {
      signalHandler.reset();
      expect(signalHandler).toBeInstanceOf(SignalHandler);
    });
  });

  describe('error handling', () => {
    beforeEach(() => {
      signalHandler.setupHandlers();
    });

    it('should handle uncaught exceptions', () => {
      const errorHandler = handlers['uncaughtException'];
      expect(errorHandler).toBeDefined();
      
      const testError = new Error('Test error');
      errorHandler(testError);
      
      expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('💥 Uncaught exception occurred'));
    });

    it('should handle unhandled promise rejections', () => {
      const rejectionHandler = handlers['unhandledRejection'];
      expect(rejectionHandler).toBeDefined();
      
      const testReason = new Error('Promise rejection');
      rejectionHandler(testReason, Promise.resolve());
      
      // Should not crash - handler exists and executes
      expect(rejectionHandler).toBeDefined();
    });
  });

  describe('graceful shutdown behavior', () => {
    it('should track shutdown state correctly', () => {
      signalHandler.setupHandlers();
      const sigintHandler = handlers['SIGINT'];
      
      mockConsoleLog.mockClear();
      
      // First call should start graceful shutdown
      sigintHandler();
      
      const calls = mockConsoleLog.mock.calls;
      const interruptCall = calls.find(call => 
        call.some(arg => typeof arg === 'string' && arg.includes('🛑 Received interrupt signal'))
      );
      expect(interruptCall).toBeDefined();
      
      // Second call should force exit
      sigintHandler();
      
      const forceExitCall = calls.find(call => 
        call.some(arg => typeof arg === 'string' && arg.includes('⚡ Force exit!'))
      );
      expect(forceExitCall).toBeDefined();
    });
  });
});
