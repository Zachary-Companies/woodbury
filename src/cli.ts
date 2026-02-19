#!/usr/bin/env node

import { Command } from 'commander';
import type { WoodburyConfig } from './types';
import { startRepl } from './repl';
import { runOneShot } from './one-shot';
import { orchestrateJobs } from './orchestrate';
import { WoodburyLogger } from './logger';
import { colors, icons, labels } from './colors';
import path from 'path';
import { existsSync, promises as fs } from 'fs';
import { homedir } from 'os';
import { ExtensionManager } from './extension-manager.js';
import { EXTENSIONS_DIR, discoverExtensions } from './extension-loader.js';
import { scaffoldExtension } from './extension-scaffold.js';

const program = new Command();

// Read package.json for version
let version = '1.0.0';
try {
  const packageJson = require('../package.json');
  version = packageJson.version;
} catch {
  // Fallback version
}

const VALID_PROVIDERS = ['openai', 'anthropic', 'groq'] as const;

program
  .name('woodbury')
  .description('Interactive AI coding assistant')
  .version(version);

// Global options
program
  .option('-v, --verbose', 'Enable verbose logging')
  .option('-m, --model <model>', 'LLM model to use')
  .option('-p, --provider <provider>', 'LLM provider (openai, anthropic, groq)')
  .option('--working-directory <path>', 'Set working directory')
  .option('--context-dir <path>', 'Set context directory')
  .option('--max-iterations <number>', 'Maximum agent iterations', parseInt)
  .option('--timeout <number>', 'Timeout in milliseconds', parseInt)
  .option('--safe', 'Enable safe mode (extra confirmations)')
  .option('--no-stream', 'Disable token streaming')
  .option('--no-extensions', 'Disable all extensions');

// Interactive REPL command
program
  .command('repl')
  .alias('interactive')
  .description('Start interactive session')
  .action(async () => {
    const options = program.opts();
    const config = await buildConfig(options);

    try {
      // Load extensions unless disabled
      let extensionManager: ExtensionManager | undefined;
      if (!config.noExtensions) {
        extensionManager = new ExtensionManager(
          config.workingDirectory || process.cwd(),
          config.verbose || false
        );
        const { loaded, errors } = await extensionManager.loadAll();
        if (loaded.length > 0 && config.verbose) {
          console.log(`  ${icons.success}  Extensions: ${loaded.join(', ')}`);
        }
        for (const e of errors) {
          console.warn(`  ${icons.warning}  Extension "${e.name}" failed: ${e.error}`);
        }
      }

      await startRepl(config, extensionManager);
    } catch (error) {
      console.error(`${icons.error}  ${labels.error}`, colors.error(String(error)));
      process.exit(1);
    }
  });

// One-shot command
program
  .command('run <prompt>')
  .alias('exec')
  .description('Execute a single prompt')
  .action(async (prompt: string) => {
    const options = program.opts();
    const config = await buildConfig(options);

    try {
      await runOneShot(prompt, config);
    } catch (error) {
      console.error(`${icons.error}  ${labels.error}`, colors.error(String(error)));
      process.exit(1);
    }
  });

// Orchestration command
program
  .command('orchestrate <requirements-file>')
  .description('Orchestrate multiple jobs from requirements file')
  .action(async (requirementsFile: string) => {
    const options = program.opts();
    const config = await buildConfig(options);
    config.orchestrate = true;
    config.jobsFile = requirementsFile;

    try {
      // Read the requirements file to get jobs
      const content = await fs.readFile(requirementsFile, 'utf-8');
      const jobsData = JSON.parse(content);
      const jobs: any[] = jobsData.jobs || [];

      const result = await orchestrateJobs({ jobs, config, concurrency: 1 });
      const failureCount = result.failed.length;

      if (failureCount === 0) {
        console.log(`${icons.success}  ${colors.success('All jobs completed successfully')}`);
      } else {
        console.log(`${icons.error}  ${colors.error(`${failureCount} job(s) failed`)}`);
        process.exit(1);
      }
    } catch (error) {
      console.error(`${icons.error}  ${labels.error}`, colors.error(String(error)));
      process.exit(1);
    }
  });

