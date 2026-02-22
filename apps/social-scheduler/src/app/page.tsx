import Link from 'next/link';
import { listPosts, getDuePosts, getStatusCounts, listConnectors } from '@/lib/storage';
import { formatDateTime, truncateText, getPlatformIcon, getStatusColor } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const [counts, duePosts, recentPosts, connectors] = await Promise.all([
    getStatusCounts(),
    getDuePosts(),
    listPosts(),
    listConnectors(),
  ]);

  const upcoming = recentPosts
    .filter(p => p.status === 'scheduled' && p.scheduledAt)
    .slice(0, 5);

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <Link
          href="/posts/new"
          className="bg-primary hover:bg-primary-hover text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          ✨ New Post
        </Link>
      </div>

      {/* Status Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard label="Drafts" count={counts.draft} color="text-muted" />
        <StatCard label="Scheduled" count={counts.scheduled} color="text-secondary" />
        <StatCard label="Posted" count={counts.posted} color="text-success" />
        <StatCard label="Failed" count={counts.failed} color="text-danger" />
      </div>

      {/* Due Now Alert */}
      {duePosts.length > 0 && (
        <div className="bg-warning/10 border border-warning/30 rounded-lg p-4 mb-8">
          <h2 className="text-warning font-medium mb-2">
            ⏰ {duePosts.length} post{duePosts.length > 1 ? 's' : ''} due now
          </h2>
          <p className="text-sm text-muted mb-3">
            Tell Woodbury: &quot;post the scheduled items&quot;
          </p>
          {duePosts.map(post => (
            <div key={post.id} className="text-sm text-foreground/80 mb-1">
              <Link href={`/posts/${post.id}`} className="hover:text-primary">
                {getPlatformIcons(post)} {truncateText(post.content.text, 60)}
              </Link>
            </div>
          ))}
        </div>
      )}

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Upcoming Posts */}
        <section>
          <h2 className="text-lg font-semibold mb-4">📅 Upcoming</h2>
          {upcoming.length === 0 ? (
            <p className="text-muted text-sm">No scheduled posts.</p>
          ) : (
            <div className="space-y-3">
              {upcoming.map(post => (
                <Link key={post.id} href={`/posts/${post.id}`}>
                  <div className="bg-surface rounded-lg p-3 hover:bg-surface-hover transition-colors">
                    <div className="flex items-center gap-2 text-xs text-muted mb-1">
                      {getPlatformIcons(post)}
                      <span>{formatDateTime(post.scheduledAt!)}</span>
                      <span className={getStatusColor(post.status)}>
                        {post.status}
                      </span>
                    </div>
                    <p className="text-sm">{truncateText(post.content.text, 80)}</p>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* Platform Connectors */}
        <section>
          <h2 className="text-lg font-semibold mb-4">📱 Platforms</h2>
          {connectors.length === 0 ? (
            <p className="text-muted text-sm">No platforms configured.</p>
          ) : (
            <div className="space-y-3">
              {connectors.map(c => (
                <div key={c.platform} className="bg-surface rounded-lg p-3">
                  <div className="flex items-center gap-2">
                    <span>{getPlatformIcon(c.platform)}</span>
                    <span className="font-medium">{c.displayName}</span>
                    <span className="text-xs text-muted ml-auto">
                      max {c.maxTextLength} chars
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function StatCard({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div className="bg-surface rounded-lg p-4">
      <p className="text-xs text-muted uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${color}`}>{count}</p>
    </div>
  );
}

function getPlatformIcons(post: { platforms: { platform: string; enabled: boolean }[] }) {
  return post.platforms
    .filter(p => p.enabled)
    .map(p => getPlatformIcon(p.platform))
    .join('');
}
