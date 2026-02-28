import { useState } from 'preact/hooks';
import type { InstanceState } from '../hooks/useInstanceState';

interface Props {
  state: InstanceState | null;
  sendCommand: <T>(method: string, path: string, body?: Record<string, unknown> | null) => Promise<{ statusCode: number; data: T }>;
  instanceId: string;
}

interface RunStatus {
  done?: boolean;
  success?: boolean;
  error?: string;
  nodeStates?: Record<string, { status: string; workflowName?: string }>;
  pendingApprovals?: unknown[];
}

export function Pipelines({ state, sendCommand, instanceId }: Props) {
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [error, setError] = useState('');
  const [polling, setPolling] = useState(false);

  const compositions = state?.compositions || [];

  async function triggerRun(compId: string) {
    setError('');
    setRunningId(compId);
    setRunStatus(null);

    try {
      const res = await sendCommand<{ success?: boolean; error?: string }>(
        'POST',
        `/api/compositions/${encodeURIComponent(compId)}/run`,
        { variables: {} }
      );

      if (res.data?.success) {
        // Start polling for status
        setPolling(true);
        pollStatus();
      } else {
        setError(res.data?.error || 'Failed to start run');
        setRunningId(null);
      }
    } catch (err: unknown) {
      setError((err as Error).message || 'Command failed');
      setRunningId(null);
    }
  }

  async function pollStatus() {
    try {
      const res = await sendCommand<RunStatus>('GET', '/api/compositions/run/status');
      setRunStatus(res.data);

      if (res.data?.done) {
        setPolling(false);
        setTimeout(() => {
          setRunningId(null);
          setRunStatus(null);
        }, 5000);
      } else {
        // Continue polling
        setTimeout(() => pollStatus(), 2000);
      }
    } catch {
      setPolling(false);
    }
  }

  async function cancelRun() {
    try {
      await sendCommand('POST', '/api/compositions/run/cancel');
      setPolling(false);
      setRunningId(null);
      setRunStatus(null);
    } catch {}
  }

  if (compositions.length === 0) {
    return (
      <div class="flex flex-col items-center justify-center py-20 px-6 text-center">
        <div class="text-4xl mb-3">{'\u{1F517}'}</div>
        <h2 class="text-lg font-semibold text-gray-300 mb-1">No Pipelines</h2>
        <p class="text-sm text-gray-500">
          Create pipelines in the Woodbury dashboard on your computer.
        </p>
      </div>
    );
  }

  return (
    <div class="px-4 py-4">
      <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">
        Pipelines
      </h2>

      <div class="space-y-3">
        {compositions.map((comp) => {
          const isRunning = runningId === comp.id;
          const nodeCount = comp.nodes ? (comp.nodes as unknown[]).length : 0;

          return (
            <div
              key={comp.id}
              class="bg-dark-800 border border-dark-700 rounded-xl p-4"
            >
              <div class="flex items-start justify-between">
                <div class="flex-1">
                  <h3 class="text-sm font-semibold text-gray-200">
                    {comp.name}
                  </h3>
                  {comp.description && (
                    <p class="text-xs text-gray-500 mt-0.5">
                      {comp.description}
                    </p>
                  )}
                  <div class="text-xs text-gray-600 mt-1">
                    {nodeCount} node{nodeCount !== 1 ? 's' : ''}
                  </div>
                </div>

                <div class="ml-3">
                  {isRunning ? (
                    <button
                      onClick={cancelRun}
                      class="bg-red-600 hover:bg-red-700 text-white text-xs font-medium py-2 px-3 rounded-lg transition"
                    >
                      {'\u25A0'} Stop
                    </button>
                  ) : (
                    <button
                      onClick={() => triggerRun(comp.id)}
                      disabled={!!runningId}
                      class="bg-purple-600 hover:bg-purple-700 text-white text-xs font-medium py-2 px-3 rounded-lg transition disabled:opacity-40"
                    >
                      {'\u25B6'} Run
                    </button>
                  )}
                </div>
              </div>

              {/* Run status */}
              {isRunning && runStatus && (
                <div class="mt-3 pt-3 border-t border-dark-700">
                  {runStatus.done ? (
                    <div
                      class={`text-xs font-medium ${
                        runStatus.success ? 'text-green-400' : 'text-red-400'
                      }`}
                    >
                      {runStatus.success ? '\u2713 Completed' : '\u2717 Failed'}
                      {runStatus.error && (
                        <span class="text-gray-500 ml-2">{runStatus.error}</span>
                      )}
                    </div>
                  ) : (
                    <div class="flex items-center gap-2">
                      <div class="spinner !w-4 !h-4 !border-2" />
                      <span class="text-xs text-gray-400">Running...</span>
                    </div>
                  )}

                  {/* Node statuses */}
                  {runStatus.nodeStates && (
                    <div class="mt-2 space-y-1">
                      {Object.entries(runStatus.nodeStates).map(
                        ([nodeId, ns]) => (
                          <div
                            key={nodeId}
                            class="flex items-center gap-2 text-xs"
                          >
                            <span
                              class={`w-1.5 h-1.5 rounded-full ${
                                ns.status === 'completed'
                                  ? 'bg-green-400'
                                  : ns.status === 'running'
                                  ? 'bg-blue-400'
                                  : ns.status === 'failed'
                                  ? 'bg-red-400'
                                  : 'bg-gray-600'
                              }`}
                            />
                            <span class="text-gray-400">
                              {ns.workflowName || nodeId}
                            </span>
                          </div>
                        )
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <div class="mt-4 text-center text-sm text-red-400">{error}</div>
      )}
    </div>
  );
}
