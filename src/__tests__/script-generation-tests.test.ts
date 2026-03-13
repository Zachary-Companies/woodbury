import { describe, expect, it } from '@jest/globals';
import {
  runGeneratedScriptUnitTests,
  type ScriptGenerationTestCase,
} from '../dashboard/script-generation-tests.js';

describe('runGeneratedScriptUnitTests', () => {
  it('passes deterministic tests for a pure transform script', async () => {
    const code = `/**
 * @input text string "Input text"
 * @output upper string "Uppercase text"
 */
async function execute(inputs, context) {
  const { text } = inputs;
  return { upper: String(text).toUpperCase() };
}`;

    const cases: ScriptGenerationTestCase[] = [
      {
        name: 'uppercases input',
        inputs: { text: 'woodbury' },
        requiredOutputKeys: ['upper'],
        expectedOutputSubset: { upper: 'WOODBURY' },
      },
    ];

    const results = await runGeneratedScriptUnitTests(code, cases);
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
  });

  it('supports mocked llm.generateJSON responses', async () => {
    const code = `/**
 * @input topic string "Topic"
 * @output title string "Title"
 */
async function execute(inputs, context) {
  const result = await context.llm.generateJSON('ignored');
  return { title: result.title };
}`;

    const results = await runGeneratedScriptUnitTests(code, [
      {
        name: 'uses llm json stub',
        llmGenerateJSON: { title: 'Generated Title' },
        expectedOutputSubset: { title: 'Generated Title' },
      },
    ]);

    expect(results[0].passed).toBe(true);
  });

  it('fails when code tries to require node modules inside the sandbox', async () => {
    const code = `/**
 * @output ok boolean "ok"
 */
async function execute(inputs, context) {
  const fs = require('fs');
  return { ok: !!fs };
}`;

    const results = await runGeneratedScriptUnitTests(code, [
      {
        name: 'sandbox blocks require',
        requiredOutputKeys: ['ok'],
      },
    ]);

    expect(results[0].passed).toBe(false);
    expect(results[0].failures.join(' ')).toContain('require is disabled');
  });
});