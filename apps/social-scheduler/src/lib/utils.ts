/**
 * Utility functions for the social scheduler.
 */

import type { Post, PostStatus } from '@/types';

export function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric'
  });
}

export function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit'
  });
}

export function formatDateTime(dateStr: string): string {
  return `${formatDate(dateStr)} at ${formatTime(dateStr)}`;
}

export function relativeTime(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = date.getTime() - now.getTime();
  const diffMin = Math.round(diffMs / 60000);
  const diffHr = Math.round(diffMs / 3600000);
  const diffDay = Math.round(diffMs / 86400000);

  if (Math.abs(diffMin) < 60) return diffMin > 0 ? `in ${diffMin}m` : `${-diffMin}m ago`;
  if (Math.abs(diffHr) < 24) return diffHr > 0 ? `in ${diffHr}h` : `${-diffHr}h ago`;
  return diffDay > 0 ? `in ${diffDay}d` : `${-diffDay}d ago`;
}

export function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

export function getStatusColor(status: PostStatus): string {
  switch (status) {
    case 'draft': return 'text-muted';
    case 'scheduled': return 'text-secondary';
    case 'posting': return 'text-warning';
    case 'posted': return 'text-success';
    case 'partial': return 'text-warning';
    case 'failed': return 'text-danger';
    default: return 'text-muted';
  }
}

export function getStatusBgColor(status: PostStatus): string {
  switch (status) {
    case 'draft': return 'bg-muted/20';
    case 'scheduled': return 'bg-secondary/20';
    case 'posting': return 'bg-warning/20';
    case 'posted': return 'bg-success/20';
    case 'partial': return 'bg-warning/20';
    case 'failed': return 'bg-danger/20';
    default: return 'bg-muted/20';
  }
}

export function getPlatformIcon(platform: string): string {
  switch (platform) {
    case 'instagram': return '📷';
    case 'twitter': return '🐦';
    case 'facebook': return '📘';
    case 'linkedin': return '💼';
    case 'tiktok': return '🎵';
    case 'youtube': return '🎬';
    default: return '📱';
  }
}

export function isDue(post: Post): boolean {
  return post.status === 'scheduled' && !!post.scheduledAt && new Date(post.scheduledAt) <= new Date();
}

export function getCalendarDates(year: number, month: number): Date[] {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);

  // Start from the Sunday before the first day
  const startDate = new Date(firstDay);
  startDate.setDate(startDate.getDate() - startDate.getDay());

  // End at the Saturday after the last day
  const endDate = new Date(lastDay);
  endDate.setDate(endDate.getDate() + (6 - endDate.getDay()));

  const dates: Date[] = [];
  const current = new Date(startDate);
  while (current <= endDate) {
    dates.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}
