import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

// ── Interfaces ────────────────────────────────────────────────

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface Job {
  id: number;
  name: string;
  task: string;
  context: string;
  dependsOn: number[];
  status: JobStatus;
  result: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface JobFile {
  description: string;
  createdAt: string;
  updatedAt: string;
  jobs: Job[];
}

// ── Paths ─────────────────────────────────────────────────────

const WORK_DIR = '.woodbury-work';
const JOBS_FILENAME = 'jobs.json';

export function jobFilePath(workingDirectory: string): string {
  return join(workingDirectory, WORK_DIR, JOBS_FILENAME);
}

// ── Validation ────────────────────────────────────────────────

export interface ValidationError {
  message: string;
}

export function validateJobFile(data: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return [{ message: 'Job file must be a JSON object' }];
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.description !== 'string' || !obj.description.trim()) {
    errors.push({ message: 'Missing or empty "description" field' });
  }

  if (!Array.isArray(obj.jobs)) {
    errors.push({ message: '"jobs" must be an array' });
    return errors;
  }

  const jobs = obj.jobs as unknown[];
  if (jobs.length === 0) {
    errors.push({ message: '"jobs" array must not be empty' });
    return errors;
  }

  const seenIds = new Set<number>();
  const validStatuses: Set<string> = new Set(['pending', 'running', 'completed', 'failed']);

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const prefix = `jobs[${i}]`;

    if (typeof job !== 'object' || job === null || Array.isArray(job)) {
      errors.push({ message: `${prefix}: must be an object` });
      continue;
    }

    const j = job as Record<string, unknown>;

    // Required fields
    if (typeof j.id !== 'number' || !Number.isInteger(j.id)) {
      errors.push({ message: `${prefix}: "id" must be an integer` });
    } else {
      if (seenIds.has(j.id)) {
        errors.push({ message: `${prefix}: duplicate id ${j.id}` });
      }
      seenIds.add(j.id);
    }

    if (typeof j.name !== 'string' || !j.name.trim()) {
      errors.push({ message: `${prefix}: "name" must be a non-empty string` });
    }

    if (typeof j.task !== 'string' || !j.task.trim()) {
      errors.push({ message: `${prefix}: "task" must be a non-empty string` });
    }

    if (typeof j.context !== 'string') {
      errors.push({ message: `${prefix}: "context" must be a string` });
    }

    if (!Array.isArray(j.dependsOn)) {
      errors.push({ message: `${prefix}: "dependsOn" must be an array` });
    }

    if (typeof j.status === 'string' && !validStatuses.has(j.status)) {
      errors.push({ message: `${prefix}: invalid status "${j.status}"` });
    }
  }

  // Validate dependsOn references
  for (const job of jobs) {
    const j = job as Record<string, unknown>;
    if (!Array.isArray(j.dependsOn) || typeof j.id !== 'number') continue;

    for (const depId of j.dependsOn as unknown[]) {
      if (typeof depId !== 'number') {
        errors.push({ message: `jobs[id=${j.id}]: dependsOn entry must be a number, got ${typeof depId}` });
      } else if (!seenIds.has(depId)) {
        errors.push({ message: `jobs[id=${j.id}]: dependsOn references non-existent job ${depId}` });
      }
    }
  }

  // Circular dependency detection (Kahn's algorithm)
  if (errors.length === 0) {
    const circularError = detectCycles(obj.jobs as Job[]);
    if (circularError) {
      errors.push({ message: circularError });
    }
  }

  return errors;
}

function detectCycles(jobs: Job[]): string | null {
  const inDegree = new Map<number, number>();
  const adjacency = new Map<number, number[]>();

  for (const job of jobs) {
    inDegree.set(job.id, 0);
    adjacency.set(job.id, []);
  }

  for (const job of jobs) {
    for (const depId of job.dependsOn) {
      // depId → job.id (depId must complete before job.id)
      adjacency.get(depId)!.push(job.id);
      inDegree.set(job.id, (inDegree.get(job.id) ?? 0) + 1);
    }
  }

  const queue: number[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  let processed = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    processed++;
    for (const neighbor of adjacency.get(id) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (processed < jobs.length) {
    return 'Circular dependency detected among jobs';
  }
  return null;
}

// ── Disk I/O ──────────────────────────────────────────────────

export async function loadJobFile(path: string): Promise<JobFile> {
  const raw = await readFile(path, 'utf-8');
  const data = JSON.parse(raw);

  const errors = validateJobFile(data);
  if (errors.length > 0) {
    throw new Error(`Invalid job file: ${errors.map(e => e.message).join('; ')}`);
  }

  return data as JobFile;
}

export async function saveJobFile(path: string, jobFile: JobFile): Promise<void> {
  jobFile.updatedAt = new Date().toISOString();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(jobFile, null, 2) + '\n', 'utf-8');
}

export function createJobFile(description: string, jobs: Job[]): JobFile {
  const now = new Date().toISOString();
  return {
    description,
    createdAt: now,
    updatedAt: now,
    jobs,
  };
}
