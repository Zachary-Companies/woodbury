/**
 * Inference HTTP Server — Node.js replacement for Python's woobury_models.serve
 *
 * Implements the exact same HTTP API as the Python server so that
 * visual-verifier.ts requires zero changes.
 *
 * Endpoints:
 *   GET  /health                  -> server status
 *   POST /embed                   -> single image embedding
 *   POST /compare                 -> compare two images
 *   POST /compare-region          -> crop region + compare to reference
 *   POST /search-region           -> find best match among candidates
 *   POST /search-region-weighted  -> position-weighted search
 *   POST /load-model              -> pre-load a model
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { ModelCache } from './model-cache.js';
import { dotProduct } from './element-matcher.js';
import { decodeBase64Image, cropRegion, type Bounds } from './image-utils.js';

// ── Types ────────────────────────────────────────────────────────

export interface InferenceServer {
  httpServer: Server;
  cache: ModelCache;
  port: number;
}

// ── HTTP Helpers ─────────────────────────────────────────────────

function sendJson(res: ServerResponse, data: unknown, status: number = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString();
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ── Endpoint Handlers ────────────────────────────────────────────

async function handleHealth(cache: ModelCache, res: ServerResponse): Promise<void> {
  sendJson(res, {
    status: 'ready',
    default_model: cache.getDefaultModelPath(),
    loaded_models: cache.getLoadedModels(),
  });
}

async function handleLoadModel(cache: ModelCache, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const data = await readJson(req);
  const modelPath = data.model;
  if (!modelPath) {
    sendJson(res, { error: "Missing 'model' field" }, 400);
    return;
  }

  const matcher = await cache.getMatcher(modelPath);
  const embedDim = matcher.getEmbedDim();
  sendJson(res, {
    loaded: true,
    model: modelPath,
    embed_dim: embedDim,
  });
}

async function handleEmbed(cache: ModelCache, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const data = await readJson(req);
  const imageBuffer = decodeBase64Image(data.image);
  const model = data.model || undefined;
  const embedding = await cache.embed(imageBuffer, model);
  sendJson(res, { embedding: Array.from(embedding) });
}

async function handleCompare(cache: ModelCache, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const data = await readJson(req);
  const imgA = decodeBase64Image(data.image_a);
  const imgB = decodeBase64Image(data.image_b);
  const model = data.model || undefined;
  const similarity = await cache.compare(imgA, imgB, model);
  sendJson(res, { similarity });
}

async function handleCompareRegion(cache: ModelCache, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const data = await readJson(req);
  const screenshotBuf = decodeBase64Image(data.screenshot);
  const bounds: Bounds = data.bounds;
  const referenceBuf = decodeBase64Image(data.reference);
  const model = data.model || undefined;

  // Crop the target region from the screenshot
  const cropBuf = await cropRegion(screenshotBuf, bounds);

  const similarity = await cache.compare(cropBuf, referenceBuf, model);
  sendJson(res, { similarity });
}

async function handleSearchRegion(cache: ModelCache, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const data = await readJson(req);
  const screenshotBuf = decodeBase64Image(data.screenshot);
  const candidates: Bounds[] = data.candidates;
  const referenceBuf = decodeBase64Image(data.reference);
  const model = data.model || undefined;

  if (!candidates || candidates.length === 0) {
    sendJson(res, { results: [], best_index: -1, best_similarity: 0.0 });
    return;
  }

  // Embed reference once
  const refEmb = await cache.embed(referenceBuf, model);

  // Crop and collect valid candidates
  const crops: Buffer[] = [];
  const validIndices: number[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const cropBuf = await cropRegion(screenshotBuf, candidates[i]);
    crops.push(cropBuf);
    validIndices.push(i);
  }

  if (crops.length === 0) {
    sendJson(res, { results: [], best_index: -1, best_similarity: 0.0 });
    return;
  }

  // Batch embed all crops
  const embeddings = await cache.embedBatch(crops, model);

  // Compute similarities
  const results: Array<{ index: number; similarity: number }> = [];
  for (let j = 0; j < validIndices.length; j++) {
    const sim = dotProduct(embeddings[j], refEmb);
    results.push({ index: validIndices[j], similarity: sim });
  }

  // Sort by similarity descending
  results.sort((a, b) => b.similarity - a.similarity);

  sendJson(res, {
    results,
    best_index: results[0].index,
    best_similarity: results[0].similarity,
  });
}

async function handleSearchRegionWeighted(cache: ModelCache, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const data = await readJson(req);
  const screenshotBuf = decodeBase64Image(data.screenshot);
  const candidates: Bounds[] = data.candidates;
  const referenceBuf = decodeBase64Image(data.reference);
  const model = data.model || undefined;
  const expectedPct: { x: number; y: number } | undefined = data.expected_pct;
  const viewport: { width: number; height: number } | undefined = data.viewport;
  const decay: number = parseFloat(data.position_decay ?? 15.0);

  if (!candidates || candidates.length === 0) {
    sendJson(res, { results: [], best_index: -1, best_similarity: 0.0, best_composite: 0.0 });
    return;
  }

  // Embed reference once
  const refEmb = await cache.embed(referenceBuf, model);

  // Crop and collect valid candidates
  const crops: Buffer[] = [];
  const validIndices: number[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const cropBuf = await cropRegion(screenshotBuf, candidates[i]);
    crops.push(cropBuf);
    validIndices.push(i);
  }

  if (crops.length === 0) {
    sendJson(res, { results: [], best_index: -1, best_similarity: 0.0, best_composite: 0.0 });
    return;
  }

  // Batch embed all crops
  const embeddings = await cache.embedBatch(crops, model);

  // Compute similarities with position weighting
  const results: Array<{
    index: number;
    similarity: number;
    position_weight: number;
    composite: number;
  }> = [];

  for (let j = 0; j < validIndices.length; j++) {
    const idx = validIndices[j];
    const visualSim = dotProduct(embeddings[j], refEmb);

    let posWeight = 1.0;
    let composite = visualSim;

    if (expectedPct && viewport && (viewport.width ?? 0) > 0) {
      const b = candidates[idx];
      const candPctX = ((b.left + b.width / 2) / viewport.width) * 100;
      const candPctY = ((b.top + b.height / 2) / viewport.height) * 100;
      const dist = Math.hypot(candPctX - expectedPct.x, candPctY - expectedPct.y);
      posWeight = Math.exp(-dist / decay);
      composite = visualSim * posWeight;
    }

    results.push({
      index: idx,
      similarity: visualSim,
      position_weight: Math.round(posWeight * 10000) / 10000, // round to 4 decimals
      composite,
    });
  }

  // Sort by composite score descending
  results.sort((a, b) => b.composite - a.composite);

  sendJson(res, {
    results,
    best_index: results[0].index,
    best_similarity: results[0].similarity,
    best_composite: results[0].composite,
  });
}

// ── Server ───────────────────────────────────────────────────────

/**
 * Start the Node.js inference server.
 *
 * Replaces `python -m woobury_models.serve --port <port>`.
 * Same HTTP API, same request/response shapes, same behavior.
 *
 * @param port - Port to listen on (default: 8679)
 * @param defaultModelPath - Optional ONNX model to pre-load
 * @returns InferenceServer handle for lifecycle management
 */
