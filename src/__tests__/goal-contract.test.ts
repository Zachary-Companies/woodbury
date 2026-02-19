import { GoalContract } from '../goal-contract';
import * as fs from 'fs/promises';
import * as path from 'path';

// Mock the file system
jest.mock('fs/promises');
const mockFs = fs as jest.Mocked<typeof fs>;

// Mock path module
jest.mock('path', () => ({
  ...jest.requireActual('path'),
  join: jest.fn((...args) => args.join('/'))
}));

describe('GoalContract', () => {
  let goalContract: GoalContract;
  const testWorkDir = '/test/work';
  const goalFile = '/test/work/.woodbury-work/goal.json';

  beforeEach(() => {
    goalContract = new GoalContract(testWorkDir);
    jest.clearAllMocks();
  });

  describe('initialization', () => {
    it('should create a GoalContract instance', () => {
      expect(goalContract).toBeInstanceOf(GoalContract);
    });
  });

  describe('create', () => {
    beforeEach(() => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue();
    });

    it('should create a goal contract with required fields', async () => {
      const contractData = {
        objective: 'Build a REST API for user management',
        successCriteria: [
          'All endpoints return proper HTTP status codes',
          'Database operations work correctly',
          'Authentication is implemented'
        ]
      };

      const result = await goalContract.create(contractData);

      expect(result.objective).toBe(contractData.objective);
      expect(result.successCriteria).toEqual(contractData.successCriteria);
      expect(result.createdAt).toBeDefined();
      expect(mockFs.mkdir).toHaveBeenCalledWith('/test/work/.woodbury-work', { recursive: true });
      expect(mockFs.writeFile).toHaveBeenCalled();
    });

    it('should include constraints and assumptions when provided', async () => {
      const contractData = {
        objective: 'Refactor authentication system',
        successCriteria: ['All tests pass', 'No breaking changes'],
        constraints: ['Must maintain backward compatibility', 'No new dependencies'],
        assumptions: ['Database schema remains unchanged', 'Redis is available']
      };

      const result = await goalContract.create(contractData);

      expect(result.constraints).toEqual(contractData.constraints);
      expect(result.assumptions).toEqual(contractData.assumptions);
    });

    it('should require at least one success criterion', async () => {
      const contractData = {
        objective: 'Test objective',
        successCriteria: []
      };

      await expect(goalContract.create(contractData))
        .rejects.toThrow('At least one success criterion is required');
    });

    it('should reject if goal contract already exists', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({ 
        objective: 'Existing goal',
        successCriteria: ['Test'],
        createdAt: new Date().toISOString()
      }));

      const contractData = {
        objective: 'New objective',
        successCriteria: ['New criterion']
      };

      await expect(goalContract.create(contractData))
        .rejects.toThrow('Goal contract already exists');
    });
  });

  describe('get', () => {
    const existingContract = {
      objective: 'Build user management API',
      successCriteria: [
        'CRUD operations for users',
        'Authentication with JWT',
        'Input validation'
      ],
      constraints: ['Use existing database'],
      assumptions: ['Users table exists'],
      createdAt: '2024-01-01T12:00:00.000Z'
    };

    it('should return existing goal contract', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(existingContract));

      const result = await goalContract.get();

      expect(result).toEqual(existingContract);
      expect(mockFs.readFile).toHaveBeenCalledWith(goalFile, 'utf-8');
    });

    it('should return null when no contract exists', async () => {
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });

      const result = await goalContract.get();
      expect(result).toBeNull();
    });

    it('should handle corrupted contract file', async () => {
      mockFs.readFile.mockResolvedValue('invalid json');

      const result = await goalContract.get();
      expect(result).toBeNull();
    });
  });

  describe('exists', () => {
    it('should return true when contract exists', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({ 
        objective: 'Test',
        successCriteria: ['Test']
      }));

      const result = await goalContract.exists();
      expect(result).toBe(true);
    });

    it('should return false when contract does not exist', async () => {
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });

      const result = await goalContract.exists();
      expect(result).toBe(false);
    });

    it('should return false for corrupted contract', async () => {
      mockFs.readFile.mockResolvedValue('invalid json');

      const result = await goalContract.exists();
      expect(result).toBe(false);
    });
  });

  describe('update', () => {
    const existingContract = {
      objective: 'Original objective',
      successCriteria: ['Original criterion'],
      createdAt: '2024-01-01T12:00:00.000Z'
    };

    beforeEach(() => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(existingContract));
      mockFs.writeFile.mockResolvedValue();
    });

    it('should update existing contract', async () => {
      const updates = {
        objective: 'Updated objective',
        constraints: ['New constraint']
      };

      const result = await goalContract.update(updates);

      expect(result.objective).toBe('Updated objective');
      expect(result.constraints).toEqual(['New constraint']);
      expect(result.successCriteria).toEqual(['Original criterion']); // Should preserve
      expect(result.updatedAt).toBeDefined();
      expect(mockFs.writeFile).toHaveBeenCalled();
    });

    it('should reject if no existing contract', async () => {
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });

      await expect(goalContract.update({ objective: 'New' }))
        .rejects.toThrow('No goal contract exists to update');
    });
  });

  describe('delete', () => {
    it('should delete existing contract', async () => {
      mockFs.unlink.mockResolvedValue();

      await goalContract.delete();

      expect(mockFs.unlink).toHaveBeenCalledWith(goalFile);
    });

    it('should handle deletion of non-existent contract', async () => {
      mockFs.unlink.mockRejectedValue({ code: 'ENOENT' });

      // Should not throw
      await expect(goalContract.delete()).resolves.not.toThrow();
    });

    it('should propagate other file system errors', async () => {
      mockFs.unlink.mockRejectedValue(new Error('Permission denied'));

      await expect(goalContract.delete()).rejects.toThrow('Permission denied');
    });
  });

  describe('validation', () => {
    it('should validate objective is not empty', async () => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue();

      const contractData = {
        objective: '',
        successCriteria: ['Test criterion']
      };

      await expect(goalContract.create(contractData))
        .rejects.toThrow('Objective cannot be empty');
    });

    it('should validate success criteria are not empty strings', async () => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue();

      const contractData = {
        objective: 'Valid objective',
        successCriteria: ['Valid criterion', '', 'Another valid']
      };

      await expect(goalContract.create(contractData))
        .rejects.toThrow('Success criteria cannot contain empty strings');
    });
  });

  describe('error handling', () => {
    it('should handle file system errors during creation', async () => {
      mockFs.mkdir.mockRejectedValue(new Error('Permission denied'));

      const contractData = {
        objective: 'Test objective',
        successCriteria: ['Test criterion']
      };

      await expect(goalContract.create(contractData))
        .rejects.toThrow('Permission denied');
    });

    it('should handle write errors', async () => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockRejectedValue(new Error('Disk full'));

      const contractData = {
        objective: 'Test objective', 
        successCriteria: ['Test criterion']
      };

      await expect(goalContract.create(contractData))
        .rejects.toThrow('Disk full');
    });
  });
});
