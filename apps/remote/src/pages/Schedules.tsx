import { useState } from 'preact/hooks';
import type { InstanceState } from '../hooks/useInstanceState';

interface Props {
  state: InstanceState | null;
  sendCommand: <T>(method: string, path: string, body?: Record<string, unknown> | null) => Promise<{ statusCode: number; data: T }>;
}

const PRESETS = [
  { label: 'Every 5 minutes', cron: '*/5 * * * *' },
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Every 30 minutes', cron: '*/30 * * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Daily at 9:00 AM', cron: '0 9 * * *' },
  { label: 'Weekdays at 9:00 AM', cron: '0 9 * * 1-5' },
  { label: 'Weekly (Mon 9 AM)', cron: '0 9 * * 1' },
  { label: 'Daily at midnight', cron: '0 0 * * *' },
];

function cronToHuman(cron: string): string {
  if (!cron) return '';
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hr, dom, mon, dow] = parts;

  if (min === '*' && hr === '*' && dom === '*' && mon === '*' && dow === '*')
    return 'Every minute';
  if (min.startsWith('*/') && hr === '*' && dom === '*' && mon === '*' && dow === '*')
    return `Every ${min.slice(2)} minutes`;
  if (hr === '*' && dom === '*' && mon === '*' && dow === '*')
    return `Every hour at :${min.padStart(2, '0')}`;
  if (dom === '*' && mon === '*' && dow === '*')
    return `Daily at ${hr}:${min.padStart(2, '0')}`;
  if (dom === '*' && mon === '*' && dow !== '*') {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dowNames = dow
      .split(',')
      .map((d: string) => {
        if (d.includes('-')) {
          const [a, b] = d.split('-').map(Number);
          return days.slice(a, b + 1).join(', ');
        }
        return days[parseInt(d)] || d;
      })
      .join(', ');
    return `${dowNames} at ${hr}:${min.padStart(2, '0')}`;
  }
  return cron;
}

