import { ConversationTurn } from './types';

interface CompactionOptions {
  maxLength: number;
  keepRecent: number;
}

export class ContextCompactor {
  private options: CompactionOptions;

  constructor(options: CompactionOptions) {
    this.options = options;
  }

  compact(turns: ConversationTurn[]): ConversationTurn[] {
    if (this.getTotalLength(turns) <= this.options.maxLength) {
      return turns;
    }

    // Keep the most recent turns and compact the rest
    const recentTurns = turns.slice(-this.options.keepRecent);
    const olderTurns = turns.slice(0, -this.options.keepRecent);

    if (olderTurns.length === 0) {
      return recentTurns;
    }

    // Create a structured summary of older turns
    const summaryContent = this.summarizeTurns(olderTurns);
    const summaryTurn: ConversationTurn = {
      id: 'summary',
      timestamp: olderTurns[0].timestamp,
      role: 'assistant',
      content: summaryContent,
      userMessage: summaryContent,
      assistantMessage: undefined
    };

    return [summaryTurn, ...recentTurns];
  }

  private getTotalLength(turns: ConversationTurn[]): number {
    return turns.reduce((total, turn) => {
      const userLength = turn.userMessage?.length || 0;
      const assistantLength = turn.assistantMessage?.length || 0;
      const contentLength = turn.content?.length || 0;
      return total + userLength + assistantLength + contentLength;
    }, 0);
  }

  /**
   * Produce a structured summary that preserves key information:
   * - User requests (full first sentence)
   * - Files mentioned
   * - Decisions / outcomes
   * - Tool calls made
   */
  private summarizeTurns(turns: ConversationTurn[]): string {
    const userRequests: string[] = [];
    const filesModified = new Set<string>();
    const decisions: string[] = [];

    for (const turn of turns) {
      const content = turn.content || turn.userMessage || turn.assistantMessage || '';

      if (turn.role === 'user') {
        // Keep the first sentence of each user message
        const firstSentence = content.split(/[.!?\n]/)[0].trim();
        if (firstSentence.length > 0 && firstSentence.length <= 200) {
          userRequests.push(firstSentence);
        } else if (firstSentence.length > 200) {
          userRequests.push(firstSentence.slice(0, 200) + '...');
        }
      }

      if (turn.role === 'assistant') {
        // Extract file paths mentioned (common patterns)
        const filePaths = content.match(/(?:[\w./\-]+\.(?:ts|js|json|md|tsx|jsx|py|rs|go|css|html))/g);
        if (filePaths) {
          filePaths.slice(0, 10).forEach(f => filesModified.add(f));
        }

        // Extract key decision phrases
        const decisionPatterns = [
          /(?:I (?:will|decided to|chose to|created|updated|modified|deleted|fixed|added|removed))\s+[^.!?\n]{5,80}/gi,
        ];
        for (const pattern of decisionPatterns) {
          const matches = content.match(pattern);
          if (matches) {
            decisions.push(...matches.slice(0, 3));
          }
        }
      }
    }

    const parts: string[] = [
      `[Summary of ${turns.length} earlier messages]`,
    ];

    if (userRequests.length > 0) {
      parts.push(`User requests: ${userRequests.join('; ')}`);
    }

    if (filesModified.size > 0) {
      parts.push(`Files referenced: ${Array.from(filesModified).slice(0, 15).join(', ')}`);
    }

    if (decisions.length > 0) {
      parts.push(`Key actions: ${decisions.slice(0, 5).join('; ')}`);
    }

    return parts.join('\n');
  }
}

export function compactContext(turns: ConversationTurn[], maxLength = 8000, keepRecent = 5): ConversationTurn[] {
  const compactor = new ContextCompactor({ maxLength, keepRecent });
  return compactor.compact(turns);
}
