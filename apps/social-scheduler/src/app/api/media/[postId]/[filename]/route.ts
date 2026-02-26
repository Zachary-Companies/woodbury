import { NextRequest, NextResponse } from 'next/server';
import { getMediaPath } from '@/lib/storage';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export async function GET(
  request: NextRequest,
  { params }: { params: { postId: string; filename: string } }
) {
  const filePath = getMediaPath(params.postId, params.filename);

  if (!existsSync(filePath)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const ext = '.' + params.filename.split('.').pop()?.toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  const buffer = await readFile(filePath);
  return new NextResponse(buffer, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