export function Schedules({ state, sendCommand }: Props) {
  const [showAdd, setShowAdd] = useState(false);
  const [newCron, setNewCron] = useState('0 9 * * *');
  const [newDesc, setNewDesc] = useState('');
  const [newCompId, setNewCompId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const schedules = state?.schedules || [];
  const compositions = state?.compositions || [];

  async function toggleSchedule(scheduleId: string, enabled: boolean) {
    try {
      await sendCommand('PUT', `/api/schedules/${encodeURIComponent(scheduleId)}`, {
        enabled,
      });
    } catch {}
  }

  async function deleteSchedule(scheduleId: string) {
    if (!confirm('Delete this schedule?')) return;
    try {
      await sendCommand('DELETE', `/api/schedules/${encodeURIComponent(scheduleId)}`);
    } catch {}
  }

  async function createSchedule() {
    if (!newCompId) {
      setError('Select a pipeline');
      return;
    }
    const parts = newCron.trim().split(/\s+/);
    if (parts.length !== 5) {
      setError('Invalid cron (need 5 fields)');
      return;
    }

    setBusy(true);
    setError('');
    try {
      const res = await sendCommand<{ error?: string }>('POST', '/api/schedules', {
        compositionId: newCompId,
        cron: newCron.trim(),
        enabled: true,
        description: newDesc,
      });
      if (res.statusCode >= 400) {
        setError((res.data as { error?: string })?.error || 'Failed');
      } else {
        setShowAdd(false);
        setNewCron('0 9 * * *');
        setNewDesc('');
        setNewCompId('');
      }
    } catch (err: unknown) {
      setError((err as Error).message || 'Failed');
    }
    setBusy(false);
  }

  return (
    <div class="px-4 py-4">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wide">
          Schedules
        </h2>
        <button
          onClick={() => setShowAdd(!showAdd)}
          class="text-xs bg-cyan-600 hover:bg-cyan-700 text-white font-medium py-1.5 px-3 rounded-lg transition"
        >
          {showAdd ? 'Cancel' : '+ Add'}
        </button>
      </div>

      {/* Add form */}
      {showAdd && (
        <div class="bg-dark-800 border border-cyan-800 rounded-xl p-4 mb-4 space-y-3">
          {/* Pipeline selector */}
          <div>
            <label class="text-xs text-gray-400 block mb-1">Pipeline</label>
            <select
              value={newCompId}
              onChange={(e) =>
                setNewCompId((e.target as HTMLSelectElement).value)
              }
              class="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-gray-200"
            >
              <option value="">Select a pipeline...</option>
              {compositions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {/* Preset */}
          <div>
            <label class="text-xs text-gray-400 block mb-1">Preset</label>
            <select
              onChange={(e) => {
                const val = (e.target as HTMLSelectElement).value;
                if (val) setNewCron(val);
              }}
              class="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-gray-200"
            >
              <option value="">Custom...</option>
              {PRESETS.map((p) => (
                <option key={p.cron} value={p.cron}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          {/* Cron input */}
          <div>
            <label class="text-xs text-gray-400 block mb-1">
              Cron Expression
            </label>
            <input
              type="text"
              value={newCron}
              onInput={(e) =>
                setNewCron((e.target as HTMLInputElement).value)
              }
              placeholder="* * * * *"
              class="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-gray-200 font-mono"
            />
            <div class="text-xs text-cyan-400 mt-1">
              {cronToHuman(newCron)}
            </div>
          </div>

          {/* Description */}
          <div>
            <label class="text-xs text-gray-400 block mb-1">
              Description (optional)
            </label>
            <input
              type="text"
              value={newDesc}
              onInput={(e) =>
                setNewDesc((e.target as HTMLInputElement).value)
              }
              placeholder="e.g. Morning social media post"
              class="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-gray-200"
            />
          </div>

          {error && (
            <div class="text-xs text-red-400">{error}</div>
          )}

          <button
            onClick={createSchedule}
            disabled={busy}
            class="w-full bg-cyan-600 hover:bg-cyan-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
          >
            {busy ? 'Creating...' : 'Create Schedule'}
          </button>
        </div>
      )}

      {/* Schedule list */}
      {schedules.length === 0 ? (
        <div class="flex flex-col items-center justify-center py-16 text-center">
          <div class="text-4xl mb-3">{'\u23F0'}</div>
          <h2 class="text-lg font-semibold text-gray-300 mb-1">
            No Schedules
          </h2>
          <p class="text-sm text-gray-500">
            Create a schedule to run pipelines automatically.
          </p>
        </div>
      ) : (
        <div class="space-y-2">
          {schedules.map((sched) => (
            <div
              key={sched.id}
              class="bg-dark-800 border border-dark-700 rounded-xl px-4 py-3"
            >
              <div class="flex items-center gap-3">
                {/* Toggle */}
                <input
                  type="checkbox"
                  checked={sched.enabled}
                  onChange={(e) =>
                    toggleSchedule(
                      sched.id,
                      (e.target as HTMLInputElement).checked
                    )
                  }
                  class="w-4 h-4 accent-cyan-500 cursor-pointer"
                />

                <div class="flex-1 min-w-0">
                  <div class="text-sm font-medium text-gray-200">
                    {sched.compositionName}
                  </div>
                  <div class="text-xs text-cyan-400 font-mono">
                    {sched.cron}
                  </div>
                  <div class="text-xs text-gray-500">
                    {cronToHuman(sched.cron)}
                  </div>
                  {sched.description && (
                    <div class="text-xs text-gray-600 mt-0.5">
                      {sched.description}
                    </div>
                  )}
                  {sched.lastRunAt && (
                    <div class="text-[10px] text-gray-600 mt-0.5">
                      Last run:{' '}
                      {new Date(sched.lastRunAt).toLocaleString()}
                    </div>
                  )}
                </div>

                <button
                  onClick={() => deleteSchedule(sched.id)}
                  class="text-gray-500 hover:text-red-400 text-lg"
                >
                  {'\u{1F5D1}'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
