import { NextRequest, NextResponse } from 'next/server';
import { getConnector, saveConnector } from '@/lib/storage';

export async function GET(
  request: NextRequest,
  { params }: { params: { platform: string } }
) {
  try {
    const connector = await getConnector(params.platform);
    if (!connector) {
      return NextResponse.json({ error: 'Connector not found' }, { status: 404 });
    }
    return NextResponse.json(connector);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { platform: string } }
) {
  try {
    const body = await request.json();
    const manifest = { ...body, platform: params.platform };
    await saveConnector(manifest);
    return NextResponse.json(manifest);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
