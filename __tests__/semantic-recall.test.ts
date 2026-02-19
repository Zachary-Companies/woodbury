import { describe, it, expect, vi } from 'vitest';
import {
  levenshtein,
  extractBigrams,
  scoreMemory,
  improvedKeywordSearch,
  llmRerank,
} from '../src/semantic-recall.js';
import type { MemoryEntry } from '../src/memory.js';

function makeMemory(content: string, tags: string[] = [], ageMs = 0): MemoryEntry {
  return {
    id: 1,
    content,
    category: 'discovery',
    tags,
    timestamp: Date.now() - ageMs,
    sessionId: 'test',
  };
}

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('hello', 'hello')).toBe(0);
  });

  it('returns correct edit distance for single substitution', () => {
    expect(levenshtein('cat', 'bat')).toBe(1);
  });

  it('returns correct edit distance for insertion', () => {
    expect(levenshtein('cat', 'cats')).toBe(1);
  });

  it('returns correct edit distance for deletion', () => {
    expect(levenshtein('cats', 'cat')).toBe(1);
  });

  it('handles empty strings', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('', '')).toBe(0);
  });

  it('returns correct distance for multiple edits', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });
});

describe('extractBigrams', () => {
  it('extracts word-level bigrams', () => {
    const bigrams = extractBigrams('hello world test');
    expect(bigrams.has('hello world')).toBe(true);
    expect(bigrams.has('world test')).toBe(true);
  });

  it('extracts char-level bigrams', () => {
    const bigrams = extractBigrams('hello');
    expect(bigrams.has('he')).toBe(true);
    expect(bigrams.has('el')).toBe(true);
    expect(bigrams.has('ll')).toBe(true);
    expect(bigrams.has('lo')).toBe(true);
  });

  it('handles empty string', () => {
    const bigrams = extractBigrams('');
    expect(bigrams.size).toBe(0);
  });
});

describe('scoreMemory', () => {
  it('scores higher for exact keyword matches', () => {
    const memExact = makeMemory('authentication login flow');
    const memFuzzy = makeMemory('authantication loginn flow'); // typos

    const keywords = ['authentication', 'login'];
    const bigrams = extractBigrams('authentication login');

    const scoreExact = scoreMemory(memExact, keywords, bigrams);
    const scoreFuzzy = scoreMemory(memFuzzy, keywords, bigrams);

    expect(scoreExact).toBeGreaterThan(scoreFuzzy);
  });

  it('gives recency boost for recent memories', () => {
    const recent = makeMemory('test memory', [], 0);          // now
    const old = makeMemory('test memory', [], 30 * 86400000); // 30 days ago

    const keywords = ['test'];
    const bigrams = extractBigrams('test');

    const scoreRecent = scoreMemory(recent, keywords, bigrams);
    const scoreOld = scoreMemory(old, keywords, bigrams);

    expect(scoreRecent).toBeGreaterThan(scoreOld);
  });

  it('scores tags as well as content', () => {
    const mem = makeMemory('some content', ['auth', 'jwt']);
    const keywords = ['jwt'];
    const bigrams = extractBigrams('jwt');

    const score = scoreMemory(mem, keywords, bigrams);
    expect(score).toBeGreaterThan(0);
  });
});

describe('improvedKeywordSearch', () => {
  it('returns results sorted by score', () => {
    const memories: MemoryEntry[] = [
      { ...makeMemory('unrelated content'), id: 1 },
      { ...makeMemory('authentication jwt token login'), id: 2 },
      { ...makeMemory('auth flow login'), id: 3 },
    ];

    const results = improvedKeywordSearch(memories, 'authentication login');
    expect(results.length).toBeGreaterThan(0);
    // Should be sorted descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('finds fuzzy matches (typo tolerance)', () => {
    const memories: MemoryEntry[] = [
      { ...makeMemory('authenticaion flow system'), id: 1 }, // typo
    ];

    const results = improvedKeywordSearch(memories, 'authentication');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('returns empty for no matches', () => {
    // Use an old memory (30 days) so recency boost is 0, and a query
    // with no character overlap to the content
    const memories: MemoryEntry[] = [
      { ...makeMemory('apple orange banana', [], 30 * 86400000), id: 1 },
    ];

    const results = improvedKeywordSearch(memories, 'xqzwkv');
    expect(results).toHaveLength(0);
  });

  it('respects maxResults', () => {
    const memories: MemoryEntry[] = Array.from({ length: 30 }, (_, i) => ({
      ...makeMemory(`test item ${i}`),
      id: i + 1,
    }));

    const results = improvedKeywordSearch(memories, 'test', 5);
    expect(results.length).toBeLessThanOrEqual(5);
  });
});

describe('llmRerank', () => {
  it('falls back when LLM fails', async () => {
    // Mock the dynamic import to throw immediately
    const { llmRerank: rerank } = await import('../src/semantic-recall.js');

    const candidates = [
      { memory: makeMemory('test memory'), score: 3.0 },
    ];

    // The import of the agentic-loop engine will succeed but runPrompt will
    // fail without API keys — the catch block should return original candidates.
    // Use a short timeout model name to trigger a fast failure.
    const result = await rerank(candidates, 'test', 'nonexistent-model-xyz');
    // Should return original candidates as fallback
    expect(result).toHaveLength(1);
    expect(result[0].memory.content).toBe('test memory');
  }, 30_000);

  it('returns empty for empty candidates', async () => {
    const result = await llmRerank([], 'test', 'fake-model');
    expect(result).toEqual([]);
  });
});
