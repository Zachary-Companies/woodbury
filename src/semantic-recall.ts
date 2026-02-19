// Semantic memory search functions

export interface MemoryEntry {
  id: string;
  content: string;
  keywords: string[];
  timestamp: Date;
}

export function improvedKeywordSearch(entries: MemoryEntry[], query: string): MemoryEntry[] {
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  
  const scored = entries.map(entry => {
    let score = 0;
    const contentLower = entry.content.toLowerCase();
    const keywords = entry.keywords.map(k => k.toLowerCase());
    
    // Score based on exact matches in content
    queryWords.forEach(word => {
      if (contentLower.includes(word)) {
        score += 2;
      }
      if (keywords.includes(word)) {
        score += 3;
      }
    });
    
    return { entry, score };
  });
  
  return scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(item => item.entry);
}

export async function llmRerank(entries: MemoryEntry[], query: string): Promise<MemoryEntry[]> {
  // For now, return the keyword search results
  // In the future, this could use an LLM to rerank results by semantic similarity
  return improvedKeywordSearch(entries, query);
}
