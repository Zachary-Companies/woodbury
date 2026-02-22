import chalk from 'chalk';
import { SlashCommand, SlashCommandContext } from './types';
import { promises as fs } from 'fs';
import path from 'path';
import { discoverExtensions, parseEnvFile } from './extension-loader.js';
import { debugLog } from './debug-log.js';

export { type SlashCommand, type SlashCommandContext } from './types';

export const slashCommands: SlashCommand[] = [
  {
    name: 'help',
    description: 'Show available commands',
    async handler(_args: string[], ctx: SlashCommandContext) {
      ctx.print(chalk.green('Available commands:'));
      for (const cmd of slashCommands) {
        ctx.print(chalk.blue(`  /${cmd.name}`) + chalk.gray(` - ${cmd.description}`));
      }
    }
  },
  
  {
    name: 'quit',
    description: 'Exit the interactive session',
    async handler(_args: string[], ctx: SlashCommandContext) {
      ctx.print(chalk.gray('Goodbye! 👋'));
      if (ctx.agent) {
        await ctx.agent.stop();
      }
      process.exit(0);
    }
  },
  
  {
    name: 'clear',
    description: 'Clear the conversation history',
    async handler(args: string[], ctx: SlashCommandContext) {
      try {
        // Clear any persistent conversation files
        const conversationFile = path.join(ctx.workingDirectory, '.woodbury-conversation.json');
        try {
          await fs.unlink(conversationFile);
          ctx.print(chalk.green('✅ Conversation history cleared'));
        } catch (error) {
          // File might not exist, which is fine
          ctx.print(chalk.green('✅ Conversation history cleared'));
        }
      } catch (error) {
        ctx.print(chalk.red('❌ Failed to clear conversation history'));
      }
    }
  },
  
  {
    name: 'status',
    description: 'Show current status and configuration',
    async handler(_args: string[], ctx: SlashCommandContext) {
      ctx.print(chalk.green('Woodbury Status:'));
      ctx.print(chalk.blue('  Working Directory: ') + ctx.workingDirectory);
      ctx.print(chalk.blue('  Model: ') + (ctx.config.model || 'default'));
      ctx.print(chalk.blue('  Verbose: ') + (ctx.config.verbose ? 'enabled' : 'disabled'));
      
      if (ctx.agent) {
        const tools = ctx.agent.getTools();
        ctx.print(chalk.blue('  Available Tools: ') + tools.length);
        if (ctx.config.verbose) {
          ctx.print(chalk.gray('    ' + tools.join(', ')));
        }
      }
    }
  },
  
  {
    name: 'tools',
    description: 'List available tools',
    async handler(_args: string[], ctx: SlashCommandContext) {
      if (!ctx.agent) {
        ctx.print(chalk.red('❌ No agent available'));
        return;
      }
      
      const tools = ctx.agent.getTools();
      ctx.print(chalk.green(`Available tools (${tools.length}):`));
      tools.forEach((tool: string) => {
        ctx.print(chalk.blue(`  • ${tool}`));
      });
    }
  },
  
  {
    name: 'config', 
    description: 'Show configuration details including extensions',
    async handler(args: string[], ctx: SlashCommandContext) {
      if (args.length > 0 && args[0] === '--json') {
        // Show full config as JSON (but mask API keys)
        const safeConfig = { ...ctx.config };
        if (safeConfig.apiKeys) {
          safeConfig.apiKeys = {
            openai: safeConfig.apiKeys.openai ? '[REDACTED]' : undefined,
            anthropic: safeConfig.apiKeys.anthropic ? '[REDACTED]' : undefined,
            groq: safeConfig.apiKeys.groq ? '[REDACTED]' : undefined
          };
        }
        ctx.print(JSON.stringify(safeConfig, null, 2));
      } else {
        // Show human-readable config
        ctx.print(chalk.green.bold('Configuration'));
        ctx.print('');
        ctx.print(chalk.blue('  Model: ') + (ctx.config.model || 'default'));
        ctx.print(chalk.blue('  Working Directory: ') + ctx.workingDirectory);
        ctx.print(chalk.blue('  Verbose: ') + (ctx.config.verbose ? 'enabled' : 'disabled'));
        ctx.print(chalk.blue('  Safe Mode: ') + (ctx.config.safe ? 'enabled' : 'disabled'));
        ctx.print(chalk.blue('  Max Iterations: ') + (ctx.config.maxIterations || 'default'));
        ctx.print(chalk.blue('  Timeout: ') + (ctx.config.timeout || 'default') + 'ms');
        
        // Show which API keys are configured
        if (ctx.config.apiKeys) {
          const configuredKeys = Object.entries(ctx.config.apiKeys)
            .filter(([, value]) => value)
            .map(([key]) => key);
          ctx.print(chalk.blue('  API Keys: ') + (configuredKeys.length > 0 ? configuredKeys.join(', ') : 'none'));
        }

        // Show dashboard URL if available
        if (ctx.config.dashboardUrl) {
          ctx.print('');
          ctx.print(chalk.green.bold('Config Dashboard'));
          ctx.print(chalk.blue('  URL: ') + ctx.config.dashboardUrl);
        }

        // Show extensions and their env var status
        ctx.print('');
        ctx.print(chalk.green.bold('Extensions'));
        
        try {
          const manifests = await discoverExtensions();
          
          if (manifests.length === 0) {
            ctx.print(chalk.gray('  No extensions installed.'));
            ctx.print(chalk.gray('  Install: woodbury ext install <package-name>'));
            ctx.print(chalk.gray('  Create:  woodbury ext create <name>'));
          } else {
            for (const m of manifests) {
              // Check env var status for this extension
              let envStatus = '';
              const declKeys = Object.keys(m.envDeclarations);
              
              if (declKeys.length > 0) {
                // Read extension's .env file
                let currentEnv: Record<string, string> = {};
                try {
                  const envContent = await fs.readFile(path.join(m.directory, '.env'), 'utf-8');
                  currentEnv = parseEnvFile(envContent);
                } catch {
                  // No .env file
                }
                
                const setCount = declKeys.filter(k => !!currentEnv[k]).length;
                const requiredMissing = declKeys.filter(k => m.envDeclarations[k].required && !currentEnv[k]);
                
                if (requiredMissing.length > 0) {
                  envStatus = chalk.red(` [${requiredMissing.length} missing]`);
                } else if (setCount === declKeys.length) {
                  envStatus = chalk.green(' [all keys set]');
                } else {
                  envStatus = chalk.yellow(` [${setCount}/${declKeys.length} set]`);
                }
              }
              
              ctx.print(chalk.blue(`  ${m.displayName}`) + chalk.gray(` v${m.version}`) + envStatus);
              
              // Show provides
              if (m.provides.length > 0) {
                ctx.print(chalk.gray(`    Provides: ${m.provides.join(', ')}`));
              }
              
              // Show env vars if any
              if (declKeys.length > 0) {
                // Read extension's .env file again for detailed status
                let currentEnv: Record<string, string> = {};
                try {
                  const envContent = await fs.readFile(path.join(m.directory, '.env'), 'utf-8');
                  currentEnv = parseEnvFile(envContent);
                } catch {
                  // No .env file
                }
                
                for (const key of declKeys) {
                  const decl = m.envDeclarations[key];
                  const isSet = !!currentEnv[key];
                  const reqLabel = decl.required ? chalk.red('[required]') : chalk.gray('[optional]');
                  const statusIcon = isSet ? chalk.green('✓') : (decl.required ? chalk.red('✗') : chalk.yellow('○'));
                  ctx.print(chalk.gray(`    ${statusIcon} ${key} ${reqLabel}`));
                }
              }
            }
            
            ctx.print('');
            ctx.print(chalk.gray('  Configure: woodbury ext configure <name>'));
            if (ctx.config.dashboardUrl) {
              ctx.print(chalk.gray('  Dashboard: ') + ctx.config.dashboardUrl);
            }
          }
        } catch (error) {
          ctx.print(chalk.red(`  Failed to load extensions: ${error}`));
        }
      }
    }
  },
  
  {
    name: 'memory',
    description: 'Memory management commands',
    async handler(_args: string[], ctx: SlashCommandContext) {
      ctx.print(chalk.green('Memory commands:'));
      ctx.print(chalk.blue('  /memory search <query>') + chalk.gray(' - Search memory'));
      ctx.print(chalk.blue('  /memory clear') + chalk.gray(' - Clear all memories'));
      ctx.print(chalk.blue('  /memory list') + chalk.gray(' - List recent memories'));
    }
  },
  
  {
    name: 'version',
    description: 'Show version information', 
    async handler(_args: string[], ctx: SlashCommandContext) {
      try {
        const packageJson = await fs.readFile(path.join(__dirname, '..', 'package.json'), 'utf-8');
        const pkg = JSON.parse(packageJson);
        ctx.print(chalk.green('Woodbury ') + chalk.blue(`v${pkg.version}`));
        
        // Show agentic-loop version
        ctx.print(chalk.gray('agentic-loop (embedded)'));
      } catch (error) {
        ctx.print(chalk.red('❌ Could not read version information'));
      }
    }
  },
  
  {
    name: 'save',
    description: 'Save current conversation',
    async handler(args: string[], ctx: SlashCommandContext) {
      const filename = args[0] || `woodbury-conversation-${Date.now()}.json`;
      const filepath = path.join(ctx.workingDirectory, filename);
      
      try {
        // For now, just create a placeholder file
        const conversationData = {
          timestamp: new Date().toISOString(),
          workingDirectory: ctx.workingDirectory,
          config: {
            model: ctx.config.model,
            verbose: ctx.config.verbose
          },
          // In a full implementation, this would contain the actual conversation
          turns: []
        };
        
        await fs.writeFile(filepath, JSON.stringify(conversationData, null, 2));
        ctx.print(chalk.green(`✅ Conversation saved to ${filename}`));
      } catch (error) {
        ctx.print(chalk.red(`❌ Failed to save conversation: ${error}`));
      }
    }
  },
  
  {
    name: 'extensions',
    description: 'List loaded extensions',
    async handler(_args: string[], ctx: SlashCommandContext) {
      const manager = ctx.extensionManager;
      if (!manager) {
        ctx.print(chalk.yellow('Extension system not initialized.'));
        ctx.print(chalk.gray('  Extensions are loaded on startup from ~/.woodbury/extensions/'));
        return;
      }

      const summaries = manager.getExtensionSummaries();
      if (summaries.length === 0) {
        ctx.print(chalk.yellow('No extensions loaded.'));
        ctx.print(chalk.gray('  Install: woodbury ext install <package-name>'));
        ctx.print(chalk.gray('  Create:  woodbury ext create <name>'));
        ctx.print(chalk.gray('  Local:   ~/.woodbury/extensions/<name>/'));
        return;
      }

      ctx.print(chalk.green(`Loaded extensions (${summaries.length}):`));
      for (const s of summaries) {
        ctx.print(chalk.blue(`  ${s.displayName}`) + chalk.gray(` v${s.version} [${s.source}]`));
        const parts: string[] = [];
        if (s.tools > 0) parts.push(`${s.tools} tool(s)`);
        if (s.commands > 0) parts.push(`${s.commands} command(s)`);
        if (s.hasPrompt) parts.push('prompt');
        if (s.webUIs.length > 0) parts.push(`web: ${s.webUIs.join(', ')}`);
        if (parts.length > 0) {
          ctx.print(chalk.gray(`    ${parts.join(' | ')}`));
        }
      }
    }
  },

  {
    name: 'dashboard',
    description: 'Show config dashboard URL',
    async handler(_args: string[], ctx: SlashCommandContext) {
      if (ctx.config.dashboardUrl) {
        ctx.print(chalk.green('Config dashboard: ') + chalk.blue(ctx.config.dashboardUrl));
      } else {
        ctx.print(chalk.yellow('Config dashboard is not running.'));
        ctx.print(chalk.gray('  It starts automatically unless --no-extensions is used.'));
      }
    }
  },

  {
    name: 'log',
    description: 'Show debug log file path and recent entries',
    async handler(args: string[], ctx: SlashCommandContext) {
      if (!debugLog.isEnabled) {
        ctx.print(chalk.yellow('Debug logging is not enabled.'));
        ctx.print(chalk.gray('  Start with: woodbury --debug'));
        ctx.print(chalk.gray('  Or set:     WOODBURY_DEBUG=1'));
        return;
      }

      ctx.print(chalk.green.bold('Debug Log'));
      ctx.print(chalk.blue('  File: ') + debugLog.filePath);
      ctx.print(chalk.blue('  Dir:  ') + debugLog.logsDir);
      ctx.print('');

      // Show the tail of the log file
      const tailLines = parseInt(args[0]) || 20;
      try {
        const content = await fs.readFile(debugLog.filePath, 'utf-8');
        const lines = content.split('\n');
        const tail = lines.slice(-tailLines).join('\n');
        ctx.print(chalk.gray(`  Last ${Math.min(tailLines, lines.length)} lines:`));
        ctx.print(chalk.gray('  ' + '─'.repeat(50)));
        for (const line of tail.split('\n')) {
          // Colorize log levels
          let colored = line;
          if (line.includes(' ERROR ')) colored = chalk.red(line);
          else if (line.includes(' WARN  ')) colored = chalk.yellow(line);
          else if (line.includes(' INFO  ')) colored = chalk.gray(line);
          else if (line.includes(' DEBUG ')) colored = chalk.dim(line);
          else colored = chalk.gray(line);
          ctx.print('  ' + colored);
        }
      } catch (err) {
        ctx.print(chalk.red(`  Could not read log file: ${err}`));
      }
    }
  },

  {
    name: 'load',
    description: 'Load a saved conversation',
    async handler(args: string[], ctx: SlashCommandContext) {
      if (args.length === 0) {
        ctx.print(chalk.red('❌ Please specify a filename: /load <filename>'));
        return;
      }
      
      const filename = args[0];
      const filepath = path.join(ctx.workingDirectory, filename);
      
      try {
        const data = await fs.readFile(filepath, 'utf-8');
        const conversationData = JSON.parse(data);
        
        ctx.print(chalk.green(`✅ Loaded conversation from ${filename}`));
        ctx.print(chalk.gray(`  Saved: ${conversationData.timestamp}`));
        ctx.print(chalk.gray(`  Turns: ${conversationData.turns?.length || 0}`));
      } catch (error) {
        ctx.print(chalk.red(`❌ Failed to load conversation: ${error}`));
      }
    }
  }
];
