import { TaskManager } from '../task-manager';
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

describe('TaskManager', () => {
  let taskManager: TaskManager;
  const testWorkDir = '/test/work';
  const planFile = '/test/work/.woodbury-work/plan.json';

  beforeEach(() => {
    taskManager = new TaskManager(testWorkDir);
    jest.clearAllMocks();
  });

  describe('initialization', () => {
    it('should create a TaskManager instance', () => {
      expect(taskManager).toBeInstanceOf(TaskManager);
    });
  });

  describe('createTask', () => {
    beforeEach(() => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue();
      mockFs.readFile.mockResolvedValue(JSON.stringify({ tasks: [], nextId: 1 }));
    });

    it('should create a task with required fields', async () => {
      const task = {
        subject: 'Test task',
        description: 'Test description',
        validators: [{ type: 'file_exists' as const, path: 'test.ts' }]
      };

      const result = await taskManager.createTask(task);

      expect(result.id).toBe(1);
      expect(result.subject).toBe('Test task');
      expect(result.status).toBe('pending');
      expect(mockFs.writeFile).toHaveBeenCalled();
    });

    it('should assign sequential IDs', async () => {
      const existingPlan = {
        tasks: [{ id: 1, subject: 'Existing', status: 'pending' }],
        nextId: 2
      };
      mockFs.readFile.mockResolvedValue(JSON.stringify(existingPlan));

      const task = {
        subject: 'New task',
        description: 'New description', 
        validators: [{ type: 'file_exists' as const, path: 'new.ts' }]
      };

      const result = await taskManager.createTask(task);
      expect(result.id).toBe(2);
    });

    it('should require at least one validator', async () => {
      const task = {
        subject: 'Invalid task',
        description: 'No validators',
        validators: []
      };

      await expect(taskManager.createTask(task)).rejects.toThrow('At least one validator is required');
    });
  });

  describe('updateTask', () => {
    const existingPlan = {
      tasks: [
        {
          id: 1,
          subject: 'Test task',
          description: 'Test description',
          status: 'pending',
          validators: [{ type: 'file_exists', path: 'test.ts' }],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      nextId: 2
    };

    beforeEach(() => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(existingPlan));
      mockFs.writeFile.mockResolvedValue();
    });

    it('should update task status', async () => {
      const result = await taskManager.updateTask(1, { status: 'in_progress' });

      expect(result.status).toBe('in_progress');
      expect(mockFs.writeFile).toHaveBeenCalled();
    });

    it('should update task subject', async () => {
      const result = await taskManager.updateTask(1, { subject: 'Updated subject' });
      expect(result.subject).toBe('Updated subject');
    });

    it('should throw error for non-existent task', async () => {
      await expect(taskManager.updateTask(999, { status: 'completed' }))
        .rejects.toThrow('Task with ID 999 not found');
    });
  });

  describe('listTasks', () => {
    it('should return all tasks', async () => {
      const plan = {
        tasks: [
          { id: 1, subject: 'Task 1', status: 'pending' },
          { id: 2, subject: 'Task 2', status: 'completed' }
        ],
        nextId: 3
      };
      mockFs.readFile.mockResolvedValue(JSON.stringify(plan));

      const result = await taskManager.listTasks();
      expect(result).toHaveLength(2);
      expect(result[0].subject).toBe('Task 1');
    });

    it('should return empty array when no plan file exists', async () => {
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });

      const result = await taskManager.listTasks();
      expect(result).toEqual([]);
    });
  });

  describe('getTask', () => {
    const plan = {
      tasks: [
        {
          id: 1,
          subject: 'Test task',
          description: 'Test description',
          status: 'pending',
          validators: [{ type: 'file_exists', path: 'test.ts' }]
        }
      ],
      nextId: 2
    };

    beforeEach(() => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(plan));
    });

    it('should return specific task by ID', async () => {
      const result = await taskManager.getTask(1);
      expect(result?.id).toBe(1);
      expect(result?.subject).toBe('Test task');
    });

    it('should return null for non-existent task', async () => {
      const result = await taskManager.getTask(999);
      expect(result).toBeNull();
    });
  });

  describe('validation', () => {
    const plan = {
      tasks: [
        {
          id: 1,
          subject: 'Test validation',
          description: 'Test',
          status: 'pending',
          validators: [
            { type: 'file_exists', path: 'existing.ts' },
            { type: 'command_succeeds', command: 'echo "test"' }
          ]
        }
      ],
      nextId: 2
    };

    beforeEach(() => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(plan));
      mockFs.writeFile.mockResolvedValue();
    });

    it('should validate file_exists validator', async () => {
      mockFs.access.mockResolvedValue(undefined);

      const result = await taskManager.validateTask(1);
      expect(result.success).toBe(true);
    });

    it('should fail validation when file does not exist', async () => {
      mockFs.access.mockRejectedValue({ code: 'ENOENT' });

      const result = await taskManager.validateTask(1);
      expect(result.success).toBe(false);
      expect(result.errors).toContain('File existing.ts does not exist');
    });
  });

  describe('error handling', () => {
    it('should handle corrupted plan file', async () => {
      mockFs.readFile.mockResolvedValue('invalid json');

      const result = await taskManager.listTasks();
      expect(result).toEqual([]);
    });

    it('should handle file write errors', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({ tasks: [], nextId: 1 }));
      mockFs.writeFile.mockRejectedValue(new Error('Disk full'));

      const task = {
        subject: 'Test',
        description: 'Test',
        validators: [{ type: 'file_exists' as const, path: 'test.ts' }]
      };

      await expect(taskManager.createTask(task)).rejects.toThrow('Disk full');
    });
  });

  describe('task dependencies', () => {
    it('should handle blocked and blocking relationships', async () => {
      const task = {
        subject: 'Dependent task',
        description: 'Depends on another task',
        validators: [{ type: 'file_exists' as const, path: 'dep.ts' }],
        blockedBy: [1]
      };

      mockFs.readFile.mockResolvedValue(JSON.stringify({ tasks: [], nextId: 1 }));
      mockFs.writeFile.mockResolvedValue();
      mockFs.mkdir.mockResolvedValue(undefined);

      const result = await taskManager.createTask(task);
      expect(result.blockedBy).toEqual([1]);
    });
  });
});