export async function startInferenceServer(
  port: number = 8679,
  defaultModelPath?: string,
): Promise<InferenceServer> {
  const cache = new ModelCache(defaultModelPath);

  // Pre-load default model if provided
  if (defaultModelPath) {
    try {
      await cache.init();
    } catch (err) {
      console.log(`[inference] Failed to pre-load default model: ${err}`);
      // Non-fatal — server starts anyway, models loaded on demand
    }
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method?.toUpperCase();
    const path = req.url;

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    try {
      if (method === 'GET' && path === '/health') {
        await handleHealth(cache, res);
      } else if (method === 'POST' && path === '/compare') {
        await handleCompare(cache, req, res);
      } else if (method === 'POST' && path === '/compare-region') {
        await handleCompareRegion(cache, req, res);
      } else if (method === 'POST' && path === '/search-region') {
        await handleSearchRegion(cache, req, res);
      } else if (method === 'POST' && path === '/search-region-weighted') {
        await handleSearchRegionWeighted(cache, req, res);
      } else if (method === 'POST' && path === '/embed') {
        await handleEmbed(cache, req, res);
      } else if (method === 'POST' && path === '/load-model') {
        await handleLoadModel(cache, req, res);
      } else {
        sendJson(res, { error: 'Not found' }, 404);
      }
    } catch (err: any) {
      const message = err?.message || String(err);
      if (message.includes('not found') || message.includes('Model not found')) {
        sendJson(res, { error: message }, 404);
      } else if (message.includes('No model specified')) {
        sendJson(res, { error: message }, 400);
      } else {
        console.error(`[inference] Error handling ${method} ${path}:`, message);
        sendJson(res, { error: message }, 500);
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      console.error(`[inference] Server error:`, err);
      reject(err);
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`[inference] Node.js inference server listening on 127.0.0.1:${port}`);
      resolve({
        httpServer: server,
        cache,
        port,
      });
    });
  });
}

/**
 * Stop the inference server.
 */
export function stopInferenceServer(server: InferenceServer): void {
  server.httpServer.close();
}
