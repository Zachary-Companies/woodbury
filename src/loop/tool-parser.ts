import { ToolCall, ToolCallValidationResult } from './types.js';

export class ToolParser {
  /**
   * Parse tool calls from LLM response.
   * Uses a two-pass approach: first a greedy regex, then fallback to
   * character-level scanning for edge cases (nested braces in JSON, etc.)
   */
  static parseToolCalls(text: string): ToolCall[] {
    const toolCalls: ToolCall[] = [];

    // Primary regex — handles the common case
    const regex = /<tool_call>\s*<name>([^<]+)<\/name>\s*<parameters>([\s\S]*?)<\/parameters>\s*<\/tool_call>/g;

    let match;
    while ((match = regex.exec(text)) !== null) {
      const name = match[1].trim();
      const parametersText = match[2].trim();
      const parsed = ToolParser.safeParseJSON(parametersText);
      toolCalls.push({ name, parameters: parsed });
    }

    // If the primary regex found nothing but tags exist, try character-level scan
    if (toolCalls.length === 0 && text.includes('<tool_call>')) {
      return ToolParser.scanToolCalls(text);
    }

    return toolCalls;
  }

  /**
   * Character-level scanner for tool calls.
   * Handles cases where JSON contains characters that confuse the regex
   * (e.g. nested braces, angle brackets inside strings).
   */
  private static scanToolCalls(text: string): ToolCall[] {
    const toolCalls: ToolCall[] = [];
    let pos = 0;

    while (pos < text.length) {
      const openTag = text.indexOf('<tool_call>', pos);
      if (openTag === -1) break;

      const closeTag = text.indexOf('</tool_call>', openTag);
      if (closeTag === -1) break;

      const inner = text.slice(openTag + '<tool_call>'.length, closeTag);

      // Extract name
      const nameMatch = inner.match(/<name>([\s\S]*?)<\/name>/);
      if (!nameMatch) {
        pos = closeTag + '</tool_call>'.length;
        continue;
      }
      const name = nameMatch[1].trim();

      // Extract parameters — find the outermost { ... } block to handle nested JSON
      const paramOpen = inner.indexOf('<parameters>');
      const paramClose = inner.lastIndexOf('</parameters>');

      let parameters: Record<string, unknown> = {};
      if (paramOpen !== -1 && paramClose !== -1) {
        const rawParams = inner.slice(paramOpen + '<parameters>'.length, paramClose).trim();
        parameters = ToolParser.safeParseJSON(rawParams);
      }

      toolCalls.push({ name, parameters });
      pos = closeTag + '</tool_call>'.length;
    }

    return toolCalls;
  }

  /**
   * Safely parse JSON with multiple recovery strategies.
   */
  private static safeParseJSON(text: string): Record<string, unknown> {
    if (!text) return {};

    // 1. Direct parse
    try {
      return JSON.parse(text);
    } catch { /* continue */ }

    // 2. Strip markdown code fences that LLMs sometimes add
    const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    try {
      return JSON.parse(stripped);
    } catch { /* continue */ }

    // 3. Try to extract the JSON object from surrounding text
    const braceStart = text.indexOf('{');
    const braceEnd = text.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd > braceStart) {
      try {
        return JSON.parse(text.slice(braceStart, braceEnd + 1));
      } catch { /* continue */ }
    }

    // 4. Return error marker
    return { _parseError: 'Invalid JSON in parameters', _raw: text.slice(0, 500) };
  }

  /**
   * Check if response contains tool calls
   */
  static hasToolCalls(text: string): boolean {
    return text.includes('<tool_call>');
  }

  /**
   * Check if response contains a final answer
   */
  static hasFinalAnswer(text: string): boolean {
    return text.includes('<final_answer>') && text.includes('</final_answer>');
  }

  /**
   * Extract final answer from response.
   * Uses greedy match to handle nested content.
   */
  static extractFinalAnswer(text: string): string | null {
    const openTag = '<final_answer>';
    const closeTag = '</final_answer>';
    const start = text.indexOf(openTag);
    const end = text.lastIndexOf(closeTag);

    if (start === -1 || end === -1 || end <= start) return null;

    return text.slice(start + openTag.length, end).trim();
  }

  /**
   * Extract text content that appears outside of tool_call tags.
   * Useful for capturing the LLM's reasoning/explanation alongside tool calls.
   */
  static extractTextOutsideTags(text: string): string {
    return text
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
      .replace(/<final_answer>[\s\S]*?<\/final_answer>/g, '')
      .replace(/<tool_result[\s\S]*?<\/tool_result>/g, '')
      .trim();
  }

  /**
   * Format tool result for LLM consumption
   */
  static formatToolResult(toolName: string, status: 'success' | 'error', result: string): string {
    return `<tool_result name="${toolName}" status="${status}">\n${result}\n</tool_result>`;
  }
}

// Convenience exports for backwards compatibility
export const parseToolCalls = ToolParser.parseToolCalls;
export const hasToolCalls = ToolParser.hasToolCalls;
export const parseToolCall = parseToolCalls; // Legacy alias

export const validateToolCall = (call: ToolCall): ToolCallValidationResult => {
  if (!call.name || typeof call.name !== 'string') {
    return { isValid: false, error: 'Tool name is required and must be a string' };
  }

  if (!call.parameters || typeof call.parameters !== 'object') {
    return { isValid: false, error: 'Tool parameters must be an object' };
  }

  return { isValid: true };
};
