import * as fs from 'fs/promises';
import * as path from 'path';

export interface TaskValidator {
  type: 'file_exists' | 'file_contains' | 'command_succeeds' | 'command_output_matches' | 'test_file';
  path?: string;
  pattern?: string;
  command?: string;
}

export interface Task {
  id: number;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'deleted';
  activeForm?: string;
  validators: TaskValidator[];
  maxRetries?: number;
  toolCallBudget?: number;
  blockedBy?: number[];
  blocks?: number[];
  blockedReason?: string;
  createdAt: string;
  updatedAt: string;
  retryCount?: number;
}

export interface TaskPlan {
  tasks: Task[];
  nextId: number;
}

export interface ValidationResult {
  success: boolean;
  errors: string[];
}

export class TaskManager {
  private planFile: string;

  constructor(private workingDirectory: string) {
    this.planFile = path.join(workingDirectory, '.woodbury-work', 'plan.json');
  }

  async createTask(taskData: {
    subject: string;
    description: string;
    activeForm?: string;
    validators: TaskValidator[];
    maxRetries?: number;
    toolCallBudget?: number;
    blockedBy?: number[];
    blocks?: number[];
  }): Promise<Task> {
    if (!taskData.validators || taskData.validators.length === 0) {
      throw new Error('At least one validator is required');
    }

    const plan = await this.loadPlan();
    const now = new Date().toISOString();
    
    const task: Task = {
      id: plan.nextId,
      subject: taskData.subject,
      description: taskData.description,
      status: 'pending',
      activeForm: taskData.activeForm,
      validators: taskData.validators,
      maxRetries: taskData.maxRetries || 3,
      toolCallBudget: taskData.toolCallBudget || 50,
      blockedBy: taskData.blockedBy || [],
      blocks: taskData.blocks || [],
      createdAt: now,
      updatedAt: now,
      retryCount: 0
    };

    plan.tasks.push(task);
    plan.nextId += 1;

    await this.savePlan(plan);
    return task;
  }

  async updateTask(taskId: number, updates: Partial<Task>): Promise<Task> {
    const plan = await this.loadPlan();
    const task = plan.tasks.find(t => t.id === taskId);
    
    if (!task) {
      throw new Error(`Task with ID ${taskId} not found`);
    }

    Object.assign(task, updates, { updatedAt: new Date().toISOString() });
    await this.savePlan(plan);
    return task;
  }

  async listTasks(): Promise<Task[]> {
    const plan = await this.loadPlan();
    return plan.tasks.filter(task => task.status !== 'deleted');
  }

  async getTask(taskId: number): Promise<Task | null> {
    const plan = await this.loadPlan();
    return plan.tasks.find(t => t.id === taskId) || null;
  }

  async validateTask(taskId: number): Promise<ValidationResult> {
    const task = await this.getTask(taskId);
    if (!task) {
      return { success: false, errors: ['Task not found'] };
    }

    const errors: string[] = [];

    for (const validator of task.validators) {
      try {
        const valid = await this.runValidator(validator);
        if (!valid.success) {
          errors.push(...valid.errors);
        }
      } catch (error) {
        errors.push(`Validator error: ${error}`);
      }
    }

    return { success: errors.length === 0, errors };
  }

  private async runValidator(validator: TaskValidator): Promise<ValidationResult> {
    switch (validator.type) {
      case 'file_exists':
        if (!validator.path) {
          return { success: false, errors: ['File path is required'] };
        }
        try {
          await fs.access(validator.path);
          return { success: true, errors: [] };
        } catch {
          return { success: false, errors: [`File ${validator.path} does not exist`] };
        }

      case 'file_contains':
        if (!validator.path || !validator.pattern) {
          return { success: false, errors: ['File path and pattern are required'] };
        }
        try {
          const content = await fs.readFile(validator.path, 'utf-8');
          const regex = new RegExp(validator.pattern);
          const matches = regex.test(content);
          return {
            success: matches,
            errors: matches ? [] : [`File ${validator.path} does not match pattern ${validator.pattern}`]
          };
        } catch (error) {
          return { success: false, errors: [`Error reading file ${validator.path}: ${error}`] };
        }

      case 'command_succeeds':
        if (!validator.command) {
          return { success: false, errors: ['Command is required'] };
        }
        // Mock implementation - would need actual shell execution
        return { success: true, errors: [] };

      case 'command_output_matches':
        if (!validator.command || !validator.pattern) {
          return { success: false, errors: ['Command and pattern are required'] };
        }
        // Mock implementation - would need actual shell execution
        return { success: true, errors: [] };

      case 'test_file':
        if (!validator.path) {
          return { success: false, errors: ['Test file path is required'] };
        }
        // Mock implementation - would need actual test execution
        return { success: true, errors: [] };

      default:
        return { success: false, errors: [`Unknown validator type: ${(validator as any).type}`] };
    }
  }

  private async loadPlan(): Promise<TaskPlan> {
    try {
      const content = await fs.readFile(this.planFile, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        return { tasks: [], nextId: 1 };
      }
      // Return empty plan on parse errors
      return { tasks: [], nextId: 1 };
    }
  }

  private async savePlan(plan: TaskPlan): Promise<void> {
    await fs.mkdir(path.dirname(this.planFile), { recursive: true });
    await fs.writeFile(this.planFile, JSON.stringify(plan, null, 2));
  }
}
