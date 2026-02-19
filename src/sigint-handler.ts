import readline from 'readline';

/**
 * SIGINT handling state
 */
let sigintCount = 0;
let sigintTimeout: NodeJS.Timeout | null = null;
let isShuttingDown = false;

/**
 * Setup enhanced SIGINT (Ctrl+C) handling for woodbury CLI
 * 
 * Features:
 * - First Ctrl+C: Graceful exit with cleanup
 * - Second Ctrl+C (within 2 seconds): Force exit
 * - Proper readline interface cleanup
 * - Clear user messaging
 * 
 * @param rl - Optional readline interface to cleanup
 */
export function setupSIGINTHandler(rl?: readline.Interface): void {
  process.on('SIGINT', () => {
    sigintCount++;
    
    if (sigintCount === 1) {
      console.log('\n🛑 Interrupted! Exiting gracefully...');
      console.log('💡 Press Ctrl+C again to force exit.');
      
      isShuttingDown = true;
      
      // Cleanup readline interface if provided
      if (rl) {
        rl.removeAllListeners();
        rl.close();
      }
      
      // Graceful exit after brief delay for cleanup
      setTimeout(() => {
        console.log('👋 Goodbye!');
        process.exit(0);
      }, 100);
      
      // Reset SIGINT count after 2 seconds
      sigintTimeout = setTimeout(() => {
        if (!isShuttingDown) {
          sigintCount = 0;
        }
      }, 2000);
      
    } else {
      // Force exit on second Ctrl+C
      console.log('\n⚡ Force exit!');
      
      // Clear any pending timeout
      if (sigintTimeout) {
        clearTimeout(sigintTimeout);
      }
      
      // Immediate force exit
      process.exit(1);
    }
  });
}

/**
 * Get current SIGINT handling state (for testing)
 */
export function getSIGINTState() {
  return {
    sigintCount,
    isShuttingDown
  };
}

/**
 * Reset SIGINT state (for testing)
 */
export function resetSIGINTState() {
  sigintCount = 0;
  isShuttingDown = false;
  if (sigintTimeout) {
    clearTimeout(sigintTimeout);
    sigintTimeout = null;
  }
}

/**
 * Setup process-level error handlers
 */
export function setupProcessHandlers(): void {
  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    console.error('\n❌ Unhandled Promise Rejection:');
    console.error('Promise:', promise);
    console.error('Reason:', reason);
    console.error('\nExiting...');
    process.exit(1);
  });
  
  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    console.error('\n💥 Uncaught Exception:');
    console.error(error);
    console.error('\nExiting...');
    process.exit(1);
  });
  
  // Handle SIGTERM (Docker/systemd graceful shutdown)
  process.on('SIGTERM', () => {
    console.log('\n📡 Received SIGTERM. Shutting down gracefully...');
    process.exit(0);
  });
}