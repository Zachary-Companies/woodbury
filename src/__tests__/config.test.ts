import type { WoodburyConfig } from '../types';

describe('Config Types', () => {
  it('should define WoodburyConfig interface correctly', () => {
    const config: WoodburyConfig = {
      model: 'gpt-4',
      workingDirectory: process.cwd(),
      contextDir: '/test/context',
      apiKeys: {
        openai: 'test-key',
        anthropic: 'test-key',
        groq: 'test-key'
      },
      verbose: false,
      safe: true,
      maxIterations: 50,
      timeout: 300000,
      orchestrate: false,
      jobsFile: 'jobs.json'
    };
    
    expect(config.model).toBe('gpt-4');
    expect(config.apiKeys?.openai).toBe('test-key');
    expect(config.verbose).toBe(false);
    expect(config.safe).toBe(true);
  });
  
  it('should allow partial configuration', () => {
    const partialConfig: WoodburyConfig = {
      model: 'claude-3-sonnet'
    };
    
    expect(partialConfig.model).toBe('claude-3-sonnet');
    expect(partialConfig.verbose).toBeUndefined();
  });
  
  it('should support all provider API keys', () => {
    const config: WoodburyConfig = {
      apiKeys: {
        openai: 'openai-key',
        anthropic: 'anthropic-key',
        groq: 'groq-key'
      }
    };
    
    expect(config.apiKeys?.openai).toBe('openai-key');
    expect(config.apiKeys?.anthropic).toBe('anthropic-key');
    expect(config.apiKeys?.groq).toBe('groq-key');
  });
  
  it('should support orchestration settings', () => {
    const config: WoodburyConfig = {
      orchestrate: true,
      jobsFile: 'my-jobs.json'
    };
    
    expect(config.orchestrate).toBe(true);
    expect(config.jobsFile).toBe('my-jobs.json');
  });
});
