'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Post } from '@/types';
import { getPlatformIcon, getStatusColor, truncateText, getCalendarDates } from '@/lib/utils';

interface CalendarViewProps {
  posts: Post[];
  initialYear: number;
  initialMonth: number;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

export default function CalendarView({ posts, initialYear, initialMonth }: CalendarViewProps) {
  const [year, setYear] = useState(initialYear);
  const [month, setMonth] = useState(initialMonth);

  const dates = getCalendarDates(year, month);

  const prevMonth = () => {
    if (month === 0) { setYear(y => y - 1); setMonth(11); }
    else setMonth(m => m - 1);
  };

  const nextMonth = () => {
    if (month === 11) { setYear(y => y + 1); setMonth(0); }
    else setMonth(m => m + 1);
  };

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  // Group posts by date
  const postsByDate: Record<string, Post[]> = {};
  for (const post of posts) {
    if (post.scheduledAt) {
      const d = new Date(post.scheduledAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (!postsByDate[key]) postsByDate[key] = [];
      postsByDate[key].push(post);
    }
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <button
          onClick={prevMonth}
          className="text-muted hover:text-foreground px-3 py-1 rounded-lg hover:bg-surface transition-colors"
        >
          ← Prev
        </button>
        <h2 className="text-xl font-semibold">
          {MONTHS[month]} {year}
        </h2>
        <button
          onClick={nextMonth}
          className="text-muted hover:text-foreground px-3 py-1 rounded-lg hover:bg-surface transition-colors"
        >
          Next →
        </button>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 gap-px mb-px">
        {DAYS.map(day => (
          <div key={day} className="text-center text-xs text-muted font-medium py-2">
            {day}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7 gap-px bg-border rounded-lg overflow-hidden">
        {dates.map((date, i) => {
          const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
          const isCurrentMonth = date.getMonth() === month;
          const isToday = dateStr === todayStr;
          const dayPosts = postsByDate[dateStr] || [];

          return (
            <div
              key={i}
              className={`min-h-[100px] p-2 ${
                isCurrentMonth ? 'bg-surface' : 'bg-background'
              } ${isToday ? 'ring-1 ring-primary' : ''}`}
            >
              <div className={`text-xs mb-1 ${
                isToday ? 'text-primary font-bold' :
                isCurrentMonth ? 'text-foreground/70' : 'text-muted/40'
              }`}>
                {date.getDate()}
              </div>

              {/* Post indicators */}
              <div className="space-y-1">
                {dayPosts.slice(0, 3).map(post => (
                  <Link key={post.id} href={`/posts/${post.id}`}>
                    <div className={`text-[10px] px-1 py-0.5 rounded truncate hover:bg-primary/20 transition-colors ${getStatusColor(post.status)}`}>
                      {post.platforms.filter(p => p.enabled).map(p => getPlatformIcon(p.platform)).join('')}
                      {' '}{truncateText(post.content.text, 20)}
                    </div>
                  </Link>
                ))}
                {dayPosts.length > 3 && (
                  <div className="text-[10px] text-muted">
                    +{dayPosts.length - 3} more
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
