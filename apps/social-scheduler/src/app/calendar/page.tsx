import { listPosts } from '@/lib/storage';
import CalendarView from '@/components/calendar/CalendarView';

export const dynamic = 'force-dynamic';

export default async function CalendarPage() {
  const posts = await listPosts();
  const now = new Date();

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold mb-6">📅 Calendar</h1>
      <CalendarView
        posts={posts}
        initialYear={now.getFullYear()}
        initialMonth={now.getMonth()}
      />
    </div>
  );
}
