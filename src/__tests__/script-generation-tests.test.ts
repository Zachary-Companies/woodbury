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

  it('supports creator asset collection tools used by generated scripts', async () => {
    const code = `/**
 * @input location_name string "Desired location collection"
 * @output collection_slug string "Resolved collection slug"
 * @output asset_id string "Saved asset id"
 */
async function execute(inputs, context) {
  const existing = await context.tools.asset_collection_list({ collection: inputs.location_name });
  let collection = existing.collections[0];
  if (!collection) {
    const created = await context.tools.asset_collection_create({ name: inputs.location_name });
    collection = created.collection;
  }
  const saved = await context.tools.asset_save({
    name: 'Location Card',
    file_path: 'location-card.json',
    collection: collection.slug,
  });
  return {
    collection_slug: collection.slug,
    asset_id: saved.asset.id,
  };
}`;

    const results = await runGeneratedScriptUnitTests(code, [
      {
        name: 'creates location collection when missing',
        inputs: { location_name: 'Forest Clearing' },
        requiredOutputKeys: ['collection_slug', 'asset_id'],
        expectedOutputSubset: { collection_slug: 'forest-clearing' },
      },
    ]);

    expect(results[0].passed).toBe(true);
    expect(results[0].output).toEqual(expect.objectContaining({ collection_slug: 'forest-clearing' }));
  });

  it('supports top-level collection fields and indexed list results from creator asset tools', async () => {
    const code = `/**
 * @input idea_id string "Idea id"
 * @output collection_id string "Collection identifier"
 */
async function execute(inputs, context) {
  const desired = 'characters-' + String(inputs.idea_id || '').toLowerCase();
  let listed = await context.tools.asset_collection_list({ collection: desired });
  let collection = listed[0];
  if (!collection) {
    collection = await context.tools.asset_collection_create({ name: desired });
  }
  return { collection_id: collection.slug || collection.id };
}`;

    const results = await runGeneratedScriptUnitTests(code, [
      {
        name: 'top_level_collection_shape',
        inputs: { idea_id: 'fantasy_story_001' },
        requiredOutputKeys: ['collection_id'],
        expectedOutputSubset: { collection_id: 'characters-fantasy-story-001' },
      },
    ]);

    expect(results[0].passed).toBe(true);
  });

  it('fails when a test requires progress reporting and the script does not emit it', async () => {
    const code = `/**
 * @input items string[] "Items"
 * @output count number "Count"
 */
async function execute(inputs, context) {
  const items = Array.isArray(inputs.items) ? inputs.items : [];
  return { count: items.length };
}`;

    const results = await runGeneratedScriptUnitTests(code, [
      {
        name: 'progress_required',
        inputs: { items: ['a', 'b'] },
        requiredOutputKeys: ['count'],
        requireProgressCalls: true,
      },
    ]);

    expect(results[0].passed).toBe(false);
    expect(results[0].failures.join(' ')).toContain('expected script to report progress');
  });

  it('passes when a script completes progress reporting cleanly', async () => {
    const code = `/**
 * @input items string[] "Items"
 * @output count number "Count"
 */
async function execute(inputs, context) {
  const items = Array.isArray(inputs.items) ? inputs.items : [];
  context.progress.start(items.length, 'Counting');
  for (const item of items) {
    context.progress.increment(item);
  }
  context.progress.complete('Done');
  return { count: items.length };
}`;

    const results = await runGeneratedScriptUnitTests(code, [
      {
        name: 'progress_completed',
        inputs: { items: ['a', 'b'] },
        requiredOutputKeys: ['count'],
        requireProgressCalls: true,
        requireProgressCompletion: true,
      },
    ]);

    expect(results[0].passed).toBe(true);
  });
});