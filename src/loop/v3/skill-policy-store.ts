import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { LearningProductSkillUpdate, SkillPolicyUpdateRecord } from './types.js';

const DATA_DIR = join(homedir(), '.woodbury', 'data', 'closure-engine');
const SKILL_POLICY_FILE = join(DATA_DIR, 'skill-policies.json');

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class SkillPolicyStore {
  private updates: SkillPolicyUpdateRecord[] = [];

  constructor(private readonly filePath: string = SKILL_POLICY_FILE) {
    this.load();
  }

  getAll(): SkillPolicyUpdateRecord[] {
    return [...this.updates];
  }

  getForSkill(skillName: string, reviewStatus?: SkillPolicyUpdateRecord['reviewStatus']): SkillPolicyUpdateRecord[] {
    return this.updates.filter(update =>
      update.skillName === skillName &&
      (!reviewStatus || update.reviewStatus === reviewStatus),
    );
  }

  persistSuggestedUpdates(products: LearningProductSkillUpdate[]): SkillPolicyUpdateRecord[] {
    const stored: SkillPolicyUpdateRecord[] = [];
    for (const product of products) {
      const existing = this.updates.find(update =>
        update.skillName === product.skillName &&
        update.updateType === product.updateType &&
        update.applicabilityPattern === product.applicabilityPattern &&
        update.guidance === product.guidance,
      );
      if (existing) {
        existing.confidence = Math.max(existing.confidence, product.confidence);
        existing.updatedAt = new Date().toISOString();
        stored.push(existing);
        continue;
      }

      const now = new Date().toISOString();
      const record: SkillPolicyUpdateRecord = {
        id: generateId('skillcfg'),
        skillName: product.skillName,
        updateType: product.updateType,
        applicabilityPattern: product.applicabilityPattern,
        guidance: product.guidance,
        confidence: product.confidence,
        source: 'synthesized',
        reviewStatus: 'suggested',
        createdAt: now,
        updatedAt: now,
      };
      this.updates.push(record);
      stored.push(record);
    }
    if (stored.length > 0) this.save();
    return stored;
  }

  updateReviewStatus(id: string, reviewStatus: SkillPolicyUpdateRecord['reviewStatus']): SkillPolicyUpdateRecord | null {
    const record = this.updates.find(update => update.id === id);
    if (!record) return null;
    record.reviewStatus = reviewStatus;
    record.updatedAt = new Date().toISOString();
    this.save();
    return record;
  }

  replace(record: SkillPolicyUpdateRecord): void {
    const index = this.updates.findIndex(update => update.id === record.id);
    if (index === -1) return;
    this.updates[index] = record;
    this.save();
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8');
        this.updates = JSON.parse(raw);
      }
    } catch {
      this.updates = [];
    }
  }

  private save(): void {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.updates, null, 2));
    } catch {
      // Silently fail.
    }
  }
}