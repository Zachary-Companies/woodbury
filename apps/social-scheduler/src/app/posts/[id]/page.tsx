import { notFound } from 'next/navigation';
import PostForm from '@/components/posts/PostForm';
import { getPost, listConnectors } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export default async function EditPostPage({ params }: { params: { id: string } }) {
  const [post, connectors] = await Promise.all([
    getPost(params.id),
    listConnectors(),
  ]);

  if (!post) notFound();

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">📝 Edit Post</h1>
      <PostForm post={post} connectors={connectors} />
    </div>
  );
}
