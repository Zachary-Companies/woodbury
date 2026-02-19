/**
 * Vector Store - In-memory vector store with cosine similarity
 */

/**
 * Stored chunk with metadata
 */
export interface StoredChunk {
  id: string;
  text: string;
  embedding: number[];
  metadata: ChunkMetadata;
}

export interface ChunkMetadata {
  source: string;
  section?: string;
  startLine?: number;
  endLine?: number;
  headers?: string[];
  [key: string]: unknown;
}

/**
 * Search result
 */
export interface SearchResult {
  chunk: StoredChunk;
  similarity: number;
}

/**
 * In-memory vector store
 */
export class VectorStore {
  private chunks: Map<string, StoredChunk> = new Map();
  private dimensions: number | null = null;

  /**
   * Add a chunk to the store
   */
  add(chunk: StoredChunk): void {
    if (this.dimensions === null) {
      this.dimensions = chunk.embedding.length;
    } else if (chunk.embedding.length !== this.dimensions) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.dimensions}, got ${chunk.embedding.length}`
      );
    }

    this.chunks.set(chunk.id, chunk);
  }

  /**
   * Add multiple chunks
   */
  addAll(chunks: StoredChunk[]): void {
    for (const chunk of chunks) {
      this.add(chunk);
    }
  }

  /**
   * Search for similar chunks
   */
  search(
    queryEmbedding: number[],
    options: { topK?: number; minSimilarity?: number } = {}
  ): SearchResult[] {
    const { topK = 5, minSimilarity = 0 } = options;

    if (this.chunks.size === 0) {
      return [];
    }

    const results: SearchResult[] = [];

    for (const chunk of this.chunks.values()) {
      const similarity = this.cosineSimilarity(queryEmbedding, chunk.embedding);

      if (similarity >= minSimilarity) {
        results.push({ chunk, similarity });
      }
    }

    // Sort by similarity descending
    results.sort((a, b) => b.similarity - a.similarity);

    // Return top K
    return results.slice(0, topK);
  }

  /**
   * Get a chunk by ID
   */
  get(id: string): StoredChunk | undefined {
    return this.chunks.get(id);
  }

  /**
   * Remove a chunk by ID
   */
  remove(id: string): boolean {
    return this.chunks.delete(id);
  }

  /**
   * Clear all chunks
   */
  clear(): void {
    this.chunks.clear();
    this.dimensions = null;
  }

  /**
   * Get the number of stored chunks
   */
  size(): number {
    return this.chunks.size;
  }

  /**
   * Get all chunks for a source
   */
  getBySource(source: string): StoredChunk[] {
    return Array.from(this.chunks.values()).filter(
      chunk => chunk.metadata.source === source
    );
  }

  /**
   * Remove all chunks for a source
   */
  removeBySource(source: string): number {
    const toRemove = this.getBySource(source).map(c => c.id);
    for (const id of toRemove) {
      this.chunks.delete(id);
    }
    return toRemove.length;
  }

  /**
   * Compute cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Vector dimensions must match');
    }

    let dotProduct = 0;
    let magnitudeA = 0;
    let magnitudeB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      magnitudeA += a[i] * a[i];
      magnitudeB += b[i] * b[i];
    }

    magnitudeA = Math.sqrt(magnitudeA);
    magnitudeB = Math.sqrt(magnitudeB);

    if (magnitudeA === 0 || magnitudeB === 0) {
      return 0;
    }

    return dotProduct / (magnitudeA * magnitudeB);
  }

  /**
   * Export store for persistence
   */
  export(): { chunks: StoredChunk[]; dimensions: number | null } {
    return {
      chunks: Array.from(this.chunks.values()),
      dimensions: this.dimensions,
    };
  }

  /**
   * Import from exported data
   */
  import(data: { chunks: StoredChunk[]; dimensions: number | null }): void {
    this.clear();
    this.dimensions = data.dimensions;
    for (const chunk of data.chunks) {
      this.chunks.set(chunk.id, chunk);
    }
  }
}

/**
 * Create a new vector store
 */
export function createVectorStore(): VectorStore {
  return new VectorStore();
}
