import { ContextCompactor, compactContext } from '../context-compactor';
import { ConversationTurn } from '../types';

describe('ContextCompactor', () => {
  let compactor: ContextCompactor;
  const maxLength = 1000;
  const keepRecent = 3;

  beforeEach(() => {
    compactor = new ContextCompactor({ maxLength, keepRecent });
  });

  describe('initialization', () => {
    it('should create a context compactor with options', () => {
      expect(compactor).toBeInstanceOf(ContextCompactor);
    });
  });

  describe('compact', () => {
    it('should handle empty history', () => {
      const history: ConversationTurn[] = [];
      const result = compactor.compact(history);
      expect(result).toEqual([]);
    });

    it('should preserve short history unchanged', () => {
      const history: ConversationTurn[] = [
        {
          id: '1',
          timestamp: new Date(),
          role: 'user',
          content: 'Hello',
          userMessage: 'Hello'
        },
        {
          id: '2', 
          timestamp: new Date(),
          role: 'assistant',
          content: 'Hi there!',
          assistantMessage: 'Hi there!'
        }
      ];
      
      const result = compactor.compact(history);
      expect(result).toEqual(history);
    });

    it('should compact long history while preserving recent turns', () => {
      const longHistory: ConversationTurn[] = Array.from({ length: 10 }, (_, i) => ({
        id: `${i + 1}`,
        timestamp: new Date(Date.now() - (10 - i) * 1000),
        role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: `Message ${i + 1}`.repeat(50), // Make messages long enough to trigger compaction
        userMessage: i % 2 === 0 ? `Message ${i + 1}`.repeat(50) : undefined,
        assistantMessage: i % 2 === 1 ? `Message ${i + 1}`.repeat(50) : undefined
      }));
      
      const result = compactor.compact(longHistory);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      expect(result.length).toBeLessThanOrEqual(longHistory.length);
      
      // Should preserve the most recent turns
      const recentTurns = result.slice(-keepRecent);
      expect(recentTurns.length).toBe(keepRecent);
    });

    it('should create summary when compacting older turns', () => {
      const longHistory: ConversationTurn[] = Array.from({ length: 10 }, (_, i) => ({
        id: `${i + 1}`,
        timestamp: new Date(Date.now() - (10 - i) * 1000),
        role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: `This is a very long message ${i + 1}`.repeat(30),
        userMessage: i % 2 === 0 ? `This is a very long message ${i + 1}`.repeat(30) : undefined,
        assistantMessage: i % 2 === 1 ? `This is a very long message ${i + 1}`.repeat(30) : undefined
      }));
      
      const result = compactor.compact(longHistory);
      
      // Should have summary + recent turns
      expect(result.length).toBeGreaterThan(keepRecent);
      
      // First turn should be summary
      const firstTurn = result[0];
      expect(firstTurn.id).toBe('summary');
      expect(firstTurn.role).toBe('assistant');
      expect(firstTurn.content).toContain('Summary of');
    });
  });

  describe('compactContext function', () => {
    it('should use default parameters', () => {
      const history: ConversationTurn[] = [
        {
          id: '1',
          timestamp: new Date(),
          role: 'user',
          content: 'Test',
          userMessage: 'Test'
        }
      ];
      
      const result = compactContext(history);
      expect(Array.isArray(result)).toBe(true);
    });

    it('should accept custom parameters', () => {
      const history: ConversationTurn[] = [
        {
          id: '1',
          timestamp: new Date(),
          role: 'user',
          content: 'Test',
          userMessage: 'Test'
        }
      ];
      
      const result = compactContext(history, 5000, 2);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('structured summary extraction', () => {
    // Use a small maxLength compactor for these tests so we can trigger compaction easily
    let smallCompactor: ContextCompactor;

    beforeEach(() => {
      smallCompactor = new ContextCompactor({ maxLength: 200, keepRecent: 2 });
    });

    it('should extract user requests as first sentences', () => {
      const history: ConversationTurn[] = [
        {
          id: '1',
          timestamp: new Date(Date.now() - 5000),
          role: 'user',
          content: 'Fix the login bug. Also update the docs. ' + 'x'.repeat(100)
        },
        {
          id: '2',
          timestamp: new Date(Date.now() - 4000),
          role: 'assistant',
          content: 'I will fix the login bug in src/auth.ts. ' + 'y'.repeat(100)
        },
        {
          id: '3',
          timestamp: new Date(Date.now() - 3000),
          role: 'user',
          content: 'Add a new test for the feature. ' + 'z'.repeat(100)
        },
        {
          id: '4',
          timestamp: new Date(Date.now() - 2000),
          role: 'assistant',
          content: 'I created the test file. ' + 'w'.repeat(100)
        },
        // Recent turns that should be preserved
        { id: 'recent-0', timestamp: new Date(), role: 'user', content: 'Recent 0' },
        { id: 'recent-1', timestamp: new Date(), role: 'user', content: 'Recent 1' }
      ];

      const result = smallCompactor.compact(history);
      const summary = result[0];
      expect(summary.id).toBe('summary');
      expect(summary.content).toContain('User requests:');
      expect(summary.content).toContain('Fix the login bug');
    });

    it('should extract file paths from assistant messages', () => {
      const history: ConversationTurn[] = [
        {
          id: '1',
          timestamp: new Date(Date.now() - 5000),
          role: 'user',
          content: 'Please update the files. ' + 'x'.repeat(100)
        },
        {
          id: '2',
          timestamp: new Date(Date.now() - 4000),
          role: 'assistant',
          content: 'I modified src/auth.ts and src/config.ts and also README.md for docs. ' + 'y'.repeat(100)
        },
        // Recent turns
        { id: 'recent-0', timestamp: new Date(), role: 'user', content: 'Recent 0' },
        { id: 'recent-1', timestamp: new Date(), role: 'user', content: 'Recent 1' }
      ];

      const result = smallCompactor.compact(history);
      const summary = result[0];
      expect(summary.content).toContain('Files referenced:');
      expect(summary.content).toContain('src/auth.ts');
      expect(summary.content).toContain('src/config.ts');
      expect(summary.content).toContain('README.md');
    });

    it('should extract key decisions from assistant messages', () => {
      const decisionContent = 'I will update the authentication module to use JWT tokens. I decided to remove the old session code. ' + 'x'.repeat(100);
      const history: ConversationTurn[] = [
        {
          id: '1',
          timestamp: new Date(Date.now() - 5000),
          role: 'user',
          content: 'z'.repeat(200)
        },
        {
          id: '2',
          timestamp: new Date(Date.now() - 4000),
          role: 'assistant',
          content: decisionContent
        },
        // Recent turns
        { id: 'recent-0', timestamp: new Date(), role: 'user', content: 'Recent 0' },
        { id: 'recent-1', timestamp: new Date(), role: 'user', content: 'Recent 1' }
      ];

      const result = smallCompactor.compact(history);
      const summary = result[0];
      expect(summary.content).toContain('Key actions:');
    });

    it('should truncate very long first sentences in user requests', () => {
      const longSentence = 'A'.repeat(300); // > 200 chars with no sentence break
      const history: ConversationTurn[] = [
        {
          id: '1',
          timestamp: new Date(Date.now() - 5000),
          role: 'user',
          content: longSentence
        },
        {
          id: '2',
          timestamp: new Date(Date.now() - 4000),
          role: 'assistant',
          content: 'Response ' + 'x'.repeat(200)
        },
        { id: 'recent-0', timestamp: new Date(), role: 'user', content: 'Recent 0' },
        { id: 'recent-1', timestamp: new Date(), role: 'user', content: 'Recent 1' }
      ];

      const result = smallCompactor.compact(history);
      const summary = result[0];
      expect(summary.content).toContain('...');
    });

    it('should include message count in summary header', () => {
      const history: ConversationTurn[] = [
        // 4 older turns that should be compacted
        ...Array.from({ length: 4 }, (_, i) => ({
          id: `${i + 1}`,
          timestamp: new Date(Date.now() - (10 - i) * 1000),
          role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
          content: `Message ${i + 1} ` + 'x'.repeat(100)
        })),
        // 2 recent turns
        { id: 'recent-0', timestamp: new Date(), role: 'user', content: 'Recent 0' },
        { id: 'recent-1', timestamp: new Date(), role: 'user', content: 'Recent 1' }
      ];

      const result = smallCompactor.compact(history);
      const summary = result[0];
      // 6 total - 2 keepRecent = 4 older messages
      expect(summary.content).toContain('Summary of 4 earlier messages');
    });
  });

  describe('edge cases', () => {
    it('should handle turns with null/undefined content', () => {
      const problematicHistory: ConversationTurn[] = [
        {
          id: '1',
          timestamp: new Date(),
          role: 'user',
          content: undefined as any,
          userMessage: undefined
        },
        {
          id: '2',
          timestamp: new Date(),
          role: 'assistant', 
          content: 'Valid response',
          assistantMessage: 'Valid response'
        }
      ];
      
      // Should not throw, but handle gracefully
      expect(() => compactor.compact(problematicHistory)).not.toThrow();
      const result = compactor.compact(problematicHistory);
      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle turns with only new content field', () => {
      const modernHistory: ConversationTurn[] = [
        {
          id: '1',
          timestamp: new Date(),
          role: 'user',
          content: 'Modern user message'
        },
        {
          id: '2',
          timestamp: new Date(),
          role: 'assistant',
          content: 'Modern assistant response'
        }
      ];
      
      const result = compactor.compact(modernHistory);
      expect(result).toEqual(modernHistory);
    });
  });
});
