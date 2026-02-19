import * as fs from 'fs/promises';
import * as path from 'path';
import { GoalContract, GoalContractData } from './goal-contract';
import { TaskManager } from './task-manager';

export interface ReflectionContext {
  goalContract: GoalContractData | null;
  tasks: any[];
  errors: string[];
  workingDirectory: string;
}

export interface ReflectionEntry {
  timestamp: string;
  assessment: string;
  planChanges?: string;
  assumptionsChanged?: string;
  context: ReflectionContext;
}

export class ReflectionManager {
  private reflectionFile: string;

  constructor(private workingDirectory: string) {
    this.reflectionFile = path.join(workingDirectory, '.woodbury-work', 'reflections.json');
  }

  async saveReflection(data: {
    assessment: string;
    planChanges?: string;
    assumptionsChanged?: string;
  }): Promise<void> {
    const goalContract = new GoalContract(this.workingDirectory);
    const taskManager = new TaskManager(this.workingDirectory);

    const context: ReflectionContext = {
      goalContract: await goalContract.get(),
      tasks: await taskManager.listTasks(),
      errors: [], // Could be populated from error log
      workingDirectory: this.workingDirectory
    };

    const entry: ReflectionEntry = {
      timestamp: new Date().toISOString(),
      assessment: data.assessment,
      planChanges: data.planChanges,
      assumptionsChanged: data.assumptionsChanged,
      context
    };

    const reflections = await this.loadReflections();
    reflections.push(entry);
    await this.saveReflections(reflections);
  }

  async getReflections(): Promise<ReflectionEntry[]> {
    return this.loadReflections();
  }

  private async loadReflections(): Promise<ReflectionEntry[]> {
    try {
      const content = await fs.readFile(this.reflectionFile, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        return [];
      }
      return [];
    }
  }

  private async saveReflections(reflections: ReflectionEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.reflectionFile), { recursive: true });
    await fs.writeFile(this.reflectionFile, JSON.stringify(reflections, null, 2));
  }
}

// Legacy exports for backward compatibility
export async function loadGoalContract(workingDirectory: string) {
  const goalContract = new GoalContract(workingDirectory);
  return goalContract.get();
}

export function formatGoalSummary(goal: any): string {
  if (!goal) return 'No goal contract found';
  
  return `Goal: ${goal.objective}\nSuccess Criteria:\n${goal.successCriteria.map((c: string) => `- ${c}`).join('\n')}`;
}