// Config info command
program
  .command('config')
  .description('Show current configuration')
  .action(async () => {
    const options = program.opts();
    const config = await buildConfig(options);

    console.log(colors.primary.bold('Woodbury Configuration'));
    console.log();
    console.log(`  Provider:    ${config.provider || '(auto-detect from API keys)'}`);
    console.log(`  Model:       ${config.model || '(provider default)'}`);
    console.log(`  Directory:   ${config.workingDirectory}`);
    console.log(`  Verbose:     ${config.verbose ? 'enabled' : 'disabled'}`);
    console.log(`  Safe Mode:   ${config.safe ? 'enabled' : 'disabled'}`);
    console.log(`  Streaming:   ${config.stream !== false ? 'enabled' : 'disabled'}`);
    console.log();

    // Show which API keys are available
    const keys = [];
    if (config.apiKeys?.anthropic) keys.push('anthropic');
    if (config.apiKeys?.openai) keys.push('openai');
    if (config.apiKeys?.groq) keys.push('groq');
    console.log(`  API Keys:    ${keys.length > 0 ? keys.join(', ') : colors.warning('none found')}`);

    if (keys.length === 0) {
      console.log();
      console.log(colors.muted('  Set environment variables:'));
      console.log(colors.muted('    ANTHROPIC_API_KEY, OPENAI_API_KEY, or GROQ_API_KEY'));
    }
  });

// Extension management commands
const ext = program
  .command('ext')
  .description('Manage extensions');

ext
  .command('list')
  .description('List installed extensions')
  .action(async () => {
    const manifests = await discoverExtensions();
    if (manifests.length === 0) {
      console.log(colors.muted('No extensions installed.'));
      console.log(colors.muted(`  Install from npm:  woodbury ext install <package-name>`));
      console.log(colors.muted(`  Create new:        woodbury ext create <name>`));
      console.log(colors.muted(`  Local directory:   ${EXTENSIONS_DIR}/<name>/`));
      return;
    }
    console.log(colors.primary.bold(`Extensions (${manifests.length}):`));
    console.log();
    for (const m of manifests) {
      console.log(`  ${colors.secondary(m.name)} ${colors.muted(`v${m.version}`)} ${colors.muted(`[${m.source}]`)}`);
      if (m.description) {
        console.log(`    ${colors.muted(m.description)}`);
      }
      if (m.provides.length > 0) {
        console.log(`    ${colors.muted('Provides: ' + m.provides.join(', '))}`);
      }
    }
  });

ext
  .command('install <package>')
  .description('Install an extension from npm')
  .action(async (packageName: string) => {
    const { execSync } = await import('child_process');

    // Ensure extensions directory exists
    await fs.mkdir(EXTENSIONS_DIR, { recursive: true });

    // Initialize package.json if it doesn't exist
    const pkgJsonPath = path.join(EXTENSIONS_DIR, 'package.json');
    if (!existsSync(pkgJsonPath)) {
      await fs.writeFile(pkgJsonPath, JSON.stringify({ private: true, dependencies: {} }, null, 2));
    }

    console.log(`${icons.running}  Installing ${packageName}...`);
    try {
      execSync(`npm install ${packageName}`, {
        cwd: EXTENSIONS_DIR,
        stdio: 'inherit',
      });
      console.log(`${icons.success}  ${colors.success(`Installed ${packageName}`)}`);
      console.log(colors.muted('  Restart Woodbury to activate.'));
    } catch (error) {
      console.error(`${icons.error}  ${colors.error(`Failed to install: ${error}`)}`);
      process.exit(1);
    }
  });

ext
  .command('uninstall <package>')
  .description('Uninstall an npm extension')
  .action(async (packageName: string) => {
    const { execSync } = await import('child_process');
    console.log(`${icons.running}  Uninstalling ${packageName}...`);
    try {
      execSync(`npm uninstall ${packageName}`, {
        cwd: EXTENSIONS_DIR,
        stdio: 'inherit',
      });
      console.log(`${icons.success}  ${colors.success(`Uninstalled ${packageName}`)}`);
    } catch (error) {
      console.error(`${icons.error}  ${colors.error(`Failed to uninstall: ${error}`)}`);
      process.exit(1);
    }
  });

