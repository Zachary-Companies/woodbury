import * as fs from 'fs/promises';
import * as path from 'path';
import { GoalContract, GoalContractData } from './goal-contract';
import { TaskManager, Task } from './task-manager';

export interface ReflectionData {
  assessment: string;
  planChanges?: string;
  assumptionsChanged?: string;
  repairActions?: RepairAction[];
}

export interface RepairAction {
  type: 'delete_task' | 'revise_task';
  taskId: number;
  subject?: string;
  description?: string;
}

export interface ReflectionEntry {
  assessment: string;
  planChanges?: string;
  assumptionsChanged?: string;
  timestamp: string;
  goalContext: GoalContractData | null;
  taskContext: {
    total: number;
    completed: number;
    inProgress: number;
    pending: number;
    blocked: number;
  };
}

export class Reflect {
  private reflectionFile: string;
  private goalContract: GoalContract;
  private taskManager: TaskManager;

  constructor(private workingDirectory: string) {
    this.reflectionFile = path.join(workingDirectory, '.woodbury-work', 'reflections.json');
    this.goalContract = new GoalContract(workingDirectory);
    this.taskManager = new TaskManager(workingDirectory);
  }

  async saveReflection(data: ReflectionData): Promise<void> {
    // Get current context
    const goalContext = await this.goalContract.get();
    const tasks = await this.taskManager.listTasks();
    
    const taskContext = {
      total: tasks.length,
      completed: tasks.filter(t => t.status === 'completed').length,
      inProgress: tasks.filter(t => t.status === 'in_progress').length,
      pending: tasks.filter(t => t.status === 'pending').length,
      blocked: tasks.filter(t => t.status === 'blocked').length
    };

    // Execute repair actions if provided
    if (data.repairActions) {
      await this.executeRepairActions(data.repairActions);
    }

    // Create reflection entry
    const reflection: ReflectionEntry = {
      assessment: data.assessment,
      planChanges: data.planChanges,
      assumptionsChanged: data.assumptionsChanged,
      timestamp: new Date().toISOString(),
      goalContext,
      taskContext
    };

    // Load existing reflections and add new one
    const reflections = await this.loadReflections();
    reflections.push(reflection);

    await this.saveReflections(reflections);
  }

  async getReflections(): Promise<ReflectionEntry[]> {
    return this.loadReflections();
  }

  async getLatestReflection(): Promise<ReflectionEntry | null> {
    const reflections = await this.loadReflections();
    return reflections.length > 0 ? reflections[reflections.length - 1] : null;
  }

  private async executeRepairActions(actions: RepairAction[]): Promise<void> {
    for (const action of actions) {
      switch (action.type) {
        case 'delete_task':
          await this.taskManager.updateTask(action.taskId, { status: 'deleted' });
          break;
          
        case 'revise_task':
          const updates: Partial<Task> = {};
          if (action.subject) updates.subject = action.subject;
          if (action.description) updates.description = action.description;
          await this.taskManager.updateTask(action.taskId, updates);
          break;
      }
    }
  }

  private async loadReflections(): Promise<ReflectionEntry[]> {
    try {
      const content = await fs.readFile(this.reflectionFile, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        return [];
      }
      // Return empty array on parse errors
      return [];
    }
  }

  private async saveReflections(reflections: ReflectionEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.reflectionFile), { recursive: true });
    await fs.writeFile(this.reflectionFile, JSON.stringify(reflections, null, 2));
  }
}
