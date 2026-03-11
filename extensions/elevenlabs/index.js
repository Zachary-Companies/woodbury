/**
 * Woodbury ElevenLabs Extension
 *
 * Provides text-to-speech tools using the ElevenLabs API.
 * Generates audio files from text — ideal for voiceovers, narration, and dialogue.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const API_BASE = 'https://api.elevenlabs.io';

const MODELS = {
  v3: 'eleven_v3',
  multilingual_v2: 'eleven_multilingual_v2',
  flash_v2_5: 'eleven_flash_v2_5',
  flash_v2: 'eleven_flash_v2',
  turbo_v2_5: 'eleven_turbo_v2_5',
};

const OUTPUT_FORMATS = [
  'mp3_22050_32',
  'mp3_44100_64',
  'mp3_44100_96',
  'mp3_44100_128',
  'mp3_44100_192',
  'pcm_8000',
  'pcm_16000',
  'pcm_22050',
  'pcm_24000',
  'pcm_44100',
  'pcm_48000',
  'wav_8000',
  'wav_16000',
  'wav_22050',
  'wav_24000',
  'wav_44100',
  'wav_48000',
  'opus_48000_64',
  'opus_48000_128',
  'ulaw_8000',
  'alaw_8000',
];

// ── API helpers ──────────────────────────────────────────────

async function apiCall(endpoint, apiKey, options = {}) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'xi-api-key': apiKey,
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ElevenLabs API error (${res.status}): ${text}`);
  }
  return res;
}

/**
 * List available voices (v2 endpoint with pagination).
 */
async function listVoices(apiKey, { search, category, pageSize } = {}) {
  const params = new URLSearchParams();
  params.set('page_size', String(pageSize || 100));
  if (search) params.set('search', search);
  if (category) params.set('category', category);
  params.set('include_total_count', 'true');

  const res = await apiCall(`/v2/voices?${params}`, apiKey);
  return res.json();
}

/**
 * List available models.
 */
async function listModels(apiKey) {
  const res = await apiCall('/v1/models', apiKey);
  return res.json();
}

/**
 * Generate speech from text. Returns raw audio Buffer.
 */
