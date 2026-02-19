import * as fs from 'fs/promises';
import * as path from 'path';

export interface GoalContractData {
  objective: string;
  successCriteria: string[];
  constraints?: string[];
  assumptions?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export class GoalContract {
  private goalFile: string;

  constructor(private workingDirectory: string) {
    this.goalFile = path.join(workingDirectory, '.woodbury-work', 'goal.json');
  }

  async create(data: GoalContractData): Promise<GoalContractData> {
    // Validation
    if (!data.objective || data.objective.trim() === '') {
      throw new Error('Objective cannot be empty');
    }

    if (!data.successCriteria || data.successCriteria.length === 0) {
      throw new Error('At least one success criterion is required');
    }

    if (data.successCriteria.some(criterion => !criterion || criterion.trim() === '')) {
      throw new Error('Success criteria cannot contain empty strings');
    }

    // Check if contract already exists
    const existing = await this.get();
    if (existing) {
      throw new Error('Goal contract already exists. Update or delete it first.');
    }

    const now = new Date().toISOString();
    const contract: GoalContractData = {
      ...data,
      createdAt: now,
      updatedAt: now
    };

    await this.save(contract);
    return contract;
  }

  async get(): Promise<GoalContractData | null> {
    try {
      const content = await fs.readFile(this.goalFile, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        return null;
      }
      // Return null on parse errors
      return null;
    }
  }

  async exists(): Promise<boolean> {
    const contract = await this.get();
    return contract !== null;
  }

  async update(updates: Partial<GoalContractData>): Promise<GoalContractData> {
    const existing = await this.get();
    if (!existing) {
      throw new Error('No goal contract exists to update. Create one first.');
    }

    const updated: GoalContractData = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString()
    };

    await this.save(updated);
    return updated;
  }

  async delete(): Promise<void> {
    try {
      await fs.unlink(this.goalFile);
    } catch (error) {
      if ((error as any).code !== 'ENOENT') {
        throw error;
      }
      // Ignore if file doesn't exist
    }
  }

  private async save(contract: GoalContractData): Promise<void> {
    await fs.mkdir(path.dirname(this.goalFile), { recursive: true });
    await fs.writeFile(this.goalFile, JSON.stringify(contract, null, 2));
  }
}
