interface Props {
  activeTab: string;
  onTabChange: (tab: string) => void;
  approvalCount?: number;
}

const tabs = [
  { id: 'pipelines', label: 'Pipelines', icon: '\u{1F517}' },
  { id: 'runs', label: 'Runs', icon: '\u{1F4CA}' },
  { id: 'schedules', label: 'Schedules', icon: '\u23F0' },
  { id: 'approvals', label: 'Approvals', icon: '\u{1F6D1}' },
];

export function BottomNav({ activeTab, onTabChange, approvalCount }: Props) {
  return (
    <nav class="fixed bottom-0 left-0 right-0 bg-dark-800 border-t border-dark-700 pb-[env(safe-area-inset-bottom)]">
      <div class="flex justify-around">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            class={`flex flex-col items-center py-2 px-4 relative ${
              activeTab === tab.id
                ? 'text-purple-400'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            <span class="text-lg">{tab.icon}</span>
            <span class="text-[10px] mt-0.5">{tab.label}</span>
            {tab.id === 'approvals' && approvalCount && approvalCount > 0 ? (
              <span class="absolute top-1 right-2 bg-red-500 text-white text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                {approvalCount > 9 ? '9+' : approvalCount}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </nav>
  );
}