async function generateSpeech(params, apiKey) {
  const {
    text,
    voice_id,
    model_id = 'eleven_multilingual_v2',
    output_format = 'mp3_44100_128',
    stability,
    similarity_boost,
    style,
    speed,
    language_code,
  } = params;

  const url = `/v1/text-to-speech/${voice_id}?output_format=${output_format}`;

  const body = { text, model_id };
  if (language_code) body.language_code = language_code;

  // Build voice_settings only if any setting is provided
  const hasSettings = stability !== undefined
    || similarity_boost !== undefined
    || style !== undefined
    || speed !== undefined;

  if (hasSettings) {
    body.voice_settings = {};
    if (stability !== undefined) body.voice_settings.stability = stability;
    if (similarity_boost !== undefined) body.voice_settings.similarity_boost = similarity_boost;
    if (style !== undefined) body.voice_settings.style = style;
    if (speed !== undefined) body.voice_settings.speed = speed;
  }

  const res = await apiCall(url, apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ── File extension helper ────────────────────────────────────

function formatToExt(format) {
  if (!format) return '.mp3';
  if (format.startsWith('mp3')) return '.mp3';
  if (format.startsWith('pcm')) return '.pcm';
  if (format.startsWith('wav')) return '.wav';
  if (format.startsWith('opus')) return '.opus';
  if (format.startsWith('ulaw') || format.startsWith('alaw')) return '.raw';
  return '.mp3';
}

// ── Extension entry point ────────────────────────────────────

/**
 * @param {import('woodbury').ExtensionContext} ctx
 */
export async function activate(ctx) {
  ctx.log.info('ElevenLabs extension activated');

  const apiKey = ctx.env.ELEVENLABS_API_KEY || '';
  const audioOutputDir = ctx.env.AUDIO_OUTPUT_DIR || '';
  const defaultVoice = ctx.env.ELEVENLABS_DEFAULT_VOICE || '';
  const defaultModel = ctx.env.ELEVENLABS_DEFAULT_MODEL || 'eleven_multilingual_v2';

  // ─── Tool: tts_speak — generate speech audio ───────────────

  ctx.registerTool(
    {
      name: 'tts_speak',
      description: `Generate speech audio from text using ElevenLabs. Returns a saved audio file path.

Use this to create voiceovers, narration, or dialogue audio files.

**Required:** text, voice_id (use tts_voices to find available voices)
**Returns:** path to the saved audio file`,
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The text to convert to speech',
          },
          voice_id: {
            type: 'string',
            description: 'ElevenLabs voice ID. Use tts_voices to list available voices. Can be omitted if ELEVENLABS_DEFAULT_VOICE is configured.',
          },
          output_path: {
            type: 'string',
            description: 'Where to save the audio file. Defaults to AUDIO_OUTPUT_DIR with auto-generated filename.',
          },
          model: {
            type: 'string',
            enum: ['v3', 'multilingual_v2', 'flash_v2_5', 'flash_v2', 'turbo_v2_5'],
            description: 'Model to use. v3 (newest, most expressive), multilingual_v2 (quality, default), flash_v2_5 (fastest multilingual), flash_v2 (fastest English-only), turbo_v2_5 (balanced).',
          },
          output_format: {
            type: 'string',
            enum: OUTPUT_FORMATS,
            description: 'Audio format. Default: mp3_44100_128. Options include mp3, wav, pcm, opus, ulaw, alaw.',
          },
          stability: {
            type: 'number',
            description: 'Voice stability (0.0-1.0). Lower = more expressive/variable. Higher = more consistent.',
          },
          similarity_boost: {
            type: 'number',
            description: 'Similarity boost (0.0-1.0). Higher = closer to original voice.',
          },
          style: {
            type: 'number',
            description: 'Style exaggeration (0.0-1.0). Higher = more stylistic. Can reduce stability.',
          },
          speed: {
            type: 'number',
            description: 'Speech speed multiplier. 1.0 = normal, <1.0 slower, >1.0 faster.',
          },
          language_code: {
            type: 'string',
            description: 'ISO 639-1 language code (e.g. "en", "es", "fr", "de", "ja"). Only needed for multilingual models when auto-detection is insufficient.',
          },
        },
        required: ['text'],
      },
    },
    async (params) => {
      const key = apiKey || process.env.ELEVENLABS_API_KEY;
      if (!key) {
        return JSON.stringify({
          success: false,
          error: 'ELEVENLABS_API_KEY not configured. Set it in the extension .env file. Get a key at https://elevenlabs.io',
        });
      }

      const voiceId = params.voice_id || defaultVoice;
      if (!voiceId) {
        return JSON.stringify({
          success: false,
          error: 'No voice_id provided and no ELEVENLABS_DEFAULT_VOICE configured. Use tts_voices to list available voices and pick one.',
        });
      }

      // Resolve model
      const modelId = params.model
        ? (MODELS[params.model] || params.model)
        : defaultModel;

      // Determine output format and file extension
      const outputFormat = params.output_format || 'mp3_44100_128';
      const ext = formatToExt(outputFormat);

      // Determine output path
      let outputPath = params.output_path;
      if (!outputPath) {
        const dir = audioOutputDir
          ? (path.isAbsolute(audioOutputDir) ? audioOutputDir : path.resolve(ctx.workingDirectory, audioOutputDir))
          : ctx.workingDirectory;
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        outputPath = path.join(dir, `tts_${Date.now()}${ext}`);
      }

      if (!path.isAbsolute(outputPath)) {
        outputPath = path.resolve(ctx.workingDirectory, outputPath);
      }

      // Ensure output directory exists
      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      try {
        const audioBuffer = await generateSpeech(
          {
            text: params.text,
            voice_id: voiceId,
            model_id: modelId,
            output_format: outputFormat,
            stability: params.stability,
            similarity_boost: params.similarity_boost,
            style: params.style,
            speed: params.speed,
            language_code: params.language_code,
          },
          key
        );

        fs.writeFileSync(outputPath, audioBuffer);

        const fileSizeKB = Math.round(audioBuffer.length / 1024);

        return JSON.stringify({
          success: true,
          audio_path: outputPath,
          voice_id: voiceId,
          model: modelId,
          format: outputFormat,
          size_kb: fileSizeKB,
          text_length: params.text.length,
        });
      } catch (err) {
        return JSON.stringify({
          success: false,
          error: err.message,
        });
      }
    }
  );

  // ─── Tool: tts_voices — list available voices ──────────────

  ctx.registerTool(
    {
      name: 'tts_voices',
      description: `List available ElevenLabs voices. Returns voice IDs, names, categories, and labels. Use this to find the right voice_id for tts_speak.`,
      parameters: {
        type: 'object',
        properties: {
          search: {
            type: 'string',
            description: 'Search term to filter voices by name, description, or labels.',
          },
          category: {
            type: 'string',
            enum: ['premade', 'cloned', 'generated', 'professional'],
            description: 'Filter by voice category.',
          },
        },
      },
    },
    async (params) => {
      const key = apiKey || process.env.ELEVENLABS_API_KEY;
      if (!key) {
        return JSON.stringify({
          success: false,
          error: 'ELEVENLABS_API_KEY not configured.',
        });
      }

      try {
        const data = await listVoices(key, {
          search: params.search,
          category: params.category,
          pageSize: 100,
        });

        const voices = (data.voices || []).map((v) => ({
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
          default_voice: defaultVoice || null,
          voices,
        });
      } catch (err) {
        return JSON.stringify({
          success: false,
          error: err.message,
        });
      }
    }
  );

  // ─── Tool: tts_models — list available models ──────────────

  ctx.registerTool(
    {
      name: 'tts_models',
      description: `List available ElevenLabs TTS models with capabilities and language support.`,
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    async () => {
      const key = apiKey || process.env.ELEVENLABS_API_KEY;
      if (!key) {
        return JSON.stringify({
          success: false,
          error: 'ELEVENLABS_API_KEY not configured.',
        });
      }

      try {
        const models = await listModels(key);

        const ttsModels = (Array.isArray(models) ? models : []).filter(
          (m) => m.can_do_text_to_speech
        ).map((m) => ({
          model_id: m.model_id,
          name: m.name,
          description: m.description || null,
          can_use_style: m.can_use_style || false,
          can_use_speaker_boost: m.can_use_speaker_boost || false,
          max_chars: m.maximum_text_length_per_request || null,
          languages: (m.languages || []).length,
          language_list: (m.languages || []).map((l) => l.name).slice(0, 10),
        }));

        return JSON.stringify({
          success: true,
          count: ttsModels.length,
          current_default: defaultModel,
          models: ttsModels,
        });
      } catch (err) {
        return JSON.stringify({
          success: false,
          error: err.message,
        });
      }
    }
  );

  // ─── Command: /elevenlabs-status ───────────────────────────

  ctx.registerCommand({
    name: 'elevenlabs-status',
    description: 'Check ElevenLabs API key and configuration status',
    handler: async (args, cmdCtx) => {
      const key = apiKey || process.env.ELEVENLABS_API_KEY;
      if (key) {
        cmdCtx.print(`API Key: configured (${key.slice(0, 8)}...)`);
      } else {
        cmdCtx.print('API Key: NOT CONFIGURED');
        cmdCtx.print('  Set ELEVENLABS_API_KEY in the extension .env file');
      }

      if (defaultVoice) {
        cmdCtx.print(`Default voice: ${defaultVoice}`);
      } else {
        cmdCtx.print('Default voice: not set (must provide voice_id each time)');
      }

      cmdCtx.print(`Default model: ${defaultModel}`);

      if (audioOutputDir) {
        const resolved = path.isAbsolute(audioOutputDir)
          ? audioOutputDir
          : path.resolve(cmdCtx.workingDirectory, audioOutputDir);
        cmdCtx.print(`Audio output: ${resolved}`);
      } else {
        cmdCtx.print('Audio output: working directory (no AUDIO_OUTPUT_DIR set)');
      }
    },
  });

  // ─── System prompt ─────────────────────────────────────────

  const outputNote = audioOutputDir
    ? `Audio files are saved to: ${audioOutputDir}`
    : 'Audio files are saved to the working directory by default. Configure AUDIO_OUTPUT_DIR in the .env file.';

  ctx.addSystemPrompt(`## ElevenLabs Extension (Text-to-Speech)

You have access to ElevenLabs text-to-speech for generating voiceover and narration audio.

### Tools

**tts_speak** — Convert text to speech audio. Returns the saved file path.
- Required: text (the script/narration) and voice_id (from tts_voices)
- Models: v3 (newest, most expressive), multilingual_v2 (quality, default), flash_v2_5 (fastest multilingual), flash_v2 (fastest English-only)
- Output: audio file ready to use as an asset
- Voice settings: stability, similarity_boost, style, speed
- Formats: mp3, wav, pcm, opus, ulaw, alaw

**tts_voices** — List available voices with IDs, names, and categories.
- Use the search param to filter by name or label
- Use the category param to filter by premade, cloned, generated, or professional
- Returns voice_id needed for tts_speak

**tts_models** — List available TTS models with capabilities and language support.

### Command: /elevenlabs-status
Check API key and configuration.

### ${outputNote}`);
}

export function deactivate() {
  // Cleanup
}
