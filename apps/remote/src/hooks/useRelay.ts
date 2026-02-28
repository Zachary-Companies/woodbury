/**
 * useRelay — Send commands to a local Woodbury instance via Firebase RTDB.
 *
 * Commands are written to /instances/{id}/commands/{cmdId}
 * Responses appear at /instances/{id}/responses/{cmdId}
 *
 * Includes a single retry on timeout to handle cases where the relay
 * missed the first command.
 */
import { ref, set, onValue, type Unsubscribe } from 'firebase/database';
import { db } from '../firebase';

const COMMAND_TIMEOUT = 30_000; // 30 seconds

interface RelayOptions {
  instanceId: string;
}

export function useRelay({ instanceId }: RelayOptions) {

  function sendOnce<T = unknown>(
    method: string,
    path: string,
    body?: Record<string, unknown> | null
  ): Promise<{ statusCode: number; data: T }> {
    const cmdId = crypto.randomUUID();
    const cmdRef = ref(db, `instances/${instanceId}/commands/${cmdId}`);
    const respRef = ref(db, `instances/${instanceId}/responses/${cmdId}`);

    return new Promise<{ statusCode: number; data: T }>(async (resolve, reject) => {
      let unsub: Unsubscribe;

      const timer = setTimeout(() => {
        if (unsub) unsub();
        reject(new Error('timeout'));
      }, COMMAND_TIMEOUT);

      // Listen for response first (before writing command to avoid race)
      unsub = onValue(respRef, (snap) => {
        if (snap.exists()) {
          clearTimeout(timer);
          unsub();
          const val = snap.val();
          resolve({
            statusCode: val.statusCode,
            data: val.data as T,
          });
        }
      });

      // Write command
      try {
        await set(cmdRef, {
          method,
          path,
          body: body || null,
          createdAt: Date.now(),
          status: 'pending',
        });
      } catch (err) {
        clearTimeout(timer);
        unsub();
        reject(err);
      }
    });
  }

  async function sendCommand<T = unknown>(
    method: string,
    path: string,
    body?: Record<string, unknown> | null
  ): Promise<{ statusCode: number; data: T }> {
    try {
      return await sendOnce<T>(method, path, body);
    } catch (err) {
      // Retry once on timeout — relay poll fallback may pick up the second attempt
      if (err instanceof Error && err.message === 'timeout') {
        return sendOnce<T>(method, path, body);
      }
      throw err;
    }
  }

  return { sendCommand };
}
