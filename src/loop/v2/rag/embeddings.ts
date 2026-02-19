/**
 * Embeddings - Interface for embedding providers
 */

import OpenAI from 'openai';

/**
 * Embedding provider interface
 */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}

/**
 * OpenAI embedding provider
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI;
  private model: string;
  readonly dimensions: number;

  constructor(model: string = 'text-embedding-3-small') {
    this.client = new OpenAI();
    this.model = model;
    // text-embedding-3-small: 1536 dims, text-embedding-3-large: 3072 dims
    this.dimensions = model.includes('large') ? 3072 : 1536;
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
    });
    return response.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // OpenAI has a limit of ~8000 tokens per batch, so we batch carefully
    const batchSize = 100;
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const response = await this.client.embeddings.create({
        model: this.model,
        input: batch,
      });
      results.push(...response.data.map(d => d.embedding));
    }

    return results;
  }
}

/**
 * Local TF-IDF based embedding provider (fallback when no API key)
 * Uses simple term frequency with inverse document frequency
 */
export class LocalTFIDFProvider implements EmbeddingProvider {
  readonly dimensions = 512; // Fixed dimension for vocabulary
  private vocabulary: Map<string, number> = new Map();
  private idf: Map<string, number> = new Map();
  private documentCount = 0;

  /**
   * Build vocabulary from a corpus
   */
  buildVocabulary(documents: string[]): void {
    this.documentCount = documents.length;
    const documentFrequency = new Map<string, number>();

    // Tokenize and count document frequency
    for (const doc of documents) {
      const tokens = this.tokenize(doc);
      const uniqueTokens = new Set(tokens);

      for (const token of uniqueTokens) {
        documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
      }
    }

    // Select top terms by document frequency
    const sortedTerms = Array.from(documentFrequency.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, this.dimensions);

    // Build vocabulary and IDF
    sortedTerms.forEach(([term, df], index) => {
      this.vocabulary.set(term, index);
      this.idf.set(term, Math.log(this.documentCount / (df + 1)) + 1);
    });
  }

  async embed(text: string): Promise<number[]> {
    const tokens = this.tokenize(text);
    const vector = new Array(this.dimensions).fill(0);

    // Count term frequency
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    // Compute TF-IDF
    for (const [term, count] of tf) {
      const index = this.vocabulary.get(term);
      if (index !== undefined) {
        const termFreq = count / tokens.length;
        const idfValue = this.idf.get(term) || 1;
        vector[index] = termFreq * idfValue;
      }
    }

    // L2 normalize
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (magnitude > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] /= magnitude;
      }
    }

    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(text => this.embed(text)));
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(token => token.length > 2);
  }
}

/**
 * Simple hash-based embedding (very fast, works without vocabulary)
 * Uses feature hashing to create fixed-dimension vectors
 */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;

  constructor(dimensions: number = 256) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    const tokens = this.tokenize(text);
    const vector = new Array(this.dimensions).fill(0);

    for (const token of tokens) {
      // Hash token to get index
      const hash = this.hashString(token);
      const index = Math.abs(hash) % this.dimensions;
      // Use sign from another hash for +-1
      const sign = this.hashString(token + 'sign') > 0 ? 1 : -1;
      vector[index] += sign;
    }

    // L2 normalize
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (magnitude > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] /= magnitude;
      }
    }

    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(text => this.embed(text)));
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(token => token.length > 2);
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
  }
}

/**
 * Create embedding provider based on configuration
 */
export function createEmbeddingProvider(
  type: 'openai' | 'local' | 'hash' = 'hash',
  options?: { model?: string; dimensions?: number }
): EmbeddingProvider {
  switch (type) {
    case 'openai':
      return new OpenAIEmbeddingProvider(options?.model);
    case 'local':
      return new LocalTFIDFProvider();
    case 'hash':
    default:
      return new HashEmbeddingProvider(options?.dimensions);
  }
}
