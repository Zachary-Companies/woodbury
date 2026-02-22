import { NextResponse } from 'next/server';
import { getDuePosts } from '@/lib/storage';

export async function GET() {
  try {
    const posts = await getDuePosts();
    return NextResponse.json(posts);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
