/**
 * Element Matcher — ONNX Runtime inference for UI element matching.
 *
 * Port of Python's ElementMatcher (woobury_models.inference).
 * Loads an ONNX-exported Siamese encoder, preprocesses images via
 * letterbox + ImageNet normalization, and computes cosine similarity
 * between L2-normalized embeddings.
 */

import * as ort from 'onnxruntime-node';
import { preprocessImage } from './image-utils.js';
import { MAX_SIDE } from './image-utils.js';

export class ElementMatcher {
  private session: ort.InferenceSession;
  private inputName: string;
  private embedDim: number;
  private cache: Map<string, Float32Array> = new Map();

  private constructor(session: ort.InferenceSession) {
    this.session = session;
    this.inputName = session.inputNames[0];
    // Output shape is [1, embed_dim]
    // We'll determine it from the first inference if needed
    const outputMeta = session.outputNames[0];
    this.embedDim = 0; // Will be set after first embed call
  }

  /**
   * Create an ElementMatcher from an ONNX model file.
   *
   * Uses CPU execution provider with full graph optimization.
   */
  static async create(modelPath: string): Promise<ElementMatcher> {
    const opts: ort.InferenceSession.SessionOptions = {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    };

    const session = await ort.InferenceSession.create(modelPath, opts);
    return new ElementMatcher(session);
  }

  /**
   * Embed a single image.
   *
   * @param imageBuffer - Raw image bytes (PNG, JPEG, etc.)
   * @returns L2-normalized embedding as Float32Array (d,)
   */
  async embed(imageBuffer: Buffer): Promise<Float32Array> {
    const floats = await preprocessImage(imageBuffer);
    const tensor = new ort.Tensor('float32', floats, [1, 3, MAX_SIDE, MAX_SIDE]);

    const feeds: Record<string, ort.Tensor> = {};
    feeds[this.inputName] = tensor;

    const results = await this.session.run(feeds);
    const outputName = this.session.outputNames[0];
    const output = results[outputName];
    const data = output.data as Float32Array;

    // Output is (1, d) — extract the embedding vector
    if (this.embedDim === 0) {
      this.embedDim = data.length;
    }

    return new Float32Array(data);
  }

  /**
   * Embed a batch of images sequentially.
   *
   * The ONNX model has static batch_size=1, so we embed each
   * image individually (same as Python's ServerState.embed_batch).
   *
   * @param imageBuffers - Array of raw image bytes
   * @returns Array of L2-normalized embeddings
   */
  async embedBatch(imageBuffers: Buffer[]): Promise<Float32Array[]> {
    const embeddings: Float32Array[] = [];
    for (const buf of imageBuffers) {
      embeddings.push(await this.embed(buf));
    }
    return embeddings;
  }

  /**
   * Compute cosine similarity between two images.
   *
   * Since embeddings are L2-normalized, cosine similarity = dot product.
   *
   * @returns Similarity score in [-1, 1]
   */
  async compare(imgA: Buffer, imgB: Buffer): Promise<number> {
    const embA = await this.embed(imgA);
    const embB = await this.embed(imgB);
    return dotProduct(embA, embB);
  }

  /**
   * Precompute and cache a reference embedding.
   */
  async cacheReference(key: string, imageBuffer: Buffer): Promise<void> {
    const emb = await this.embed(imageBuffer);
    this.cache.set(key, emb);
  }

  /**
   * Compare a query image against a cached reference.
   *
   * @returns Similarity score, or null if key not cached.
   */
  async compareToCached(queryBuffer: Buffer, key: string): Promise<number | null> {
    const cached = this.cache.get(key);
    if (!cached) return null;

    const queryEmb = await this.embed(queryBuffer);
    return dotProduct(queryEmb, cached);
  }

  /** Clear all cached reference embeddings. */
  clearCache(): void {
    this.cache.clear();
  }

  /** Get the embedding dimensionality (available after first embed call). */
  getEmbedDim(): number {
    return this.embedDim;
  }
}

// ── Math Helpers ─────────────────────────────────────────────────

/**
 * Dot product of two Float32Arrays (cosine similarity for L2-normalized vectors).
 */
export function dotProduct(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}
