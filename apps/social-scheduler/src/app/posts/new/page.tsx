import PostForm from '@/components/posts/PostForm';
import { listConnectors } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export default async function NewPostPage() {
  const connectors = await listConnectors();

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">✨ New Post</h1>
      <PostForm connectors={connectors} />
    </div>
  );
}
