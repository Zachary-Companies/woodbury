import chalk from 'chalk';
import { SlashCommand, SlashCommandContext } from './types';
import { promises as fs } from 'fs';
import path from 'path';
import { discoverExtensions, parseEnvFile } from './extension-loader.js';
import { debugLog } from './debug-log.js';
import { discoverWorkflows } from './workflow/loader.js';
import { WorkflowRecorder } from './workflow/recorder.js';
import type { WorkflowStep } from './workflow/types.js';
import { getRoutes, addRoute, removeRoute, isHostsConfigured, GO_HOSTNAME } from './go-links.js';

// Module-level state for the active recorder (persists across slash command calls)
let activeRecorder: WorkflowRecorder | null = null;

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
          if (ctx.config.goLinksUrl) {
            ctx.print(chalk.blue('  Go-link: ') + `${GO_HOSTNAME}/config`);
          }
        }

        // Show go-links info
        if (ctx.config.goLinksUrl) {
          ctx.print('');
          ctx.print(chalk.green.bold('Go-Links'));
          ctx.print(chalk.blue('  Proxy: ') + ctx.config.goLinksUrl);
          const routes = getRoutes();
          const count = Object.keys(routes).length;
          ctx.print(chalk.blue('  Routes: ') + `${count} configured`);
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
        if (ctx.config.goLinksUrl) {
          ctx.print(chalk.green('  Go-link: ') + chalk.blue(`${GO_HOSTNAME}/config`));
        }
      } else {
        ctx.print(chalk.yellow('Config dashboard is not running.'));
        ctx.print(chalk.gray('  It starts automatically unless --no-extensions is used.'));
      }
    }
  },

  {
    name: 'go',
    description: 'Manage go-links (local URL shortcuts): /go [list|add|remove|setup]',
    async handler(args: string[], ctx: SlashCommandContext) {
      const sub = args[0]?.toLowerCase();

      if (!sub || sub === 'list') {
        // List all routes
        const routes = getRoutes();
        const entries = Object.entries(routes);
        if (entries.length === 0) {
          ctx.print(chalk.gray('No go-link routes configured.'));
          ctx.print(chalk.gray('  Routes are auto-registered when Woodbury starts.'));
          return;
        }
        const hostsOk = await isHostsConfigured();
        ctx.print(chalk.green.bold(`Go-Links (${entries.length}):`));
        ctx.print('');
        for (const [name, target] of entries.sort(([a], [b]) => a.localeCompare(b))) {
          const goUrl = hostsOk ? `${GO_HOSTNAME}/${name}` : `127.0.0.1:9000/${name}`;
          ctx.print(`  ${chalk.magenta(goUrl)} ${chalk.gray('→')} ${target}`);
        }
        if (!hostsOk) {
          ctx.print('');
          ctx.print(chalk.gray('  Tip: Run ') + chalk.cyan('woodbury go setup') + chalk.gray(` to enable ${GO_HOSTNAME}/ shorthand`));
        }
      } else if (sub === 'add') {
        const name = args[1];
        const url = args[2];
        if (!name || !url) {
          ctx.print(chalk.yellow('Usage: /go add <name> <url>'));
          return;
        }
        await addRoute(name, url);
        ctx.print(chalk.green(`Added ${GO_HOSTNAME}/${name} → ${url}`));
      } else if (sub === 'remove' || sub === 'rm') {
        const name = args[1];
        if (!name) {
          ctx.print(chalk.yellow('Usage: /go remove <name>'));
          return;
        }
        const removed = await removeRoute(name);
        if (removed) {
          ctx.print(chalk.green(`Removed ${GO_HOSTNAME}/${name}`));
        } else {
          ctx.print(chalk.yellow(`Route "${GO_HOSTNAME}/${name}" not found`));
        }
      } else if (sub === 'setup') {
        ctx.print(chalk.gray('Run this in your terminal to enable go-link shortcuts:'));
        ctx.print('');
        ctx.print(chalk.cyan('  woodbury go setup'));
        ctx.print('');
        ctx.print(chalk.gray(`This adds "127.0.0.1 ${GO_HOSTNAME}" to /etc/hosts and sets up port forwarding (requires sudo, one-time setup).`));
      } else {
        ctx.print(chalk.yellow('Usage: /go [list|add <name> <url>|remove <name>|setup]'));
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
  },

  {
    name: 'workflows',
    description: 'List available browser automation workflows',
    async handler(args: string[], ctx: SlashCommandContext) {
      try {
        const all = await discoverWorkflows(ctx.workingDirectory);

        if (all.length === 0) {
          ctx.print(chalk.yellow('No workflows found.'));
          ctx.print(chalk.gray('  Workflows are discovered from:'));
          ctx.print(chalk.gray('    ~/.woodbury/extensions/<name>/workflows/'));
          ctx.print(chalk.gray('    .woodbury-work/workflows/'));
          ctx.print(chalk.gray('    ~/.woodbury/workflows/'));
          ctx.print(chalk.gray('  Create a .workflow.json file to get started.'));
          ctx.print(chalk.gray('  Scaffold: woodbury ext create <name> --workflow'));
          return;
        }

        ctx.print(chalk.green(`Available workflows (${all.length}):`));

        for (const dw of all) {
          const wf = dw.workflow;
          const src = dw.source === 'extension'
            ? chalk.cyan(`ext:${dw.extensionName}`)
            : dw.source === 'project'
            ? chalk.yellow('project')
            : chalk.gray('global');

          ctx.print(chalk.blue(`  ${wf.name}`) + chalk.gray(` (${wf.id})`) + ` [${src}]`);
          ctx.print(chalk.gray(`    ${wf.description}`));
          ctx.print(chalk.gray(`    Site: ${wf.site} | Steps: ${wf.steps.length}`));

          if (wf.variables.length > 0) {
            const varList = wf.variables.map(v => {
              const req = v.required ? chalk.red('*') : ' ';
              return `${req}${v.name}`;
            }).join(', ');
            ctx.print(chalk.gray(`    Vars: ${varList}`));
          }
        }
      } catch (error) {
        ctx.print(chalk.red(`❌ Failed to discover workflows: ${error}`));
      }
    }
  },

  {
    name: 'record',
    description: 'Record browser interactions as a workflow',
    async handler(args: string[], ctx: SlashCommandContext) {
      const subcommand = args[0]?.toLowerCase();

      // /record (no args) — show help
      if (!subcommand) {
        ctx.print(chalk.green('Workflow recorder:'));
        ctx.print(chalk.blue('  /record <name> <site>') + chalk.gray(' - Start recording'));
        ctx.print(chalk.blue('  /record stop') + chalk.gray('            - Stop and save'));
        ctx.print(chalk.blue('  /record status') + chalk.gray('          - Show recording state'));
        ctx.print(chalk.blue('  /record pause') + chalk.gray('           - Pause recording'));
        ctx.print(chalk.blue('  /record resume') + chalk.gray('          - Resume recording'));
        ctx.print(chalk.blue('  /record cancel') + chalk.gray('          - Discard recording'));
        return;
      }

      // /record stop
      if (subcommand === 'stop') {
        if (!activeRecorder || !activeRecorder.isActive) {
          ctx.print(chalk.red('❌ No recording in progress.'));
          return;
        }
        try {
          const { workflow, filePath } = await activeRecorder.stop(ctx.workingDirectory);
          const duration = ((Date.now() - (workflow.metadata.createdAt ? new Date(workflow.metadata.createdAt).getTime() : 0)) / 1000).toFixed(1);
          ctx.print(chalk.green(`✅ Recording saved!`));
          ctx.print(chalk.blue('  Steps: ') + workflow.steps.length);
          ctx.print(chalk.blue('  File:  ') + filePath);

          // Show smart wait stats
          const smartWaits = workflow.steps.filter(
            (s: any) => s.type === 'wait' && s.condition?.type !== 'delay'
          );
          if (smartWaits.length > 0) {
            ctx.print('');
            ctx.print(chalk.green(`  Smart waits (${smartWaits.length}):`));
            for (const w of smartWaits) {
              const wait = w as any;
              const condType = wait.condition?.type || 'unknown';
              const label = wait.label || condType;
              ctx.print(`    🧠 ${chalk.cyan(label)}`);
            }
          }

          // Show detected variables
          if (workflow.variables.length > 0) {
            ctx.print('');
            ctx.print(chalk.green(`  Variables detected (${workflow.variables.length}):`));
            for (const v of workflow.variables) {
              const req = v.required ? chalk.red('*') : ' ';
              const def = v.default ? chalk.gray(` (default: "${truncateStr(String(v.default), 25)}")`) : '';
              ctx.print(`    ${req}${chalk.blue(v.name)}: ${chalk.gray(v.description)}${def}`);
            }
          }

          ctx.print('');
          ctx.print(chalk.gray('  Next steps:'));
          if (workflow.variables.length > 0) {
            ctx.print(chalk.gray('    1. Review detected variables in the JSON file'));
            ctx.print(chalk.gray('    2. Rename variables if needed (e.g., {{text_input}} → {{lyrics}})'));
            ctx.print(chalk.gray('    3. Test with: workflow_play tool or /workflows'));
          } else {
            ctx.print(chalk.gray('    1. Edit the file to add {{variables}} for dynamic values'));
            ctx.print(chalk.gray('    2. Test with: workflow_play tool or /workflows'));
          }
          activeRecorder = null;
        } catch (error) {
          ctx.print(chalk.red(`❌ Failed to stop recording: ${error}`));
        }
        return;
      }

      // /record status
      if (subcommand === 'status') {
        if (!activeRecorder || !activeRecorder.isActive) {
          ctx.print(chalk.gray('No recording in progress.'));
          return;
        }
        const status = activeRecorder.getStatus();
        const duration = (status.durationMs / 1000).toFixed(0);
        ctx.print(chalk.green('Recording active'));
        ctx.print(chalk.blue('  Site:   ') + status.site);
        ctx.print(chalk.blue('  Steps:  ') + status.stepCount);
        ctx.print(chalk.blue('  Time:   ') + `${duration}s`);
        ctx.print(chalk.blue('  Paused: ') + (status.paused ? chalk.yellow('yes') : 'no'));
        return;
      }

      // /record pause
      if (subcommand === 'pause') {
        if (!activeRecorder || !activeRecorder.isActive) {
          ctx.print(chalk.red('❌ No recording in progress.'));
          return;
        }
        activeRecorder.pause();
        ctx.print(chalk.yellow('⏸  Recording paused. Use /record resume to continue.'));
        return;
      }

      // /record resume
      if (subcommand === 'resume') {
        if (!activeRecorder || !activeRecorder.isActive) {
          ctx.print(chalk.red('❌ No recording in progress.'));
          return;
        }
        activeRecorder.resume();
        ctx.print(chalk.green('▶  Recording resumed.'));
        return;
      }

      // /record cancel
      if (subcommand === 'cancel') {
        if (!activeRecorder || !activeRecorder.isActive) {
          ctx.print(chalk.red('❌ No recording in progress.'));
          return;
        }
        try {
          await activeRecorder.cancel();
        } catch {
          // Ignore errors during cancel
        }
        activeRecorder = null;
        ctx.print(chalk.yellow('Recording cancelled. No file saved.'));
        return;
      }

      // /record <name> <site> — start recording
      const name = subcommand;
      const site = args[1];

      if (!site) {
        ctx.print(chalk.red('❌ Usage: /record <name> <site>'));
        ctx.print(chalk.gray('  Example: /record create-song suno.com'));
        return;
      }

      if (activeRecorder?.isActive) {
        ctx.print(chalk.red('❌ Recording already in progress. Use /record stop or /record cancel first.'));
        return;
      }

      try {
        activeRecorder = new WorkflowRecorder(
          // Step capture callback — live output
          (step: WorkflowStep, index: number) => {
            const num = chalk.blue(`[${index}]`);
            const type = chalk.green(step.type);
            let detail = '';

            if (step.type === 'click') {
              const text = step.target.textContent || step.target.selector;
              detail = chalk.gray(truncateStr(text, 40));
            } else if (step.type === 'type') {
              detail = chalk.gray(`"${truncateStr(step.value, 25)}"`);
            } else if (step.type === 'keyboard') {
              const mods = step.modifiers ? step.modifiers.join('+') + '+' : '';
              detail = chalk.gray(mods + step.key);
            } else if (step.type === 'navigate') {
              detail = chalk.gray(truncateStr(step.url, 50));
            } else if (step.type === 'wait') {
              if (step.condition.type === 'delay') {
                detail = chalk.gray(`${(step.condition.ms / 1000).toFixed(1)}s`);
              }
            }

            ctx.print(`  ● ${num} ${type} → ${detail}`);
          },
          // Status callback — progress messages during startup
          (message: string) => {
            ctx.print(chalk.gray(`  ${message}`));
          }
        );

        await activeRecorder.start(name, site);

        ctx.print(chalk.green(`🔴 Recording started: ${name}`));
        ctx.print(chalk.blue(`  Site: `) + site);
        ctx.print('');
        ctx.print(chalk.gray('  Interact with Chrome — actions will be captured here.'));
        ctx.print(chalk.gray('  When done, use /record stop to save.'));
        ctx.print('');
      } catch (error) {
        activeRecorder = null;
        ctx.print(chalk.red(`❌ Failed to start recording: ${error}`));
      }
    }
  },

  {
    name: 'remote',
    description: 'Show remote control status and pairing info',
    async handler(_args: string[], ctx: SlashCommandContext) {
      const handle = ctx.dashboardHandle;
      if (!handle || !ctx.config.remoteUrl) {
        ctx.print(chalk.yellow('Remote relay is not running.'));
        ctx.print(chalk.gray('  The relay starts automatically with the dashboard.'));
        ctx.print(chalk.gray('  Check that you are not using --no-extensions.'));
        return;
      }

      ctx.print('');
      ctx.print(chalk.green('🌐 Remote Control'));
      ctx.print('');

      if (handle.isPaired && handle.isPaired()) {
        ctx.print(chalk.green('  ✅ Paired with a remote user'));
        ctx.print(chalk.gray('  The remote user can access this instance from their phone.'));
        ctx.print(chalk.gray('  They just need to log into https://woobury-ai.web.app'));
      } else {
        ctx.print(chalk.yellow('  ⏳ Not yet paired'));
        ctx.print(chalk.gray('  To connect a phone:'));
        ctx.print(chalk.gray('    1. Open https://woobury-ai.web.app on your phone'));
        ctx.print(chalk.gray('    2. Sign in with Google'));
        ctx.print(chalk.gray('    3. Tap "Generate Pairing Code"'));
        ctx.print(chalk.gray('    4. Type /pair <code> here in the terminal'));
      }

      ctx.print('');
      ctx.print(chalk.gray(`  Connection URL (advanced): ${ctx.config.remoteUrl}`));
      ctx.print('');
    }
  },

  {
    name: 'pair',
    description: 'Pair with a remote phone using a 4-digit code',
    async handler(args: string[], ctx: SlashCommandContext) {
      const handle = ctx.dashboardHandle;
      if (!handle || !handle.pair) {
        ctx.print(chalk.yellow('Remote relay is not running.'));
        ctx.print(chalk.gray('  The relay starts automatically with the dashboard.'));
        return;
      }

      const code = args[0]?.trim();
      if (!code || !/^\d{4}$/.test(code)) {
        ctx.print(chalk.yellow('Usage: /pair <4-digit-code>'));
        ctx.print('');
        ctx.print(chalk.gray('  To get a code:'));
        ctx.print(chalk.gray('    1. Open https://woobury-ai.web.app on your phone'));
        ctx.print(chalk.gray('    2. Sign in with Google'));
        ctx.print(chalk.gray('    3. Tap "Generate Pairing Code"'));
        ctx.print(chalk.gray('    4. Type /pair <code> here'));
        return;
      }

      ctx.print(chalk.gray(`  Pairing with code ${code}...`));

      try {
        const success = await handle.pair(code);
        if (success) {
          ctx.print(chalk.green('  ✅ Paired successfully!'));
          ctx.print(chalk.gray('  The remote user can now control this instance from their phone.'));
        } else {
          ctx.print(chalk.red('  ❌ Pairing failed.'));
          ctx.print(chalk.gray('  The code may be invalid, expired, or already used.'));
          ctx.print(chalk.gray('  Generate a new code on the phone and try again.'));
        }
      } catch (err) {
        ctx.print(chalk.red(`  ❌ Pairing error: ${err}`));
      }
    }
  }
];

function truncateStr(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}
