import { useState } from 'preact/hooks';
import type { InstanceState } from '../hooks/useInstanceState';

interface Props {
  state: InstanceState | null;
  sendCommand: <T>(method: string, path: string, body?: Record<string, unknown> | null) => Promise<{ statusCode: number; data: T }>;
}

export function Approvals({ state, sendCommand }: Props) {
  const [processingId, setProcessingId] = useState<string | null>(null);

  const approvals = state?.pendingApprovals || [];

  async function handleApprove(approvalId: string) {
    setProcessingId(approvalId);
    try {
      await sendCommand(
        'POST',
        `/api/approvals/${encodeURIComponent(approvalId)}/approve`
      );
    } catch {}
    setProcessingId(null);
  }

  async function handleReject(approvalId: string) {
    setProcessingId(approvalId);
    try {
      await sendCommand(
        'POST',
        `/api/approvals/${encodeURIComponent(approvalId)}/reject`
      );
    } catch {}
    setProcessingId(null);
  }

  if (approvals.length === 0) {
    return (
      <div class="flex flex-col items-center justify-center py-20 px-6 text-center">
        <div class="text-4xl mb-3">{'\u{1F6D1}'}</div>
        <h2 class="text-lg font-semibold text-gray-300 mb-1">
          No Pending Approvals
        </h2>
        <p class="text-sm text-gray-500">
          When a pipeline reaches an approval gate, it will appear here.
        </p>
      </div>
    );
  }

  return (
    <div class="px-4 py-4">
      <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">
        Pending Approvals ({approvals.length})
      </h2>

      <div class="space-y-3">
        {approvals.map((approval) => {
          const isProcessing = processingId === approval.id;
          const variables = approval.previewVariables || {};
          const varEntries = Object.entries(variables);

          return (
            <div
              key={approval.id}
              class="bg-dark-800 border border-amber-800/50 rounded-xl overflow-hidden"
            >
              {/* Header */}
              <div class="bg-amber-900/20 px-4 py-3 border-b border-amber-800/30">
                <div class="flex items-center gap-2">
                  <span class="text-amber-400">{'\u{1F6D1}'}</span>
                  <span class="text-sm font-semibold text-amber-200">
                    Approval Required
                  </span>
                </div>
                <div class="text-xs text-gray-400 mt-1">
                  Pipeline: {approval.compositionName}
                </div>
              </div>

              {/* Message */}
              <div class="px-4 py-3">
                <p class="text-sm text-gray-200">{approval.message}</p>

                {/* Variable preview */}
                {varEntries.length > 0 && (
                  <div class="mt-3 space-y-1">
                    <div class="text-xs text-gray-500 font-semibold">
                      Variables:
                    </div>
                    {varEntries.map(([key, val]) => (
                      <div
                        key={key}
                        class="flex justify-between text-xs bg-dark-900 rounded-lg px-3 py-1.5"
                      >
                        <span class="text-purple-400 font-mono">{key}</span>
                        <span class="text-gray-300 truncate ml-3 max-w-[60%] text-right">
                          {typeof val === 'string'
                            ? val
                            : JSON.stringify(val)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Timeout indicator */}
                {approval.timeoutMs && approval.timeoutMs > 0 && (
                  <div class="text-xs text-gray-600 mt-2">
                    Auto-rejects in {Math.round(approval.timeoutMs / 1000)}s if
                    no action taken
                  </div>
                )}
              </div>

              {/* Actions */}
              <div class="flex gap-3 px-4 pb-4">
                <button
                  onClick={() => handleReject(approval.id)}
                  disabled={isProcessing}
                  class="flex-1 bg-red-600 hover:bg-red-700 text-white font-medium py-3 rounded-xl transition disabled:opacity-50 text-sm"
                >
                  {isProcessing ? '...' : '\u2717 Reject'}
                </button>
                <button
                  onClick={() => handleApprove(approval.id)}
                  disabled={isProcessing}
                  class="flex-1 bg-green-600 hover:bg-green-700 text-white font-medium py-3 rounded-xl transition disabled:opacity-50 text-sm"
                >
                  {isProcessing ? '...' : '\u2713 Approve'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
