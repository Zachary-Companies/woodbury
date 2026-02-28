import { signOut } from 'firebase/auth';
import { route } from 'preact-router';
import { auth } from '../firebase';
import type { InstanceMeta } from '../hooks/useInstanceState';

interface Props {
  meta: InstanceMeta | null;
  isOnline: boolean;
  onDisconnect?: () => void;
}

export function StatusBar({ meta, isOnline, onDisconnect }: Props) {
  function handleSignOut() {
    signOut(auth);
    localStorage.removeItem('woodbury_instance');
    localStorage.removeItem('woodbury_instances');
    route('/');
  }

  return (
    <div class="flex items-center justify-between px-4 py-3 bg-dark-800 border-b border-dark-700">
      <div class="flex items-center gap-2">
        <div
          class={`w-2.5 h-2.5 rounded-full ${isOnline ? 'bg-green-400' : 'bg-red-400'}`}
        />
        <span class="text-sm font-medium text-gray-200">
          {meta?.name || 'Not connected'}
        </span>
        {meta?.version && (
          <span class="text-xs text-gray-500">v{meta.version}</span>
        )}
      </div>
      <div class="flex items-center gap-3">
        <span class={`text-xs ${isOnline ? 'text-green-400' : 'text-red-400'}`}>
          {isOnline ? 'Online' : 'Offline'}
        </span>
        {onDisconnect && (
          <button
            onClick={onDisconnect}
            class="text-xs text-gray-500 hover:text-gray-300"
          >
            Switch
          </button>
        )}
        <button
          onClick={handleSignOut}
          class="text-xs text-gray-500 hover:text-red-400"
          title="Sign out"
        >
          Sign Out
        </button>
      </div>
    </div>
  );
}
