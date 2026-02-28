import { useState } from 'preact/hooks';
import { route } from 'preact-router';
import type { User } from 'firebase/auth';
import { useInstanceState } from '../hooks/useInstanceState';
import { useRelay } from '../hooks/useRelay';
import { StatusBar } from '../components/StatusBar';
import { BottomNav } from '../components/BottomNav';
import { Pipelines } from './Pipelines';
import { Runs } from './Runs';
import { Schedules } from './Schedules';
import { Approvals } from './Approvals';

interface Props {
  path?: string;
  default?: boolean;
  user: User;
  tab?: string;
}

export function Dashboard({ user, tab }: Props) {
  const instanceId = localStorage.getItem('woodbury_instance');
  const [activeTab, setActiveTab] = useState(tab || 'pipelines');
  const { meta, state, loading, isOnline } = useInstanceState(instanceId);
  const { sendCommand } = useRelay({ instanceId: instanceId || '' });

  if (!instanceId) {
    route('/connect');
    return null;
  }

  if (loading) {
    return (
      <div class="flex items-center justify-center min-h-screen">
        <div class="spinner" />
      </div>
    );
  }

  function handleDisconnect() {
    localStorage.removeItem('woodbury_instance');
    route('/connect');
  }

  function handleTabChange(t: string) {
    setActiveTab(t);
  }

  const approvalCount = state?.pendingApprovals?.length || 0;

  return (
    <div class="flex flex-col min-h-screen">
      <StatusBar meta={meta} isOnline={isOnline} onDisconnect={handleDisconnect} />

      {/* Main content area — scrollable, with bottom padding for nav */}
      <div class="flex-1 overflow-y-auto pb-20">
        {!isOnline && (
          <div class="bg-red-900/30 border-b border-red-800/50 px-4 py-2 text-center text-sm text-red-300">
            Instance is offline. Commands will be queued.
          </div>
        )}

        {activeTab === 'pipelines' && (
          <Pipelines
            state={state}
            sendCommand={sendCommand}
            instanceId={instanceId}
          />
        )}
        {activeTab === 'runs' && (
          <Runs state={state} sendCommand={sendCommand} />
        )}
        {activeTab === 'schedules' && (
          <Schedules state={state} sendCommand={sendCommand} />
        )}
        {activeTab === 'approvals' && (
          <Approvals state={state} sendCommand={sendCommand} />
        )}
      </div>

      <BottomNav
        activeTab={activeTab}
        onTabChange={handleTabChange}
        approvalCount={approvalCount}
      />
    </div>
  );
}
