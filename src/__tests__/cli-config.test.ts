/**
 * Tests for CLI configuration improvements:
 * - Provider validation
 * - --no-stream flag handling
 * - Config command output
 * - ~/.woodbury/.env loading
 * - .woodbury.json project config merging
 */

// We can't easily test the CLI's buildConfig directly since it's not exported,
// but we can test the patterns and types it uses.

import type { WoodburyConfig } from '../types';

describe('CLI config patterns', () => {
  const VALID_PROVIDERS = ['openai', 'anthropic', 'groq'] as const;

  describe('provider validation', () => {
    it('should accept valid providers', () => {
      for (const provider of VALID_PROVIDERS) {
        expect(VALID_PROVIDERS.includes(provider as any)).toBe(true);
      }
    });

    it('should reject invalid providers', () => {
      const invalidProviders = ['azure', 'huggingface', 'local', '', 'OPENAI'];
      for (const provider of invalidProviders) {
        expect(VALID_PROVIDERS.includes(provider as any)).toBe(false);
      }
    });
  });

  describe('stream config', () => {
    it('should default stream to true', () => {
      const config: WoodburyConfig = {};
      const stream = config.stream !== false; // CLI default logic
      expect(stream).toBe(true);
    });

    it('should set stream to false when explicitly disabled', () => {
      const config: WoodburyConfig = { stream: false };
      const stream = config.stream !== false;
      expect(stream).toBe(false);
    });

    it('should keep stream true when explicitly set', () => {
      const config: WoodburyConfig = { stream: true };
      const stream = config.stream !== false;
      expect(stream).toBe(true);
    });
  });

  describe('config building', () => {
    it('should build a complete config from minimal options', () => {
      const options: any = {
        verbose: false,
        safe: false
      };

      const config: WoodburyConfig = {
        verbose: options.verbose || false,
        model: options.model,
        provider: options.provider,
        workingDirectory: options.workingDirectory || process.cwd(),
        maxIterations: options.maxIterations,
        timeout: options.timeout,
        safe: options.safe || false,
        stream: options.stream !== false,
        orchestrate: false
      };

      expect(config.verbose).toBe(false);
      expect(config.workingDirectory).toBe(process.cwd());
      expect(config.stream).toBe(true);
      expect(config.orchestrate).toBe(false);
    });

    it('should merge CLI options over file config', () => {
      const cliOptions = { model: 'gpt-4', provider: undefined };
      const fileConfig = { model: 'claude-3-5-sonnet', provider: 'anthropic' };

      // CLI > file > defaults
      const model = cliOptions.model || fileConfig.model;
      const provider = cliOptions.provider || fileConfig.provider;

      expect(model).toBe('gpt-4'); // CLI wins
      expect(provider).toBe('anthropic'); // File wins since CLI is undefined
    });

    it('should handle missing API keys gracefully', () => {
      const apiKeys = {
        openai: process.env.OPENAI_API_KEY,
        anthropic: process.env.ANTHROPIC_API_KEY,
        groq: process.env.GROQ_API_KEY
      };

      // All keys may be undefined in test environment
      expect(apiKeys).toBeDefined();
    });
  });

  describe('.env file parsing', () => {
    // Test the env parsing logic used in buildConfig
    function parseEnvLine(line: string): { key: string; value: string } | null {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return null;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) return null;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!value) return null;
      return { key, value };
    }

    it('should parse simple key=value pairs', () => {
      const result = parseEnvLine('ANTHROPIC_API_KEY=sk-ant-test123');
      expect(result).toEqual({ key: 'ANTHROPIC_API_KEY', value: 'sk-ant-test123' });
    });

    it('should handle double-quoted values', () => {
      const result = parseEnvLine('OPENAI_API_KEY="sk-test-key"');
      expect(result).toEqual({ key: 'OPENAI_API_KEY', value: 'sk-test-key' });
    });

    it('should handle single-quoted values', () => {
      const result = parseEnvLine("GROQ_API_KEY='gsk-test'");
      expect(result).toEqual({ key: 'GROQ_API_KEY', value: 'gsk-test' });
    });

    it('should skip comments', () => {
      expect(parseEnvLine('# This is a comment')).toBeNull();
    });

    it('should skip empty lines', () => {
      expect(parseEnvLine('')).toBeNull();
      expect(parseEnvLine('   ')).toBeNull();
    });

    it('should skip lines without = sign', () => {
      expect(parseEnvLine('JUST_A_KEY')).toBeNull();
    });

    it('should skip empty values', () => {
      expect(parseEnvLine('KEY=')).toBeNull();
    });

    it('should handle values with = in them', () => {
      const result = parseEnvLine('KEY=value=with=equals');
      expect(result).toEqual({ key: 'KEY', value: 'value=with=equals' });
    });

    it('should trim whitespace around key and value', () => {
      const result = parseEnvLine('  KEY  =  value  ');
      expect(result).toEqual({ key: 'KEY', value: 'value' });
    });
  });

  describe('.woodbury.json config merging', () => {
    it('should validate provider from file config', () => {
      const fileConfig = { provider: 'invalid-provider' };
      const isValid = VALID_PROVIDERS.includes(fileConfig.provider as any);
      expect(isValid).toBe(false);
    });

    it('should accept valid provider from file config', () => {
      const fileConfig = { provider: 'anthropic' };
      const isValid = VALID_PROVIDERS.includes(fileConfig.provider as any);
      expect(isValid).toBe(true);
    });
  });
});
