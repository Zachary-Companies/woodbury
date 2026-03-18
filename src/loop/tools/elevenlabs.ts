/**
 * ElevenLabs Text-to-Speech - Built-in Tool
 *
 * Generate speech audio, list voices, and list models using the ElevenLabs API.
 * Requires ELEVENLABS_API_KEY environment variable or extension config.
 */

import { z } from 'zod';
import { ToolDefinition } from './index.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const API_BASE = 'https://api.elevenlabs.io';

const MODELS: Record<string, string> = {
  v3: 'eleven_v3',
  multilingual_v2: 'eleven_multilingual_v2',
  flash_v2_5: 'eleven_flash_v2_5',
  flash_v2: 'eleven_flash_v2',
  turbo_v2_5: 'eleven_turbo_v2_5',
};

const OUTPUT_FORMATS = [
  'mp3_22050_32', 'mp3_44100_64', 'mp3_44100_96', 'mp3_44100_128', 'mp3_44100_192',
  'pcm_8000', 'pcm_16000', 'pcm_22050', 'pcm_24000', 'pcm_44100', 'pcm_48000',
  'wav_8000', 'wav_16000', 'wav_22050', 'wav_24000', 'wav_44100', 'wav_48000',
  'opus_48000_64', 'opus_48000_128',
  'ulaw_8000', 'alaw_8000',
] as const;

// ── Helpers ──────────────────────────────────────────────────

function getApiKey(): string | undefined {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;

  // Check extension .env files
  const envPaths = [
    path.join(os.homedir(), '.woodbury', 'extensions', 'elevenlabs', '.env'),
  ];
  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      try {
        const content = fs.readFileSync(envPath, 'utf-8');
        const match = content.match(/^ELEVENLABS_API_KEY=(.+)$/m);
        if (match?.[1]) return match[1].trim().replace(/^["']|["']$/g, '');
      } catch { /* continue */ }
    }
  }
  return undefined;
}

function getEnvSetting(key: string): string | undefined {
  if (process.env[key]) return process.env[key];

  const envPath = path.join(os.homedir(), '.woodbury', 'extensions', 'elevenlabs', '.env');
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf-8');
      const match = content.match(new RegExp(`^${key}=(.+)$`, 'm'));
      if (match?.[1]) return match[1].trim().replace(/^["']|["']$/g, '');
    } catch { /* ignore */ }
  }
  return undefined;
}

