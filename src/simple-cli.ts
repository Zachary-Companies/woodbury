/**
 * Simple command line interface parsing for woodbury
 * Uses only standard Node.js modules
 */

export interface CliConfig {
  help?: boolean;
  version?: boolean;
  workingDirectory?: string;
  verbose?: boolean;
  interactive?: boolean;
}

export interface CliResult {
  task?: string;
  config: CliConfig;
}

/**
 * Parse command line arguments
 */
export function parseCli(argv: string[]): CliResult {
  const args = argv.slice(2); // Remove node and script path
  const config: CliConfig = {
    interactive: true
  };
  let task: string | undefined;
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    switch (arg) {
      case '--help':
      case '-h':
        config.help = true;
        break;
        
      case '--version':
      case '-v':
        config.version = true;
        break;
        
      case '--verbose':
        config.verbose = true;
        break;
        
      case '--non-interactive':
        config.interactive = false;
        break;
        
      case '--cwd':
      case '--working-directory':
        if (i + 1 < args.length) {
          config.workingDirectory = args[i + 1];
          i++; // Skip the next argument
        } else {
          console.error('❌ Error: --cwd requires a directory path');
          process.exit(1);
        }
        break;
        
      default:
        // If it doesn't start with '-', treat as task
        if (!arg.startsWith('-')) {
          if (task) {
            // Multiple tasks not supported, join them
            task = `${task} ${arg}`;
          } else {
            task = arg;
          }
        } else {
          console.error(`❌ Error: Unknown option: ${arg}`);
          console.error('💡 Use --help to see available options');
          process.exit(1);
        }
        break;
    }
  }
  
  return { task, config };
}

/**
 * Validate CLI configuration
 */
export function validateConfig(config: CliConfig): void {
  if (config.workingDirectory) {
    const fs = require('fs');
    const path = require('path');
    
    const resolvedPath = path.resolve(config.workingDirectory);
    
    try {
      if (!fs.existsSync(resolvedPath)) {
        console.error(`❌ Error: Working directory does not exist: ${resolvedPath}`);
        process.exit(1);
      }
      
      if (!fs.statSync(resolvedPath).isDirectory()) {
        console.error(`❌ Error: Working directory is not a directory: ${resolvedPath}`);
        process.exit(1);
      }
      
      // Update config with resolved path
      config.workingDirectory = resolvedPath;
    } catch (error) {
      console.error(`❌ Error: Cannot access working directory: ${resolvedPath}`);
      process.exit(1);
    }
  }
}