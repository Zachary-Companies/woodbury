import Link from 'next/link';
import { listPosts } from '@/lib/storage';
import PostCard from '@/components/posts/PostCard';

export const dynamic = 'force-dynamic';

export default async function PostsPage({
  searchParams,
}: {
  searchParams: { status?: string; platform?: string };
}) {
  const posts = await listPosts({
    status: searchParams.status as any,
    platform: searchParams.platform,
  });

  const statuses = ['all', 'draft', 'scheduled', 'posted', 'failed'];

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">📝 Posts</h1>
        <Link
          href="/posts/new"
          className="bg-primary hover:bg-primary-hover text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          ✨ New Post
        </Link>
      </div>

      {/* Filter Tabs */}
      <div className="flex gap-2 mb-6">
        {statuses.map(s => (
          <Link
            key={s}
            href={s === 'all' ? '/posts' : `/posts?status=${s}`}
            className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
              (s === 'all' && !searchParams.status) || searchParams.status === s
                ? 'bg-primary/20 text-primary font-medium'
                : 'bg-surface text-muted hover:bg-surface-hover'
            }`}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </Link>
        ))}
      </div>

      {/* Post Grid */}
      {posts.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-muted text-lg mb-2">No posts found</p>
          <p className="text-muted/60 text-sm mb-4">
            Create your first post to get started.
          </p>
          <Link
            href="/posts/new"
            className="text-primary hover:underline text-sm"
          >
            Create a post →
          </Link>
        </div>
      ) : (
        <div className="grid gap-4">
          {posts.map(post => (
            <PostCard key={post.id} post={post} />
          ))}
        </div>
      )}
    </div>
  );
}
