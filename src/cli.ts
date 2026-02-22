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
import { EXTENSIONS_DIR, discoverExtensions, parseEnvFile } from './extension-loader.js';
import { scaffoldExtension, initGitRepo, ensureGhInstalled, isToolInstalled } from './extension-scaffold.js';
import { startDashboard, type DashboardHandle } from './config-dashboard.js';
import { debugLog } from './debug-log.js';

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
  .option('--no-extensions', 'Disable all extensions')
  .option('--debug', 'Enable debug logging to ~/.woodbury/logs/');

// Interactive REPL command
program
  .command('repl')
  .alias('interactive')
  .description('Start interactive session')
  .action(async () => {
    const options = program.opts();
    const config = await buildConfig(options);

    // Initialize debug logging
    debugLog.init(config.debug || false);
    debugLog.section('STARTUP');
    debugLog.info('startup', 'Woodbury starting', {
      version,
      provider: config.provider || '(auto-detect)',
      model: config.model || '(default)',
      workingDirectory: config.workingDirectory,
      verbose: config.verbose,
      safe: config.safe,
      stream: config.stream,
      noExtensions: config.noExtensions,
    });

    try {
      // Load extensions unless disabled
      let extensionManager: ExtensionManager | undefined;
      if (!config.noExtensions) {
        debugLog.section('EXTENSIONS');
        const doneExt = debugLog.time('extensions', 'Loading extensions');
        extensionManager = new ExtensionManager(
          config.workingDirectory || process.cwd(),
          config.verbose || false
        );
        const { loaded, errors } = await extensionManager.loadAll();
        doneExt();
        debugLog.info('extensions', 'Extension load complete', { loaded, errorCount: errors.length });
        if (loaded.length > 0 && config.verbose) {
          console.log(`  ${icons.success}  Extensions: ${loaded.join(', ')}`);
        }
        for (const e of errors) {
          debugLog.error('extensions', `Extension "${e.name}" failed to load`, { error: e.error });
          console.warn(`  ${icons.warning}  Extension "${e.name}" failed: ${e.error}`);
        }
      } else {
        debugLog.info('startup', 'Extensions disabled via --no-extensions');
      }

      // Start config dashboard
      let dashboard: DashboardHandle | undefined;
      if (!config.noExtensions) {
        try {
          const doneDash = debugLog.time('dashboard', 'Starting config dashboard');
          dashboard = await startDashboard(config.verbose || false, extensionManager);
          config.dashboardUrl = dashboard.url;
          doneDash();
          debugLog.info('dashboard', 'Dashboard running', { url: dashboard.url, port: dashboard.port });
        } catch (err) {
          debugLog.error('dashboard', 'Dashboard failed to start', { error: String(err) });
          console.warn(`  ${icons.warning}  Dashboard failed to start: ${err}`);
        }
      }

      if (debugLog.isEnabled) {
        console.log(colors.muted(`  Debug log: ${debugLog.filePath}`));
      }

      debugLog.section('REPL');
      debugLog.info('repl', 'Starting REPL');
      await startRepl(config, extensionManager, dashboard);
    } catch (error) {
      debugLog.error('startup', 'Fatal startup error', { error: String(error), stack: error instanceof Error ? error.stack : undefined });
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
  .option('--no-git', 'Skip git repository initialization')
  .option('--github', 'Create a GitHub repository and push (implies --git)')
  .option('--public', 'Make the GitHub repository public (default: private)')
  .action(async (name: string, cmdOpts: { web?: boolean; git?: boolean; github?: boolean; public?: boolean }) => {
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

      // Git initialization (default: on, unless --no-git)
      const shouldGit = cmdOpts.git !== false || cmdOpts.github;
      if (shouldGit) {
        console.log();
        const gitResult = initGitRepo(dir, {
          pushToGitHub: cmdOpts.github,
          repoVisibility: cmdOpts.public ? 'public' : 'private',
        });

        if (gitResult.initialized) {
          console.log(`${icons.success}  ${colors.success('Git repository initialized')}`);
        } else if (gitResult.error) {
          console.warn(`${icons.warning}  ${colors.warning(`Git init skipped: ${gitResult.error}`)}`);
        }

        if (gitResult.pushed && gitResult.repoUrl) {
          console.log(`${icons.success}  ${colors.success(`Pushed to GitHub: ${gitResult.repoUrl}`)}`);
        } else if (cmdOpts.github && gitResult.error) {
          console.warn(`${icons.warning}  ${colors.warning(gitResult.error)}`);
        }
      }

      console.log();
      console.log(colors.muted('  Restart Woodbury to activate.'));
    } catch (error) {
      console.error(`${icons.error}  ${colors.error(String(error))}`);
      process.exit(1);
    }
  });

ext
  .command('configure <name>')
  .description('View and configure extension environment variables')
  .action(async (name: string) => {
    const manifests = await discoverExtensions();
    const manifest = manifests.find((m) => m.name === name);
    if (!manifest) {
      console.error(`${icons.error}  Extension "${name}" not found.`);
      if (manifests.length > 0) {
        console.log(colors.muted('  Available extensions:'));
        for (const m of manifests) {
          console.log(colors.muted(`    ${m.name}`));
        }
      }
      process.exit(1);
    }

    const envFilePath = path.join(manifest.directory, '.env');
    const envExamplePath = path.join(manifest.directory, '.env.example');

    // Load current .env if it exists
    let currentEnv: Record<string, string> = {};
    try {
      const content = await fs.readFile(envFilePath, 'utf-8');
      currentEnv = parseEnvFile(content);
    } catch {
      // No .env file yet
    }

    // Show declared env vars and their status
    const declarations = manifest.envDeclarations;
    const declKeys = Object.keys(declarations);

    if (declKeys.length === 0 && Object.keys(currentEnv).length === 0) {
      console.log(colors.muted(`Extension "${name}" has no declared environment variables.`));
      console.log(colors.muted(`  .env file: ${envFilePath}`));
      return;
    }

    console.log(colors.primary.bold(`${manifest.displayName} Configuration`));
    console.log();

    if (declKeys.length > 0) {
      console.log(colors.secondary('Declared variables:'));
      for (const key of declKeys) {
        const decl = declarations[key];
        const isSet = !!currentEnv[key];
        const reqLabel = decl.required ? colors.error('[required]') : colors.muted('[optional]');
        const statusIcon = isSet ? icons.success : (decl.required ? icons.error : icons.warning);
        const statusText = isSet ? colors.success('set') : colors.warning('not set');
        console.log(`  ${statusIcon}  ${key} ${reqLabel} — ${statusText}`);
        if (decl.description) {
          console.log(`      ${colors.muted(decl.description)}`);
        }
      }
    }

    // Show any extra keys in .env that aren't declared
    const extraKeys = Object.keys(currentEnv).filter((k) => !declarations[k]);
    if (extraKeys.length > 0) {
      console.log();
      console.log(colors.secondary('Additional variables in .env:'));
      for (const key of extraKeys) {
        console.log(`  ${icons.success}  ${key} — ${colors.success('set')}`);
      }
    }

    console.log();
    console.log(colors.muted(`  .env file: ${envFilePath}`));
    if (existsSync(envExamplePath)) {
      console.log(colors.muted(`  .env.example: ${envExamplePath}`));
    }
    if (!existsSync(envFilePath) && existsSync(envExamplePath)) {
      console.log();
      console.log(colors.muted(`  To get started: cp "${envExamplePath}" "${envFilePath}"`));
    }
  });

ext
  .command('link <path>')
  .description('Link a local extension directory (symlink)')
  .action(async (extPath: string) => {
    const resolvedPath = path.resolve(extPath);

    // Validate the path exists and has a package.json with woodbury field
    try {
      const pkgRaw = await fs.readFile(path.join(resolvedPath, 'package.json'), 'utf-8');
      const pkg = JSON.parse(pkgRaw);
      if (!pkg.woodbury?.name) {
        console.error(`${icons.error}  ${colors.error('No woodbury.name field in package.json')}`);
        console.log(colors.muted('  The package.json at this path must have a "woodbury" field with a "name".'));
        process.exit(1);
      }

      const extName = pkg.woodbury.name;
      const linkPath = path.join(EXTENSIONS_DIR, extName);

      // Ensure extensions directory exists
      await fs.mkdir(EXTENSIONS_DIR, { recursive: true });

      // Remove existing link/dir if present
      try {
        const stat = await fs.lstat(linkPath);
        if (stat.isSymbolicLink() || stat.isDirectory()) {
          await fs.rm(linkPath, { recursive: true });
        }
      } catch {
        // Doesn't exist — that's fine
      }

      // Create symlink
      await fs.symlink(resolvedPath, linkPath);
      console.log(`${icons.success}  ${colors.success(`Linked "${extName}"`)}`);
      console.log();
      console.log(`  ${colors.muted('Source:')} ${resolvedPath}`);
      console.log(`  ${colors.muted('Link:')}   ${linkPath}`);
      console.log();
      console.log(colors.muted('  Restart Woodbury to activate.'));
      if (pkg.woodbury.env && Object.keys(pkg.woodbury.env).length > 0) {
        console.log(colors.muted(`  Configure env: woodbury ext configure ${extName}`));
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        console.error(`${icons.error}  ${colors.error(`Path not found: ${resolvedPath}`)}`);
      } else {
        console.error(`${icons.error}  ${colors.error(String(error))}`);
      }
      process.exit(1);
    }
  });

ext
  .command('install-git <url>')
  .description('Install an extension from a git repository')
  .action(async (url: string) => {
    const { execSync } = await import('child_process');

    // Extract repo name from URL (handles .git suffix and trailing slashes)
    const repoName = path.basename(url.replace(/\.git$/, '').replace(/\/$/, ''));
    if (!repoName) {
      console.error(`${icons.error}  ${colors.error('Could not determine repository name from URL')}`);
      process.exit(1);
    }

    // Ensure extensions directory exists
    await fs.mkdir(EXTENSIONS_DIR, { recursive: true });

    const cloneDir = path.join(EXTENSIONS_DIR, repoName);

    // Check if directory already exists
    if (existsSync(cloneDir)) {
      console.error(`${icons.error}  ${colors.error(`Directory already exists: ${cloneDir}`)}`);
      console.log(colors.muted(`  Remove it first or use a different name.`));
      process.exit(1);
    }

    console.log(`${icons.running}  Cloning ${url}...`);
    try {
      execSync(`git clone "${url}" "${cloneDir}"`, { stdio: 'inherit' });
    } catch (error) {
      console.error(`${icons.error}  ${colors.error(`Failed to clone: ${error}`)}`);
      process.exit(1);
    }

    // Check for package.json with woodbury field
    const pkgPath = path.join(cloneDir, 'package.json');
    if (!existsSync(pkgPath)) {
      console.error(`${icons.error}  ${colors.error('Cloned repository has no package.json')}`);
      process.exit(1);
    }

    try {
      const pkgRaw = await fs.readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(pkgRaw);

      if (!pkg.woodbury?.name) {
        console.warn(`${icons.warning}  ${colors.warning('No woodbury field in package.json — this may not be a Woodbury extension')}`);
      }

      // Install npm dependencies if package has them
      if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
        console.log(`${icons.running}  Installing dependencies...`);
        try {
          execSync('npm install', { cwd: cloneDir, stdio: 'inherit' });
        } catch {
          console.warn(`${icons.warning}  ${colors.warning('npm install failed — extension may not work correctly')}`);
        }
      }

      // Run build if there's a build script
      if (pkg.scripts?.build) {
        console.log(`${icons.running}  Building extension...`);
        try {
          execSync('npm run build', { cwd: cloneDir, stdio: 'inherit' });
        } catch {
          console.warn(`${icons.warning}  ${colors.warning('Build failed — extension may not work correctly')}`);
        }
      }

      const extName = pkg.woodbury?.name || repoName;
      console.log(`${icons.success}  ${colors.success(`Installed "${extName}" from git`)}`);
      console.log();
      console.log(`  ${colors.muted('Directory:')} ${cloneDir}`);
      console.log();
      console.log(colors.muted('  Restart Woodbury to activate.'));
      if (pkg.woodbury?.env && Object.keys(pkg.woodbury.env).length > 0) {
        console.log(colors.muted(`  Configure env: woodbury ext configure ${extName}`));
      }
    } catch (error) {
      console.error(`${icons.error}  ${colors.error(`Failed to read package.json: ${error}`)}`);
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
    debug: options.debug || !!process.env.WOODBURY_DEBUG,
    orchestrate: false
  };

  // Load API keys from environment
  config.apiKeys = {
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    groq: process.env.GROQ_API_KEY
  };

  // Also check ~/.woodbury/.env for keys (uses shared parseEnvFile utility)
  try {
    const homeEnvPath = path.join(require('os').homedir(), '.woodbury', '.env');
    const envContent = await fs.readFile(homeEnvPath, 'utf-8');
    const homeEnv = parseEnvFile(envContent);

    if (homeEnv.ANTHROPIC_API_KEY && !config.apiKeys!.anthropic) config.apiKeys!.anthropic = homeEnv.ANTHROPIC_API_KEY;
    if (homeEnv.OPENAI_API_KEY && !config.apiKeys!.openai) config.apiKeys!.openai = homeEnv.OPENAI_API_KEY;
    if (homeEnv.GROQ_API_KEY && !config.apiKeys!.groq) config.apiKeys!.groq = homeEnv.GROQ_API_KEY;
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