async function apiCall(endpoint: string, apiKey: string, options: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'xi-api-key': apiKey,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ElevenLabs API error (${res.status}): ${text}`);
  }
  return res;
}

function formatToExt(format: string): string {
  if (!format) return '.mp3';
  if (format.startsWith('mp3')) return '.mp3';
  if (format.startsWith('pcm')) return '.pcm';
  if (format.startsWith('wav')) return '.wav';
  if (format.startsWith('opus')) return '.opus';
  if (format.startsWith('ulaw') || format.startsWith('alaw')) return '.raw';
  return '.mp3';
}

// ── Schemas ──────────────────────────────────────────────────

export const ttsSpeakSchema = z.object({
  text: z.string().describe('The text to convert to speech'),
  voice_id: z.string().optional().describe(
    'ElevenLabs voice ID. Use tts_voices to list available voices. Can be omitted if ELEVENLABS_DEFAULT_VOICE is configured.'
  ),
  output_path: z.string().optional().describe(
    'Where to save the audio file. Defaults to AUDIO_OUTPUT_DIR with auto-generated filename.'
  ),
  model: z.enum(['v3', 'multilingual_v2', 'flash_v2_5', 'flash_v2', 'turbo_v2_5']).optional().describe(
    'Model to use. v3 (newest, most expressive), multilingual_v2 (quality, default), flash_v2_5 (fastest multilingual), flash_v2 (fastest English-only), turbo_v2_5 (balanced).'
  ),
  output_format: z.enum(OUTPUT_FORMATS).optional().describe(
    'Audio format. Default: mp3_44100_128. Options include mp3, wav, pcm, opus, ulaw, alaw.'
  ),
  stability: z.number().min(0).max(1).optional().describe(
    'Voice stability (0.0-1.0). Lower = more expressive/variable. Higher = more consistent.'
  ),
  similarity_boost: z.number().min(0).max(1).optional().describe(
    'Similarity boost (0.0-1.0). Higher = closer to original voice.'
  ),
  style: z.number().min(0).max(1).optional().describe(
    'Style exaggeration (0.0-1.0). Higher = more stylistic. Can reduce stability.'
  ),
  speed: z.number().optional().describe(
    'Speech speed multiplier. 1.0 = normal, <1.0 slower, >1.0 faster.'
  ),
  language_code: z.string().optional().describe(
    'ISO 639-1 language code (e.g. "en", "es", "fr", "de", "ja"). Only needed for multilingual models.'
  ),
});

export const ttsVoicesSchema = z.object({
  search: z.string().optional().describe('Search term to filter voices by name, description, or labels.'),
  category: z.enum(['premade', 'cloned', 'generated', 'professional']).optional().describe('Filter by voice category.'),
});

export const ttsModelsSchema = z.object({});

// ── Tool implementations ─────────────────────────────────────

export async function ttsSpeakHandler(
  params: z.infer<typeof ttsSpeakSchema>,
  workingDirectory: string
): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return JSON.stringify({
      success: false,
      error: 'ELEVENLABS_API_KEY not configured. Set it in the API Keys menu (Model → API Keys) or in ~/.woodbury/.env. Get a key at https://elevenlabs.io',
    });
  }

  const defaultVoice = getEnvSetting('ELEVENLABS_DEFAULT_VOICE') || '';
  const defaultModel = getEnvSetting('ELEVENLABS_DEFAULT_MODEL') || 'eleven_multilingual_v2';
  const audioOutputDir = getEnvSetting('AUDIO_OUTPUT_DIR') || '';

  const voiceId = params.voice_id || defaultVoice;
  if (!voiceId) {
    return JSON.stringify({
      success: false,
      error: 'No voice_id provided and no ELEVENLABS_DEFAULT_VOICE configured. Use tts_voices to list available voices and pick one.',
    });
  }

  const modelId = params.model ? (MODELS[params.model] || params.model) : defaultModel;
  const outputFormat = params.output_format || 'mp3_44100_128';
  const ext = formatToExt(outputFormat);

  // Determine output path
  let outputPath = params.output_path;
  if (!outputPath) {
    const dir = audioOutputDir
      ? (path.isAbsolute(audioOutputDir) ? audioOutputDir : path.resolve(workingDirectory, audioOutputDir))
      : workingDirectory;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    outputPath = path.join(dir, `tts_${Date.now()}${ext}`);
  }
  if (!path.isAbsolute(outputPath)) outputPath = path.resolve(workingDirectory, outputPath);

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  try {
    // Build request body
    const body: Record<string, unknown> = { text: params.text, model_id: modelId };
    if (params.language_code) body.language_code = params.language_code;

    const hasSettings = params.stability !== undefined || params.similarity_boost !== undefined
      || params.style !== undefined || params.speed !== undefined;
    if (hasSettings) {
      const vs: Record<string, number> = {};
      if (params.stability !== undefined) vs.stability = params.stability;
      if (params.similarity_boost !== undefined) vs.similarity_boost = params.similarity_boost;
      if (params.style !== undefined) vs.style = params.style;
      if (params.speed !== undefined) vs.speed = params.speed;
      body.voice_settings = vs;
    }

    const url = `/v1/text-to-speech/${voiceId}?output_format=${outputFormat}`;
    const res = await apiCall(url, apiKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const arrayBuffer = await res.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(outputPath, audioBuffer);

    return JSON.stringify({
      success: true,
      audio_path: outputPath,
      voice_id: voiceId,
      model: modelId,
      format: outputFormat,
      size_kb: Math.round(audioBuffer.length / 1024),
      text_length: params.text.length,
    });
  } catch (err) {
    return JSON.stringify({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function ttsVoicesHandler(params: z.infer<typeof ttsVoicesSchema>): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return JSON.stringify({ success: false, error: 'ELEVENLABS_API_KEY not configured.' });
  }

  try {
    const queryParams = new URLSearchParams();
    queryParams.set('page_size', '100');
    queryParams.set('include_total_count', 'true');
    if (params.search) queryParams.set('search', params.search);
    if (params.category) queryParams.set('category', params.category);

    const res = await apiCall(`/v2/voices?${queryParams}`, apiKey);
    const data = await res.json() as { voices?: Array<Record<string, unknown>>; total_count?: number };

    const voices = (data.voices || []).map((v: Record<string, unknown>) => ({
      voice_id: v.voice_id,
      name: v.name,
      category: v.category || null,
      description: v.description || null,
      labels: v.labels || {},
      preview_url: v.preview_url || null,
    }));

    return JSON.stringify({
      success: true,
      count: voices.length,
      total: data.total_count || voices.length,
      voices,
    });
  } catch (err) {
    return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function ttsModelsHandler(): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return JSON.stringify({ success: false, error: 'ELEVENLABS_API_KEY not configured.' });
  }

  try {
    const res = await apiCall('/v1/models', apiKey);
    const models = await res.json() as Array<Record<string, unknown>>;

    const ttsModels = (Array.isArray(models) ? models : [])
      .filter((m) => m.can_do_text_to_speech)
      .map((m) => ({
        model_id: m.model_id,
        name: m.name,
        description: m.description || null,
        can_use_style: m.can_use_style || false,
        can_use_speaker_boost: m.can_use_speaker_boost || false,
        max_chars: m.maximum_text_length_per_request || null,
        languages: ((m.languages as Array<Record<string, string>>) || []).length,
        language_list: ((m.languages as Array<Record<string, string>>) || []).map((l) => l.name).slice(0, 10),
      }));

    return JSON.stringify({
      success: true,
      count: ttsModels.length,
      models: ttsModels,
    });
  } catch (err) {
    return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Tool definitions ─────────────────────────────────────────

export const ttsSpeakTool: ToolDefinition = {
  name: 'tts_speak',
  description: `Generate speech audio from text using ElevenLabs. Returns a saved audio file path.

Use this to create voiceovers, narration, or dialogue audio files.

**Models:**
- "v3": Newest, most expressive
- "multilingual_v2": High quality, many languages (default)
- "flash_v2_5": Fastest multilingual
- "flash_v2": Fastest English-only
- "turbo_v2_5": Balanced speed/quality

**Required:** text, voice_id (use tts_voices to find available voices)
**Formats:** mp3, wav, pcm, opus, ulaw, alaw (19 variants)
**Voice tuning:** stability, similarity_boost, style, speed

Requires ELEVENLABS_API_KEY environment variable.`,
  parameters: ttsSpeakSchema,
  execute: async (params, context) => {
    return ttsSpeakHandler(params as z.infer<typeof ttsSpeakSchema>, context?.workingDirectory || process.cwd());
  },
  dangerous: false,
};

export const ttsVoicesTool: ToolDefinition = {
  name: 'tts_voices',
  description: `List available ElevenLabs voices. Returns voice IDs, names, categories, and labels.
Use this to find the right voice_id for tts_speak.

Optionally filter by search term or category (premade, cloned, generated, professional).

Requires ELEVENLABS_API_KEY environment variable.`,
  parameters: ttsVoicesSchema,
  execute: async (params) => {
    return ttsVoicesHandler(params as z.infer<typeof ttsVoicesSchema>);
  },
  dangerous: false,
};

export const ttsModelsTool: ToolDefinition = {
  name: 'tts_models',
  description: `List available ElevenLabs TTS models with capabilities and language support.

Requires ELEVENLABS_API_KEY environment variable.`,
  parameters: ttsModelsSchema,
  execute: async () => {
    return ttsModelsHandler();
  },
  dangerous: false,
};
