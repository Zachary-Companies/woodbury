import { promises as fs } from 'fs';
import * as path from 'path';

export interface QueueItem {
  name: string;
  details: string;
}

export interface WorkQueue {
  sharedContext: string;
  items: QueueItem[];
  completed: QueueItem[];
  skipped: QueueItem[];
  currentItem: QueueItem | null;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface QueueStatus {
  totalItems: number;
  completedCount: number;
  skippedCount: number;
  remainingCount: number;
  currentItem: QueueItem | null;
  sharedContextSummary: string;
}

export interface QueueResult {
  sharedContext: string;
  item: QueueItem;
  progress: {
    completed: number;
    remaining: number;
    total: number;
  };
}

const QUEUE_FILE = '.woodbury-work/queue.json';

let globalQueue: WorkQueue | null = null;

export async function queueInit(sharedContext: string, items: QueueItem[]): Promise<void> {
  // Clear global state first
  globalQueue = null;
  
  // Check if queue file exists and has remaining items
  try {
    const queueData = await fs.readFile(QUEUE_FILE, 'utf-8');
    const existingQueue = JSON.parse(queueData) as WorkQueue;
    if (existingQueue && existingQueue.items.length > 0) {
      throw new Error('A queue already exists with remaining items. Complete it first or clear it.');
    }
  } catch (err) {
    // ENOENT is fine, means no existing queue file
    if ((err as any).code !== 'ENOENT') {
      throw err;
    }
  }

  const queue: WorkQueue = {
    sharedContext,
    items: [...items],
    completed: [],
    skipped: [],
    currentItem: null,
    status: 'pending'
  };

  await saveQueue(queue);
}

export async function queueAddItems(items: QueueItem[]): Promise<void> {
  const queue = await loadQueue();
  queue.items.push(...items);
  await saveQueue(queue);
}

export async function queueNext(): Promise<QueueResult> {
  const queue = await loadQueue();

  if (queue.currentItem) {
    throw new Error('Current item has not been completed yet. Call queueDone first.');
  }

  if (queue.items.length === 0) {
    throw new Error('No more items in queue.');
  }

  const item = queue.items.shift()!;
  queue.currentItem = item;
  queue.status = 'in_progress';

  await saveQueue(queue);

  return {
    sharedContext: queue.sharedContext,
    item,
    progress: {
      completed: queue.completed.length + queue.skipped.length,
      remaining: queue.items.length,
      total: queue.completed.length + queue.skipped.length + queue.items.length + 1
    }
  };
}

export async function queueDone(status: 'completed' | 'skipped', notes?: string): Promise<{ continue: boolean; progress: { completed: number; remaining: number; total: number } }> {
  const queue = await loadQueue();

  if (!queue.currentItem) {
    throw new Error('No current item to mark as done.');
  }

  const item = { ...queue.currentItem };
  if (notes) {
    (item as any).notes = notes;
  }

  if (status === 'completed') {
    queue.completed.push(item);
  } else {
    queue.skipped.push(item);
  }

  queue.currentItem = null;

  if (queue.items.length === 0) {
    queue.status = 'completed';
  } else {
    queue.status = 'pending';
  }

  await saveQueue(queue);

  const progress = {
    completed: queue.completed.length + queue.skipped.length,
    remaining: queue.items.length,
    total: queue.completed.length + queue.skipped.length + queue.items.length
  };

  return {
    continue: queue.items.length > 0,
    progress
  };
}

export async function queueStatus(): Promise<QueueStatus> {
  try {
    const queue = await loadQueue();
    const totalItems = queue.completed.length + queue.skipped.length + queue.items.length + (queue.currentItem ? 1 : 0);

    return {
      totalItems,
      completedCount: queue.completed.length,
      skippedCount: queue.skipped.length,
      remainingCount: queue.items.length,
      currentItem: queue.currentItem,
      sharedContextSummary: queue.sharedContext.substring(0, 200) + (queue.sharedContext.length > 200 ? '...' : '')
    };
  } catch (err) {
    return {
      totalItems: 0,
      completedCount: 0,
      skippedCount: 0,
      remainingCount: 0,
      currentItem: null,
      sharedContextSummary: 'No active queue'
    };
  }
}

async function loadQueue(): Promise<WorkQueue> {
  if (globalQueue) {
    return globalQueue;
  }

  try {
    const queueData = await fs.readFile(QUEUE_FILE, 'utf-8');
    const queue = JSON.parse(queueData) as WorkQueue;
    globalQueue = queue;
    return queue;
  } catch (err) {
    if ((err as any).code === 'ENOENT') {
      throw new Error('No active queue. Call queueInit first.');
    }
    throw err;
  }
}

async function saveQueue(queue: WorkQueue): Promise<void> {
  const dir = path.dirname(QUEUE_FILE);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2));
  globalQueue = queue;
}

// Clear queue for testing
export async function clearQueue(): Promise<void> {
  globalQueue = null;
  try {
    await fs.unlink(QUEUE_FILE);
  } catch (err) {
    // File doesn't exist, that's fine
  }
}
