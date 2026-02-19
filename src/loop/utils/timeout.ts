/**
 * Timeout utility with proper timer cleanup
 */

/**
 * Execute a promise with a timeout, ensuring the timer is always cleaned up.
 * Unlike a bare Promise.race with setTimeout, this avoids leaking timers.
 */
export async function executeWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage = 'Tool execution timed out'
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
