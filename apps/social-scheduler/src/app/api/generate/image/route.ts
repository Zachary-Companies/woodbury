import { NextRequest, NextResponse } from 'next/server';
import { ensureMediaDir, getPost, updatePost } from '@/lib/storage';
import { randomUUID } from 'crypto';
import { writeFile } from 'fs/promises';
import { join } from 'path';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (!body.prompt || !body.postId) {
      return NextResponse.json(
        { error: 'prompt and postId are required' },
        { status: 400 }
      );
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({
        error: 'GEMINI_API_KEY environment variable is required for image generation',
        note: 'Set GEMINI_API_KEY in the Woodbury config dashboard to enable AI image generation'
      }, { status: 400 });
    }

    // Verify post exists
    const post = await getPost(body.postId);
    if (!post) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    // Call Gemini API for image generation
    const model = 'gemini-2.0-flash-exp';
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: `Generate an image: ${body.prompt}` }]
          }],
          generationConfig: {
            responseModalities: ['IMAGE', 'TEXT'],
          },
        }),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini API error: ${err}`);
    }

    const data = await res.json();

    // Find the image part in the response
    const imagePart = data.candidates?.[0]?.content?.parts?.find(
      (p: any) => p.inlineData?.mimeType?.startsWith('image/')
    );

    if (!imagePart?.inlineData) {
      throw new Error('No image generated — Gemini did not return image data');
    }

    // Save the image file
    const imageId = randomUUID();
    const mimeType = imagePart.inlineData.mimeType;
    const ext = mimeType.split('/')[1] || 'png';
    const filename = `${imageId}.${ext}`;

    const mediaDir = await ensureMediaDir(body.postId);
    const imagePath = join(mediaDir, filename);

    const buffer = Buffer.from(imagePart.inlineData.data, 'base64');
    await writeFile(imagePath, buffer);

    // Attach image to the post metadata
    const imageEntry = {
      id: imageId,
      filename,
      mimeType,
      prompt: body.prompt,
    };
    const updatedImages = [...(post.content.images || []), imageEntry];
    await updatePost(body.postId, {
      content: { ...post.content, images: updatedImages },
    });

    return NextResponse.json({
      id: imageId,
      filename,
      mimeType,
      path: imagePath,
      prompt: body.prompt,
      url: `/api/media/${body.postId}/${filename}`,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
