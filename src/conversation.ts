import type { ConversationManager, ConversationTurn } from './types';
import { promises as fs } from 'fs';
import path from 'path';

export { type ConversationManager, type ConversationTurn } from './types';

export function compactConversation(turns: ConversationTurn[]): ConversationTurn[] {
  // Simple implementation - keep last 20 turns to prevent context overflow
  if (turns.length <= 20) {
    return turns;
  }
  
  // Keep first turn (system prompt) and last 19 turns
  return [turns[0], ...turns.slice(-19)];
}

export class FileConversationManager implements ConversationManager {
  private turns: ConversationTurn[] = [];
  private filePath: string;
  
  constructor(workingDirectory: string) {
    this.filePath = path.join(workingDirectory, '.woodbury-conversation.json');
  }
  
  addTurn(turn: ConversationTurn): void {
    this.turns.push(turn);
  }
  
  getTurns(): ConversationTurn[] {
    return [...this.turns];
  }
  
  clear(): void {
    this.turns = [];
  }
  
  async save(): Promise<void> {
    try {
      await fs.writeFile(this.filePath, JSON.stringify(this.turns, null, 2));
    } catch (error) {
      console.warn('Failed to save conversation:', error);
    }
  }
  
  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.filePath, 'utf-8');
      this.turns = JSON.parse(data);
    } catch (error) {
      // File doesn't exist or is invalid, start fresh
      this.turns = [];
    }
  }
}
