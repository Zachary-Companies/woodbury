import { WoodburyLogger } from './logger';

/**
 * Enhanced signal handler for woodbury CLI
 * Ensures reliable Ctrl+C (SIGINT) exit behavior
 */
export class SignalHandler {
  private static instance: SignalHandler;
  private sigintCount = 0;
  private isShuttingDown = false;
  private readonly maxSigintCount = 2;
  private shutdownTimeout: NodeJS.Timeout | null = null;
  private logger: WoodburyLogger;
  
  private constructor() {
    this.logger = new WoodburyLogger(false);
  }
  
  static getInstance(): SignalHandler {
    if (!SignalHandler.instance) {
      SignalHandler.instance = new SignalHandler();
    }
    return SignalHandler.instance;
  }
  
  /**
   * Set up signal handlers for graceful shutdown
   */
  setupHandlers(): void {
    // Handle SIGINT (Ctrl+C)
    process.on('SIGINT', this.handleSigint.bind(this));
    
    // Handle SIGTERM (termination request)
    process.on('SIGTERM', this.handleSigterm.bind(this));
    
    // Handle uncaught exceptions
    process.on('uncaughtException', this.handleUncaughtException.bind(this));
    
    // Handle unhandled promise rejections
    process.on('unhandledRejection', this.handleUnhandledRejection.bind(this));
  }
  
  private handleSigint(): void {
    this.sigintCount++;
    
    if (this.isShuttingDown) {
      // Already shutting down, force exit on second Ctrl+C
      if (this.sigintCount >= this.maxSigintCount) {
        console.log('\n⚡ Force exit!');
        if (this.shutdownTimeout) {
          clearTimeout(this.shutdownTimeout);
        }
        process.exit(1);
      }
      return;
    }
    
    this.isShuttingDown = true;
    
    // First Ctrl+C - graceful shutdown
    console.log('\n🛑 Received interrupt signal (Ctrl+C).');
    console.log('💡 Shutting down gracefully... Press Ctrl+C again to force exit.');
    
    // Reset SIGINT counter after 2 seconds
    this.shutdownTimeout = setTimeout(() => {
      this.sigintCount = 0;
      this.isShuttingDown = false;
    }, 2000);
    
    // Attempt graceful shutdown
    this.gracefulShutdown()
      .then(() => {
        console.log('✅ Goodbye!');
        process.exit(0);
      })
      .catch((error) => {
        this.logger.error('Error during graceful shutdown', error);
        process.exit(1);
      });
  }
  
  private handleSigterm(): void {
    console.log('\n📡 Received termination signal. Shutting down...');
    this.gracefulShutdown()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  }
  
  private handleUncaughtException(error: Error): void {
    this.logger.error('Uncaught exception', error);
    console.error('\n💥 Uncaught exception occurred. Exiting...');
    this.gracefulShutdown()
      .then(() => process.exit(1))
      .catch(() => process.exit(1));
  }
  
  private handleUnhandledRejection(reason: any, promise: Promise<any>): void {
    this.logger.error('Unhandled promise rejection', reason);
    // Don't exit on unhandled rejection, just log it
  }
  
  /**
   * Perform graceful shutdown operations
   */
  private async gracefulShutdown(): Promise<void> {
    try {
      // Close any open resources, save state, etc.
      // For now, just a small delay to allow any pending operations
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    } catch (error) {
      throw error;
    }
  }
  
  /**
   * Reset the signal handler state
   * Useful for testing
   */
  reset(): void {
    this.sigintCount = 0;
    this.isShuttingDown = false;
    if (this.shutdownTimeout) {
      clearTimeout(this.shutdownTimeout);
      this.shutdownTimeout = null;
    }
  }
}

/**
 * Setup SIGINT handler for simple use cases
 * @param rl Optional readline interface to cleanup
 */
export function setupSIGINTHandler(rl?: any): void {
  const handler = SignalHandler.getInstance();
  handler.setupHandlers();
  
  // If readline interface provided, close it on shutdown
  if (rl) {
    const originalGracefulShutdown = (handler as any).gracefulShutdown.bind(handler);
    (handler as any).gracefulShutdown = async () => {
      try {
        rl.removeAllListeners();
        rl.close();
      } catch (e) {
        // Ignore errors closing readline
      }
      return originalGracefulShutdown();
    };
  }
}
