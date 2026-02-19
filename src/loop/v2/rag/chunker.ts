/**
 * Chunker - Text chunking by headers/size for RAG
 */

export interface Chunk {
  id: string;
  text: string;
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

export interface ChunkingOptions {
  /** Maximum chunk size in characters (default: 1000) */
  maxChunkSize?: number;
  /** Minimum chunk size in characters (default: 100) */
  minChunkSize?: number;
  /** Overlap between chunks in characters (default: 100) */
  overlap?: number;
  /** Split on markdown headers (default: true) */
  splitOnHeaders?: boolean;
  /** Header levels to split on (default: [1, 2, 3]) */
  headerLevels?: number[];
}

/**
 * Chunk text into smaller pieces for embedding
 */
export class TextChunker {
  private options: Required<ChunkingOptions>;

  constructor(options: ChunkingOptions = {}) {
    this.options = {
      maxChunkSize: options.maxChunkSize ?? 1000,
      minChunkSize: options.minChunkSize ?? 100,
      overlap: options.overlap ?? 100,
      splitOnHeaders: options.splitOnHeaders ?? true,
      headerLevels: options.headerLevels ?? [1, 2, 3],
    };
  }

  /**
   * Chunk a document
   */
  chunk(text: string, source: string): Chunk[] {
    if (this.options.splitOnHeaders && this.hasMarkdownHeaders(text)) {
      return this.chunkByHeaders(text, source);
    }
    return this.chunkBySize(text, source);
  }

  /**
   * Check if text has markdown headers
   */
  private hasMarkdownHeaders(text: string): boolean {
    const headerPattern = new RegExp(
      `^#{1,${Math.max(...this.options.headerLevels)}}\\s`,
      'm'
    );
    return headerPattern.test(text);
  }

  /**
   * Chunk by markdown headers
   */
  private chunkByHeaders(text: string, source: string): Chunk[] {
    const lines = text.split('\n');
    const chunks: Chunk[] = [];
    const headerStack: string[] = [];

    let currentContent: string[] = [];
    let currentSection = '';
    let sectionStartLine = 0;
    let chunkIndex = 0;

    const createChunk = (content: string[], endLine: number) => {
      const chunkText = content.join('\n').trim();
      if (chunkText.length >= this.options.minChunkSize) {
        // If chunk is too large, split it further
        if (chunkText.length > this.options.maxChunkSize) {
          const subChunks = this.chunkBySize(chunkText, source, {
            section: currentSection,
            headers: [...headerStack],
            startLine: sectionStartLine,
          });
          for (const subChunk of subChunks) {
            subChunk.id = `${source}-${chunkIndex++}`;
            chunks.push(subChunk);
          }
        } else {
          chunks.push({
            id: `${source}-${chunkIndex++}`,
            text: chunkText,
            metadata: {
              source,
              section: currentSection,
              headers: [...headerStack],
              startLine: sectionStartLine,
              endLine,
            },
          });
        }
      }
    };

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum];
      const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);

      if (headerMatch) {
        const level = headerMatch[1].length;

        // Only split on configured header levels
        if (this.options.headerLevels.includes(level)) {
          // Save current chunk
          if (currentContent.length > 0) {
            createChunk(currentContent, lineNum - 1);
          }

          // Update header stack
          while (headerStack.length >= level) {
            headerStack.pop();
          }
          headerStack.push(headerMatch[2]);
          currentSection = headerMatch[2];

          // Start new chunk with header
          currentContent = [line];
          sectionStartLine = lineNum;
        } else {
          currentContent.push(line);
        }
      } else {
        currentContent.push(line);
      }
    }

    // Don't forget the last chunk
    if (currentContent.length > 0) {
      createChunk(currentContent, lines.length - 1);
    }

    return chunks;
  }

  /**
   * Chunk by size with overlap
   */
  private chunkBySize(
    text: string,
    source: string,
    baseMetadata?: Partial<ChunkMetadata>
  ): Chunk[] {
    const chunks: Chunk[] = [];
    const sentences = this.splitIntoSentences(text);

    let currentChunk: string[] = [];
    let currentSize = 0;
    let chunkIndex = 0;

    for (const sentence of sentences) {
      const sentenceSize = sentence.length;

      // If adding this sentence would exceed max size
      if (currentSize + sentenceSize > this.options.maxChunkSize && currentChunk.length > 0) {
        // Save current chunk
        const chunkText = currentChunk.join(' ').trim();
        if (chunkText.length >= this.options.minChunkSize) {
          chunks.push({
            id: `${source}-size-${chunkIndex++}`,
            text: chunkText,
            metadata: {
              source,
              ...baseMetadata,
            },
          });
        }

        // Start new chunk with overlap
        const overlapSentences = this.getOverlapSentences(currentChunk, this.options.overlap);
        currentChunk = overlapSentences;
        currentSize = currentChunk.join(' ').length;
      }

      currentChunk.push(sentence);
      currentSize += sentenceSize + 1; // +1 for space
    }

    // Don't forget the last chunk
    if (currentChunk.length > 0) {
      const chunkText = currentChunk.join(' ').trim();
      if (chunkText.length >= this.options.minChunkSize) {
        chunks.push({
          id: `${source}-size-${chunkIndex++}`,
          text: chunkText,
          metadata: {
            source,
            ...baseMetadata,
          },
        });
      }
    }

    return chunks;
  }

  /**
   * Split text into sentences
   */
  private splitIntoSentences(text: string): string[] {
    // Split on sentence boundaries
    const sentencePattern = /[.!?]+[\s\n]+|[\n]{2,}/g;
    const parts = text.split(sentencePattern);

    return parts
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }

  /**
   * Get sentences for overlap
   */
  private getOverlapSentences(sentences: string[], targetOverlap: number): string[] {
    if (sentences.length === 0) return [];

    const result: string[] = [];
    let overlapSize = 0;

    // Work backwards from the end
    for (let i = sentences.length - 1; i >= 0 && overlapSize < targetOverlap; i--) {
      result.unshift(sentences[i]);
      overlapSize += sentences[i].length + 1;
    }

    return result;
  }
}

/**
 * Create a chunker with default options
 */
export function createChunker(options?: ChunkingOptions): TextChunker {
  return new TextChunker(options);
}
