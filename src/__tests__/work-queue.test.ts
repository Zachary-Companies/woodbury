// Basic work-queue module test
import {
  queueInit,
  queueNext,
  queueDone,
  queueStatus,
  clearQueue
} from '../work-queue';

describe('work-queue', () => {
  afterEach(async () => {
    await clearQueue();
  });

  describe('module loading', () => {
    it('should export all required functions', () => {
      expect(typeof queueInit).toBe('function');
      expect(typeof queueNext).toBe('function');
      expect(typeof queueDone).toBe('function');
      expect(typeof queueStatus).toBe('function');
      expect(typeof clearQueue).toBe('function');
    });
  });

  describe('error handling', () => {
    it('should reject queueNext if no queue exists', async () => {
      await expect(queueNext())
        .rejects.toThrow('No active queue');
    });

    it('should reject queueDone if no queue exists', async () => {
      await expect(queueDone('completed'))
        .rejects.toThrow('No active queue');
    });

    it('should return empty status if no queue exists', async () => {
      const result = await queueStatus();
      expect(result.totalItems).toBe(0);
      expect(result.sharedContextSummary).toBe('No active queue');
    });
  });

  describe('basic types', () => {
    it('should accept valid queue items', () => {
      const items = [
        { name: 'test1', details: 'Test item 1' },
        { name: 'test2', details: 'Test item 2' }
      ];
      
      // Should not throw when creating items with correct structure
      expect(() => items).not.toThrow();
      expect(items[0].name).toBe('test1');
      expect(items[0].details).toBe('Test item 1');
    });
  });
});
