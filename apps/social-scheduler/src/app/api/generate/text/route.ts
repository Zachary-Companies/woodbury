import { NextRequest, NextResponse } from 'next/server';
import { getConfig } from '@/lib/storage';
import type { GenerateTextRequest } from '@/types';

export async function POST(request: NextRequest) {
  try {
    const body: GenerateTextRequest = await request.json();

    if (!body.prompt) {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    const config = await getConfig();

    // Build platform context
    const platformLimits: Record<string, number> = {
      instagram: 2200,
      twitter: 280,
      facebook: 63206,
      linkedin: 3000,
      tiktok: 2200,
    };

    const platformContext = (body.platforms || []).map(p =>
      `${p}: max ${platformLimits[p] || 5000} characters`
    ).join(', ');

    const systemPrompt = `You are a social media content creator. Generate engaging post content based on the user's description.

Rules:
- Tone: ${body.tone || 'casual'}
- Length: ${body.length || 'medium'} (short=1-2 sentences, medium=3-5 sentences, long=paragraph)
${platformContext ? `- Platform constraints: ${platformContext}` : ''}
${body.includeHashtags !== false ? '- Include 3-5 relevant hashtags at the end' : '- Do NOT include hashtags'}
- Return ONLY the post text, no explanations or meta-commentary
- Make it engaging, authentic, and ready to post`;

    // Try to call the configured LLM provider
    const provider = config.llm.textProvider;
    const model = config.llm.textModel;

    let generatedText = '';

    if (provider === 'anthropic') {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return NextResponse.json({
          text: `[LLM generation requires ANTHROPIC_API_KEY environment variable]\n\nPrompt: ${body.prompt}\nTone: ${body.tone || 'casual'}\nPlatforms: ${body.platforms?.join(', ') || 'general'}`,
          note: 'Set ANTHROPIC_API_KEY environment variable to enable AI generation'
        });
      }

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: 'user', content: body.prompt }],
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Anthropic API error: ${err}`);
      }

      const data = await res.json();
      generatedText = data.content?.[0]?.text || '';

    } else if (provider === 'openai') {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return NextResponse.json({
          text: `[LLM generation requires OPENAI_API_KEY]\n\nPrompt: ${body.prompt}`,
          note: 'Set OPENAI_API_KEY environment variable'
        });
      }

      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: body.prompt },
          ],
          max_tokens: 1024,
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`OpenAI API error: ${err}`);
      }

      const data = await res.json();
      generatedText = data.choices?.[0]?.message?.content || '';

    } else {
      return NextResponse.json({
        text: `[Unsupported provider: ${provider}]\n\nPrompt: ${body.prompt}`,
        note: `Configure a supported LLM provider (anthropic, openai) in settings`
      });
    }

    return NextResponse.json({ text: generatedText });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
