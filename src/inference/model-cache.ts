/**
 * Model Cache — LRU cache for ONNX model sessions.
 *
 * Port of Python's ServerState (woobury_models.serve).
 * Holds up to MAX_CACHED_MODELS ElementMatcher instances, evicting
 * the least recently used when the cache is full.
 */

import { existsSync } from 'fs';
import { ElementMatcher, dotProduct } from './element-matcher.js';

const MAX_CACHED_MODELS = 5;

export class ModelCache {
  /** LRU cache: Map preserves insertion order. Most-recently-used at end. */
  private models: Map<string, ElementMatcher> = new Map();
  private defaultModelPath: string | null;

  constructor(defaultModelPath?: string) {
    this.defaultModelPath = defaultModelPath ?? null;
  }

  /**
   * Initialize the cache. If a default model path was provided,
   * pre-load it so the first request doesn't have to wait.
   */
  async init(): Promise<void> {
    if (this.defaultModelPath) {
      await this.getMatcher(this.defaultModelPath);
    }
  }

  /**
   * Get (or lazily load) a matcher for the given model path.
   *
   * @param modelPath - Path to ONNX model file. If undefined, uses default.
   * @throws Error if no model path and no default model.
   * @throws Error if model file doesn't exist.
   */
  async getMatcher(modelPath?: string): Promise<ElementMatcher> {
    const path = modelPath || this.defaultModelPath;
    if (!path) {
      throw new Error('No model specified and no default model loaded');
    }

    // Check cache (and move to end for LRU)
    if (this.models.has(path)) {
      const matcher = this.models.get(path)!;
      // Move to end: delete + re-insert
      this.models.delete(path);
      this.models.set(path, matcher);
      return matcher;
    }

    // Validate path
    if (!existsSync(path)) {
      throw new Error(`Model not found: ${path}`);
    }

    // Load model
    console.log(`[inference] Loading model: ${path}`);
    const matcher = await ElementMatcher.create(path);

    // Run a tiny warmup embed to determine embed_dim
    // (The model is ready after create, but embed_dim is unknown until first call)

    this.models.set(path, matcher);

    // Evict LRU if over capacity
    while (this.models.size > MAX_CACHED_MODELS) {
      const firstKey = this.models.keys().next().value;
      if (firstKey) {
        this.models.delete(firstKey);
        console.log(`[inference] Evicted model from cache: ${firstKey}`);
      }
    }

    console.log(`[inference] Model loaded. Cache size: ${this.models.size}`);
    return matcher;
  }

  /**
   * Embed a single image using the specified (or default) model.
   */
  async embed(imageBuffer: Buffer, modelPath?: string): Promise<Float32Array> {
    const matcher = await this.getMatcher(modelPath);
    return matcher.embed(imageBuffer);
  }

  /**
   * Embed a batch of images sequentially.
   */
  async embedBatch(imageBuffers: Buffer[], modelPath?: string): Promise<Float32Array[]> {
    const matcher = await this.getMatcher(modelPath);
    return matcher.embedBatch(imageBuffers);
  }

  /**
   * Compare two images and return cosine similarity.
   */
  async compare(imgA: Buffer, imgB: Buffer, modelPath?: string): Promise<number> {
    const matcher = await this.getMatcher(modelPath);
    return matcher.compare(imgA, imgB);
  }

  /** Get the default model path. */
  getDefaultModelPath(): string | null {
    return this.defaultModelPath;
  }

  /** List currently loaded model paths. */
  getLoadedModels(): string[] {
    return [...this.models.keys()];
  }
}
