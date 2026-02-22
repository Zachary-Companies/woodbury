'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const navItems = [
  { href: '/', label: 'Dashboard', icon: '📊' },
  { href: '/calendar', label: 'Calendar', icon: '📅' },
  { href: '/posts', label: 'Posts', icon: '📝' },
  { href: '/posts/new', label: 'New Post', icon: '✨' },
  { href: '/generate', label: 'Generate', icon: '🤖' },
  { href: '/platforms', label: 'Platforms', icon: '📱' },
  { href: '/settings', label: 'Settings', icon: '⚙️' },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 bg-surface border-r border-border min-h-screen p-4 flex flex-col">
      <div className="mb-8">
        <h1 className="text-xl font-bold text-primary">📋 Social Scheduler</h1>
        <p className="text-xs text-muted mt-1">Powered by Woodbury</p>
      </div>

      <nav className="flex-1 space-y-1">
        {navItems.map(item => {
          const isActive = pathname === item.href ||
            (item.href !== '/' && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                isActive
                  ? 'bg-primary/20 text-primary font-medium'
                  : 'text-foreground/70 hover:bg-surface-hover hover:text-foreground'
              }`}
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto pt-4 border-t border-border">
        <p className="text-xs text-muted">
          Data: ~/.woodbury/social-scheduler/
        </p>
      </div>
    </aside>
  );
}
