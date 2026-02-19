import { Reflect } from '../reflect';
import { GoalContract } from '../goal-contract';
import { TaskManager } from '../task-manager';
import * as fs from 'fs/promises';

// Mock dependencies
jest.mock('../goal-contract');
jest.mock('../task-manager');
jest.mock('fs/promises');

const mockFs = fs as jest.Mocked<typeof fs>;
const MockGoalContract = GoalContract as jest.MockedClass<typeof GoalContract>;
const MockTaskManager = TaskManager as jest.MockedClass<typeof TaskManager>;

describe('Reflect', () => {
  let reflect: Reflect;
  let mockGoalContract: jest.Mocked<GoalContract>;
  let mockTaskManager: jest.Mocked<TaskManager>;
  const testWorkDir = '/test/work';

  beforeEach(() => {
    mockGoalContract = new MockGoalContract(testWorkDir) as jest.Mocked<GoalContract>;
    mockTaskManager = new MockTaskManager(testWorkDir) as jest.Mocked<TaskManager>;
    
    MockGoalContract.mockImplementation(() => mockGoalContract);
    MockTaskManager.mockImplementation(() => mockTaskManager);
    
    reflect = new Reflect(testWorkDir);
    jest.clearAllMocks();
    
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue();
  });

  describe('initialization', () => {
    it('should create a Reflect instance', () => {
      expect(reflect).toBeInstanceOf(Reflect);
    });
  });

  describe('saveReflection', () => {
    const mockGoal = {
      objective: 'Build REST API',
      successCriteria: ['All endpoints work', 'Tests pass'],
      createdAt: '2024-01-01T00:00:00.000Z'
    };

    const mockTasks = [
      { id: 1, subject: 'Create user endpoint', status: 'completed' },
      { id: 2, subject: 'Add authentication', status: 'in_progress' },
      { id: 3, subject: 'Write tests', status: 'pending' }
    ];

    beforeEach(() => {
      mockGoalContract.get.mockResolvedValue(mockGoal);
      mockTaskManager.listTasks.mockResolvedValue(mockTasks as any);
      mockFs.readFile.mockResolvedValue(JSON.stringify([]));
    });

    it('should save reflection with assessment', async () => {
      const assessment = 'Good progress on API endpoints, authentication in progress';

      await reflect.saveReflection({ assessment });

      expect(mockFs.writeFile).toHaveBeenCalled();
      const writeCall = mockFs.writeFile.mock.calls[0];
      const savedData = JSON.parse(writeCall[1] as string);
      expect(savedData).toHaveLength(1);
      expect(savedData[0].assessment).toBe(assessment);
      expect(savedData[0].timestamp).toBeDefined();
    });

    it('should include goal and task context', async () => {
      const assessment = 'Progress update';

      await reflect.saveReflection({ assessment });

      const writeCall = mockFs.writeFile.mock.calls[0];
      const savedData = JSON.parse(writeCall[1] as string);
      const reflection = savedData[0];
      
      expect(reflection.goalContext).toEqual(mockGoal);
      expect(reflection.taskContext.completed).toBe(1);
      expect(reflection.taskContext.inProgress).toBe(1);
      expect(reflection.taskContext.pending).toBe(1);
    });

    it('should handle plan changes', async () => {
      const reflectionData = {
        assessment: 'Need to adjust approach',
        planChanges: 'Switch to different authentication method',
        assumptionsChanged: 'OAuth provider not available'
      };

      await reflect.saveReflection(reflectionData);

      const writeCall = mockFs.writeFile.mock.calls[0];
      const savedData = JSON.parse(writeCall[1] as string);
      const reflection = savedData[0];
      
      expect(reflection.planChanges).toBe(reflectionData.planChanges);
      expect(reflection.assumptionsChanged).toBe(reflectionData.assumptionsChanged);
    });

    it('should append to existing reflections', async () => {
      const existingReflections = [
        {
          assessment: 'Previous reflection',
          timestamp: '2024-01-01T10:00:00.000Z',
          goalContext: mockGoal,
          taskContext: { total: 2, completed: 0, inProgress: 1, pending: 1, blocked: 0 }
        }
      ];
      mockFs.readFile.mockResolvedValue(JSON.stringify(existingReflections));

      await reflect.saveReflection({ assessment: 'New reflection' });

      const writeCall = mockFs.writeFile.mock.calls[0];
      const savedData = JSON.parse(writeCall[1] as string);
      expect(savedData).toHaveLength(2);
      expect(savedData[1].assessment).toBe('New reflection');
    });

    it('should execute repair actions', async () => {
      const repairActions = [
        { type: 'delete_task' as const, taskId: 1 },
        { type: 'revise_task' as const, taskId: 2, subject: 'Updated subject' }
      ];

      await reflect.saveReflection({
        assessment: 'Executing repairs',
        repairActions
      });

      expect(mockTaskManager.updateTask).toHaveBeenCalledWith(1, { status: 'deleted' });
      expect(mockTaskManager.updateTask).toHaveBeenCalledWith(2, { subject: 'Updated subject' });
    });
  });

  describe('getReflections', () => {
    it('should return all reflections', async () => {
      const mockReflections = [
        {
          assessment: 'First reflection',
          timestamp: '2024-01-01T10:00:00.000Z',
          goalContext: null,
          taskContext: { total: 1, completed: 0, inProgress: 1, pending: 0, blocked: 0 }
        }
      ];
      mockFs.readFile.mockResolvedValue(JSON.stringify(mockReflections));

      const result = await reflect.getReflections();
      expect(result).toEqual(mockReflections);
    });

    it('should return empty array when no reflections exist', async () => {
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });

      const result = await reflect.getReflections();
      expect(result).toEqual([]);
    });
  });

  describe('getLatestReflection', () => {
    it('should return the most recent reflection', async () => {
      const mockReflections = [
        {
          assessment: 'First reflection',
          timestamp: '2024-01-01T10:00:00.000Z',
          goalContext: null,
          taskContext: { total: 1, completed: 0, inProgress: 1, pending: 0, blocked: 0 }
        },
        {
          assessment: 'Latest reflection',
          timestamp: '2024-01-01T11:00:00.000Z', 
          goalContext: null,
          taskContext: { total: 1, completed: 1, inProgress: 0, pending: 0, blocked: 0 }
        }
      ];
      mockFs.readFile.mockResolvedValue(JSON.stringify(mockReflections));

      const result = await reflect.getLatestReflection();
      expect(result?.assessment).toBe('Latest reflection');
    });

    it('should return null when no reflections exist', async () => {
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });

      const result = await reflect.getLatestReflection();
      expect(result).toBeNull();
    });
  });

  describe('error handling', () => {
    it('should handle file system errors during reflection save', async () => {
      mockGoalContract.get.mockResolvedValue(null);
      mockTaskManager.listTasks.mockResolvedValue([]);
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });
      mockFs.writeFile.mockRejectedValue(new Error('Disk full'));

      await expect(reflect.saveReflection({ assessment: 'Test' }))
        .rejects.toThrow('Disk full');
    });

    it('should handle corrupted reflection file', async () => {
      mockFs.readFile.mockResolvedValue('invalid json');

      const result = await reflect.getReflections();
      expect(result).toEqual([]);
    });

    it('should handle task manager errors during repair', async () => {
      mockGoalContract.get.mockResolvedValue(null);
      mockTaskManager.listTasks.mockResolvedValue([]);
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });
      mockTaskManager.updateTask.mockRejectedValue(new Error('Task not found'));

      await expect(reflect.saveReflection({
        assessment: 'Test',
        repairActions: [{ type: 'delete_task', taskId: 999 }]
      })).rejects.toThrow('Task not found');
    });
  });
});
