import { NextRequest, NextResponse } from 'next/server';
import { listPosts, createPost } from '@/lib/storage';
import type { PostFilters, CreatePostInput } from '@/types';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const filters: PostFilters = {};
    if (searchParams.get('status')) filters.status = searchParams.get('status') as any;
    if (searchParams.get('platform')) filters.platform = searchParams.get('platform')!;
    if (searchParams.get('from')) filters.from = searchParams.get('from')!;
    if (searchParams.get('to')) filters.to = searchParams.get('to')!;
    if (searchParams.get('tag')) filters.tag = searchParams.get('tag')!;

    const posts = await listPosts(filters);
    return NextResponse.json(posts);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body: CreatePostInput = await request.json();

    if (!body.text || !body.platforms || body.platforms.length === 0) {
      return NextResponse.json(
        { error: 'text and platforms are required' },
        { status: 400 }
      );
    }

    const post = await createPost(body);
    return NextResponse.json(post, { status: 201 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
