'use client';

import Link from 'next/link';
import type { Post } from '@/types';
import { formatDateTime, truncateText, getPlatformIcon, getStatusColor, getStatusBgColor } from '@/lib/utils';

export default function PostCard({ post }: { post: Post }) {
  const platforms = post.platforms.filter(p => p.enabled);

  return (
    <Link href={`/posts/${post.id}`}>
      <div className="bg-surface border border-border rounded-lg p-4 hover:border-primary/50 transition-colors">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            {platforms.map(p => (
              <span key={p.platform} title={p.platform}>
                {getPlatformIcon(p.platform)}
              </span>
            ))}
          </div>
          <span className={`text-xs px-2 py-0.5 rounded-full ${getStatusBgColor(post.status)} ${getStatusColor(post.status)}`}>
            {post.status}
          </span>
        </div>

        {/* Content */}
        <p className="text-sm text-foreground/90 mb-2">
          {truncateText(post.content.text, 120)}
        </p>

        {/* Footer */}
        <div className="flex items-center justify-between text-xs text-muted">
          <span>
            {post.scheduledAt ? formatDateTime(post.scheduledAt) : 'Not scheduled'}
          </span>
          {post.tags.length > 0 && (
            <div className="flex gap-1">
              {post.tags.slice(0, 3).map(tag => (
                <span key={tag} className="bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Image indicators */}
        {post.content.images.length > 0 && (
          <div className="mt-2 text-xs text-muted">
            🖼 {post.content.images.length} image{post.content.images.length > 1 ? 's' : ''}
          </div>
        )}
      </div>
    </Link>
  );
}
