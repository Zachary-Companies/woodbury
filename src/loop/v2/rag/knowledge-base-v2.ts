/**
 * RAG Knowledge Base V2 - Smart retrieval with embeddings
 */

import { EmbeddingProvider, createEmbeddingProvider } from './embeddings';
import { VectorStore, createVectorStore, StoredChunk, SearchResult } from './vector-store';
import { TextChunker, createChunker, ChunkingOptions } from './chunker';
import { KnowledgeEntry } from '../../knowledge-base';

/**
 * RAG Knowledge Base configuration
 */
export interface RAGKnowledgeBaseConfig {
  /** Embedding provider type */
  embeddingProvider?: 'openai' | 'local' | 'hash';
  /** OpenAI embedding model (if using OpenAI) */
  embeddingModel?: string;
  /** Chunking options */
  chunking?: ChunkingOptions;
  /** Default top-K for retrieval */
  defaultTopK?: number;
  /** Default minimum similarity threshold */
  defaultMinSimilarity?: number;
}

/**
 * Retrieved context for agent
 */
export interface RetrievedContext {
  chunks: RetrievedChunk[];
  totalTokensEstimate: number;
}

export interface RetrievedChunk {
  text: string;
  source: string;
  section?: string;
  similarity: number;
}

/**
 * RAG-enabled Knowledge Base
 */
export class RAGKnowledgeBase {
  private embedder: EmbeddingProvider;
  private vectorStore: VectorStore;
  private chunker: TextChunker;
  private config: Required<RAGKnowledgeBaseConfig>;
  private entries: Map<string, KnowledgeEntry> = new Map();
  private initialized = false;

  constructor(config: RAGKnowledgeBaseConfig = {}) {
    this.config = {
      embeddingProvider: config.embeddingProvider ?? 'hash',
      embeddingModel: config.embeddingModel ?? 'text-embedding-3-small',
      chunking: config.chunking ?? {},
      defaultTopK: config.defaultTopK ?? 5,
      defaultMinSimilarity: config.defaultMinSimilarity ?? 0.3,
    };

    this.embedder = createEmbeddingProvider(
      this.config.embeddingProvider,
      { model: this.config.embeddingModel }
    );
    this.vectorStore = createVectorStore();
    this.chunker = createChunker(this.config.chunking);
  }

  /**
   * Add an entry to the knowledge base
   */
  async addEntry(entry: KnowledgeEntry): Promise<void> {
    this.entries.set(entry.name, entry);

    // Chunk the content
    const chunks = this.chunker.chunk(entry.content, entry.name);

    // Embed chunks
    const texts = chunks.map(c => c.text);
    const embeddings = await this.embedder.embedBatch(texts);

    // Store in vector store
    for (let i = 0; i < chunks.length; i++) {
      const storedChunk: StoredChunk = {
        id: chunks[i].id,
        text: chunks[i].text,
        embedding: embeddings[i],
        metadata: chunks[i].metadata,
      };
      this.vectorStore.add(storedChunk);
    }
  }

  /**
   * Add multiple entries
   */
  async addEntries(entries: KnowledgeEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.addEntry(entry);
    }
    this.initialized = true;
  }

  /**
   * Load from a knowledge base package
   */
  async loadFromPackage(pkg: {
    entries?: Record<string, { name: string; content: string }>;
    getAllEntries?: () => Array<{ name: string; content: string }>;
  }): Promise<void> {
    const entries: KnowledgeEntry[] = [];

    if (pkg.getAllEntries) {
      for (const entry of pkg.getAllEntries()) {
        entries.push({ name: entry.name, content: entry.content });
      }
    } else if (pkg.entries) {
      for (const entry of Object.values(pkg.entries)) {
        entries.push({ name: entry.name, content: entry.content });
      }
    }

    await this.addEntries(entries);
  }

  /**
   * Retrieve relevant context for a query
   */
  async retrieve(
    query: string,
    options?: {
      topK?: number;
      minSimilarity?: number;
      maxTokens?: number;
      sources?: string[];
    }
  ): Promise<RetrievedContext> {
    const topK = options?.topK ?? this.config.defaultTopK;
    const minSimilarity = options?.minSimilarity ?? this.config.defaultMinSimilarity;
    const maxTokens = options?.maxTokens ?? 4000;

    // Embed query
    const queryEmbedding = await this.embedder.embed(query);

    // Search vector store
    let results = this.vectorStore.search(queryEmbedding, { topK: topK * 2, minSimilarity });

    // Filter by sources if specified
    if (options?.sources && options.sources.length > 0) {
      results = results.filter(r =>
        options.sources!.includes(r.chunk.metadata.source)
      );
    }

    // Take top K after filtering
    results = results.slice(0, topK);

    // Build context respecting token limit
    const chunks: RetrievedChunk[] = [];
    let totalTokens = 0;

    for (const result of results) {
      const chunkTokens = Math.ceil(result.chunk.text.length / 4); // Rough estimate

      if (totalTokens + chunkTokens > maxTokens) {
        // Truncate if we're going over
        const remainingTokens = maxTokens - totalTokens;
        if (remainingTokens > 50) {
          const truncatedText = result.chunk.text.substring(0, remainingTokens * 4);
          chunks.push({
            text: truncatedText + '...',
            source: result.chunk.metadata.source,
            section: result.chunk.metadata.section,
            similarity: result.similarity,
          });
          totalTokens = maxTokens;
        }
        break;
      }

      chunks.push({
        text: result.chunk.text,
        source: result.chunk.metadata.source,
        section: result.chunk.metadata.section,
        similarity: result.similarity,
      });
      totalTokens += chunkTokens;
    }

    return { chunks, totalTokensEstimate: totalTokens };
  }

  /**
   * Format retrieved context for agent prompt
   */
  formatContext(context: RetrievedContext): string {
    if (context.chunks.length === 0) {
      return '';
    }

    const sections: string[] = ['## Relevant Context\n'];

    for (const chunk of context.chunks) {
      const header = chunk.section
        ? `### ${chunk.source} - ${chunk.section}`
        : `### ${chunk.source}`;
      sections.push(`${header}\n\n${chunk.text}\n`);
    }

    return sections.join('\n');
  }

  /**
   * Retrieve and format in one step
   */
  async getContext(
    query: string,
    options?: {
      topK?: number;
      minSimilarity?: number;
      maxTokens?: number;
      sources?: string[];
    }
  ): Promise<string> {
    const context = await this.retrieve(query, options);
    return this.formatContext(context);
  }

  /**
   * Get entry by name
   */
  get(name: string): KnowledgeEntry | undefined {
    return this.entries.get(name);
  }

  /**
   * Get all entry names
   */
  getNames(): string[] {
    return Array.from(this.entries.keys());
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get stats
   */
  getStats(): {
    entryCount: number;
    chunkCount: number;
    dimensions: number;
  } {
    return {
      entryCount: this.entries.size,
      chunkCount: this.vectorStore.size(),
      dimensions: this.embedder.dimensions,
    };
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.entries.clear();
    this.vectorStore.clear();
    this.initialized = false;
  }
}

/**
 * Create a RAG knowledge base
 */
export function createRAGKnowledgeBase(
  config?: RAGKnowledgeBaseConfig
): RAGKnowledgeBase {
  return new RAGKnowledgeBase(config);
}
