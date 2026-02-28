/**
 * useInstanceState — Subscribe to real-time state from RTDB.
 *
 * Listens on /instances/{id}/state and /instances/{id}/meta
 * for live updates about the connected Woodbury instance.
 */
import { useState, useEffect } from 'preact/hooks';
import { ref, onValue } from 'firebase/database';
import { db } from '../firebase';

export interface InstanceMeta {
  name: string;
  status: 'online' | 'offline';
  lastSeen: string;
  connectedAt: string;
  version: string;
}

export interface InstanceState {
  compositions: Array<{ id: string; name: string; description?: string; nodes?: unknown[]; edges?: unknown[] }>;
  schedules: Array<{
    id: string; compositionId: string; compositionName: string;
    cron: string; enabled: boolean; description?: string;
    lastRunAt?: string; variables?: Record<string, unknown>;
  }>;
  recentRuns: Array<{
    id: string; type: string; name: string; status: string;
    startedAt: string; completedAt?: string; durationMs: number;
    error?: string; nodesTotal?: number; nodesCompleted?: number;
    stepsTotal?: number; stepsCompleted?: number;
  }>;
  pendingApprovals: Array<{
    id: string; runId: string; nodeId: string;
    compositionId: string; compositionName: string;
    message: string; previewVariables?: Record<string, unknown>;
    createdAt: string; timeoutMs?: number;
  }>;
  lastSyncedAt?: string;
}

const STALENESS_THRESHOLD = 60_000; // 1 minute (heartbeat is 15s)
const ONLINE_CHECK_INTERVAL = 10_000; // Re-check every 10s

export function useInstanceState(instanceId: string | null) {
  const [meta, setMeta] = useState<InstanceMeta | null>(null);
  const [state, setState] = useState<InstanceState | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0); // Forces isOnline recalculation

  useEffect(() => {
    if (!instanceId) {
      setLoading(false);
      return;
    }

    const metaRef = ref(db, `instances/${instanceId}/meta`);
    const stateRef = ref(db, `instances/${instanceId}/state`);

    const unsubMeta = onValue(metaRef, (snap) => {
      if (snap.exists()) {
        const val = snap.val();
        setMeta({
          name: val.name || 'Unknown',
          status: val.status || 'offline',
          lastSeen: val.lastSeen || '',
          connectedAt: val.connectedAt || '',
          version: val.version || '',
        });
      } else {
        setMeta(null);
      }
      setLoading(false);
    });

    const unsubState = onValue(stateRef, (snap) => {
      if (snap.exists()) {
        const val = snap.val();
        setState({
          compositions: val.compositions || [],
          schedules: val.schedules || [],
          recentRuns: val.recentRuns || [],
          pendingApprovals: val.pendingApprovals || [],
          lastSyncedAt: val.lastSyncedAt,
        });
      }
    });

    // Periodically bump tick so isOnline recalculates against fresh Date.now()
    const onlineCheckTimer = setInterval(() => {
      setTick((t) => t + 1);
    }, ONLINE_CHECK_INTERVAL);

    return () => {
      unsubMeta();
      unsubState();
      clearInterval(onlineCheckTimer);
    };
  }, [instanceId]);

  const isOnline = meta?.status === 'online' && meta?.lastSeen
    ? (Date.now() - new Date(meta.lastSeen).getTime()) < STALENESS_THRESHOLD
    : false;

  // tick is used in the dependency chain to ensure isOnline recalculates
  void tick;

  return { meta, state, loading, isOnline };
}