ext
  .command('create <name>')
  .description('Scaffold a new extension')
  .option('--web', 'Include site-knowledge templates for web-navigation extensions')
  .action(async (name: string, cmdOpts: { web?: boolean }) => {
    try {
      const dir = await scaffoldExtension(name, { webNavigation: cmdOpts.web });
      console.log(`${icons.success}  ${colors.success('Extension scaffolded!')}`);
      console.log();
      console.log(`  ${colors.muted('Directory:')} ${dir}`);
      console.log(`  ${colors.muted('Edit:')}      ${path.join(dir, 'index.js')}`);
      if (cmdOpts.web) {
        console.log(`  ${colors.muted('Knowledge:')} ${path.join(dir, 'site-knowledge')}`);
        console.log();
        console.log(colors.muted('  Fill in site-knowledge/*.md files before building tools.'));
      }
      console.log();
      console.log(colors.muted('  Restart Woodbury to activate.'));
    } catch (error) {
      console.error(`${icons.error}  ${colors.error(String(error))}`);
      process.exit(1);
    }
  });

// Default command (runs REPL if no args provided)
if (process.argv.length === 2) {
  program.parse([...process.argv, 'repl']);
} else {
  program.parse();
}

async function buildConfig(options: any): Promise<WoodburyConfig> {
  // Validate provider if specified
  if (options.provider && !VALID_PROVIDERS.includes(options.provider)) {
    console.error(
      `${icons.error}  Invalid provider "${options.provider}". Valid options: ${VALID_PROVIDERS.join(', ')}`
    );
    process.exit(1);
  }

  const config: WoodburyConfig = {
    verbose: options.verbose || false,
    model: options.model,
    provider: options.provider,
    workingDirectory: options.workingDirectory || process.cwd(),
    contextDir: options.contextDir,
    maxIterations: options.maxIterations,
    timeout: options.timeout,
    safe: options.safe || false,
    stream: options.stream !== false,  // default true unless --no-stream
    noExtensions: options.extensions === false,  // --no-extensions flag
    orchestrate: false
  };

  // Load API keys from environment
  config.apiKeys = {
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    groq: process.env.GROQ_API_KEY
  };

  // Also check ~/.woodbury/.env for keys
  try {
    const homeEnvPath = path.join(require('os').homedir(), '.woodbury', '.env');
    const envContent = await fs.readFile(homeEnvPath, 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!value) continue;
      if (key === 'ANTHROPIC_API_KEY' && !config.apiKeys!.anthropic) config.apiKeys!.anthropic = value;
      if (key === 'OPENAI_API_KEY' && !config.apiKeys!.openai) config.apiKeys!.openai = value;
      if (key === 'GROQ_API_KEY' && !config.apiKeys!.groq) config.apiKeys!.groq = value;
    }
  } catch {
    // No ~/.woodbury/.env, that's fine
  }

  // Try to load config from project file
  try {
    const configPath = path.join(config.workingDirectory!, '.woodbury.json');
    const configFile = await fs.readFile(configPath, 'utf-8');
    const fileConfig = JSON.parse(configFile);

    // Validate file config provider
    if (fileConfig.provider && !VALID_PROVIDERS.includes(fileConfig.provider)) {
      console.warn(
        `${icons.warning}  Invalid provider "${fileConfig.provider}" in .woodbury.json, ignoring`
      );
      delete fileConfig.provider;
    }

    // Merge: CLI > file config > defaults
    config.verbose = options.verbose || fileConfig.verbose || false;
    config.model = options.model || fileConfig.model;
    config.provider = options.provider || fileConfig.provider;
    config.workingDirectory = options.workingDirectory || fileConfig.workingDirectory || process.cwd();
    config.contextDir = options.contextDir || fileConfig.contextDir;
    config.maxIterations = options.maxIterations || fileConfig.maxIterations;
    config.timeout = options.timeout || fileConfig.timeout;
    config.safe = options.safe || fileConfig.safe || false;
    if (options.stream === false) {
      config.stream = false;
    } else {
      config.stream = fileConfig.stream !== false;
    }
  } catch {
    // Config file doesn't exist or is invalid, use defaults
  }

  return config;
}
