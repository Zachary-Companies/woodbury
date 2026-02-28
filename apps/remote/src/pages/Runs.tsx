import { useState } from 'preact/hooks';
import type { InstanceState } from '../hooks/useInstanceState';

interface Props {
  state: InstanceState | null;
  sendCommand: <T>(method: string, path: string, body?: Record<string, unknown> | null) => Promise<{ statusCode: number; data: T }>;
}

type StatusFilter = 'all' | 'completed' | 'failed' | 'cancelled';

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

const statusColors: Record<string, string> = {
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  cancelled: 'bg-amber-500',
  running: 'bg-blue-500',
};

const statusIcons: Record<string, string> = {
  completed: '\u2713',
  failed: '\u2717',
  cancelled: '\u25A0',
  running: '\u25B6',
};

export function Runs({ state }: Props) {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  const runs = state?.recentRuns || [];
  const filtered =
    filter === 'all' ? runs : runs.filter((r) => r.status === filter);

  if (runs.length === 0) {
    return (
      <div class="flex flex-col items-center justify-center py-20 px-6 text-center">
        <div class="text-4xl mb-3">{'\u{1F4CA}'}</div>
        <h2 class="text-lg font-semibold text-gray-300 mb-1">No Runs Yet</h2>
        <p class="text-sm text-gray-500">
          Run a pipeline to see history here.
        </p>
      </div>
    );
  }

  return (
    <div class="px-4 py-4">
      {/* Filter bar */}
      <div class="flex gap-2 mb-4 overflow-x-auto">
        {(['all', 'completed', 'failed', 'cancelled'] as StatusFilter[]).map(
          (f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              class={`text-xs font-medium px-3 py-1.5 rounded-full whitespace-nowrap transition ${
                filter === f
                  ? 'bg-purple-600 text-white'
                  : 'bg-dark-800 text-gray-400 hover:bg-dark-700'
              }`}
            >
              {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          )
        )}
      </div>

      {/* Run list */}
      <div class="space-y-2">
        {filtered.map((run) => (
          <div
            key={run.id}
            class="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden"
          >
            <button
              onClick={() =>
                setExpandedRun(expandedRun === run.id ? null : run.id)
              }
              class="w-full text-left px-4 py-3 flex items-center gap-3"
            >
              {/* Status dot */}
              <span
                class={`w-2 h-2 rounded-full flex-shrink-0 ${
                  statusColors[run.status] || 'bg-gray-500'
                }`}
              />

              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-gray-200 truncate">
                  {run.name}
                </div>
                <div class="flex items-center gap-2 text-xs text-gray-500 mt-0.5">
                  <span>{formatTime(run.startedAt)}</span>
                  <span>{'\u00B7'}</span>
                  <span>{formatDuration(run.durationMs)}</span>
                  <span>{'\u00B7'}</span>
                  <span>{run.type}</span>
                </div>
              </div>

              <span class="text-xs text-gray-500">
                {statusIcons[run.status] || '?'}
              </span>
            </button>

            {/* Expanded detail */}
            {expandedRun === run.id && (
              <div class="px-4 pb-3 border-t border-dark-700 pt-3 space-y-2">
                <div class="flex justify-between text-xs">
                  <span class="text-gray-500">Status</span>
                  <span
                    class={
                      run.status === 'completed'
                        ? 'text-green-400'
                        : run.status === 'failed'
                        ? 'text-red-400'
                        : 'text-gray-300'
                    }
                  >
                    {run.status}
                  </span>
                </div>

                {run.type === 'pipeline' &&
                  run.nodesTotal !== undefined && (
                    <div class="flex justify-between text-xs">
                      <span class="text-gray-500">Nodes</span>
                      <span class="text-gray-300">
                        {run.nodesCompleted || 0}/{run.nodesTotal}
                      </span>
                    </div>
                  )}

                {run.type === 'workflow' &&
                  run.stepsTotal !== undefined && (
                    <div class="flex justify-between text-xs">
                      <span class="text-gray-500">Steps</span>
                      <span class="text-gray-300">
                        {run.stepsCompleted || 0}/{run.stepsTotal}
                      </span>
                    </div>
                  )}

                {run.error && (
                  <div class="text-xs text-red-400 bg-red-900/20 rounded-lg p-2 mt-2">
                    {run.error}
                  </div>
                )}

                <div class="flex justify-between text-xs">
                  <span class="text-gray-500">Duration</span>
                  <span class="text-gray-300">
                    {formatDuration(run.durationMs)}
                  </span>
                </div>

                {run.completedAt && (
                  <div class="flex justify-between text-xs">
                    <span class="text-gray-500">Completed</span>
                    <span class="text-gray-300">
                      {formatTime(run.completedAt)}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {filtered.length === 0 && (
        <div class="text-center text-sm text-gray-500 py-8">
          No {filter} runs found.
        </div>
      )}
    </div>
  );
}
