import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { AgentConfig, ConfigFile } from './types.js';

export { AgentConfig } from './types.js';

const DEFAULT_CONFIG: AgentConfig = {
  name: 'default',
  provider: 'openai',
  model: 'gpt-4',
  maxTokens: 4000,
  temperature: 0.7,
  workingDirectory: process.cwd(),
  toolTimeout: 30000,
  maxIterations: 10
};

export function loadConfig(configPath?: string): AgentConfig {
  let config = { ...DEFAULT_CONFIG };
  
  // Try to load from config file
  const paths = [
    configPath,
    join(process.cwd(), '.agent-config.json'),
    join(process.cwd(), 'agent-config.json')
  ].filter(Boolean) as string[];
  
  for (const path of paths) {
    if (existsSync(path)) {
      try {
        const fileContent = readFileSync(path, 'utf-8');
        const fileConfig: ConfigFile = JSON.parse(fileContent);
        config = { ...config, ...fileConfig } as AgentConfig;
        break;
      } catch (error) {
        console.warn(`Failed to load config from ${path}:`, error);
      }
    }
  }
  
  // Override with environment variables
  if (process.env.OPENAI_API_KEY) {
    config.apiKey = process.env.OPENAI_API_KEY;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    config.apiKey = process.env.ANTHROPIC_API_KEY;
    config.provider = 'anthropic';
  }
  if (process.env.LLM_PROVIDER) {
    config.provider = process.env.LLM_PROVIDER as any;
  }
  if (process.env.LLM_MODEL) {
    config.model = process.env.LLM_MODEL;
  }
  if (process.env.LLM_BASE_URL) {
    config.baseURL = process.env.LLM_BASE_URL;
  }
  
  return config;
}

export function saveConfig(config: AgentConfig, configPath?: string): void {
  const path = configPath || join(process.cwd(), '.agent-config.json');
  const content = JSON.stringify(config, null, 2);
  require('fs').writeFileSync(path, content);
}
