import { ToolParser, parseToolCalls, hasToolCalls, validateToolCall } from '../loop/tool-parser';

describe('ToolParser', () => {
  describe('parseToolCalls', () => {
    it('should parse a single well-formed tool call', () => {
      const text = `<tool_call>
<name>file_read</name>
<parameters>{"path": "/tmp/test.txt"}</parameters>
</tool_call>`;

      const calls = ToolParser.parseToolCalls(text);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('file_read');
      expect(calls[0].parameters).toEqual({ path: '/tmp/test.txt' });
    });

    it('should parse multiple tool calls', () => {
      const text = `Let me read two files.
<tool_call>
<name>file_read</name>
<parameters>{"path": "a.txt"}</parameters>
</tool_call>
<tool_call>
<name>file_read</name>
<parameters>{"path": "b.txt"}</parameters>
</tool_call>`;

      const calls = ToolParser.parseToolCalls(text);
      expect(calls).toHaveLength(2);
      expect(calls[0].parameters).toEqual({ path: 'a.txt' });
      expect(calls[1].parameters).toEqual({ path: 'b.txt' });
    });

    it('should handle whitespace variations in tags', () => {
      const text = `<tool_call>  <name>  bash  </name>  <parameters>  {"command": "ls"}  </parameters>  </tool_call>`;
      const calls = ToolParser.parseToolCalls(text);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('bash');
      expect(calls[0].parameters).toEqual({ command: 'ls' });
    });

    it('should return empty array when no tool calls present', () => {
      const text = 'This is just regular text with no tool calls.';
      const calls = ToolParser.parseToolCalls(text);
      expect(calls).toHaveLength(0);
    });

    it('should fall back to scanner for nested JSON braces', () => {
      // The regex may struggle with deeply nested JSON; the scanner should handle it
      const text = `<tool_call>
<name>file_write</name>
<parameters>{"path": "config.json", "content": "{\\"key\\": {\\"nested\\": true}}"}</parameters>
</tool_call>`;

      const calls = ToolParser.parseToolCalls(text);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('file_write');
      expect(calls[0].parameters.path).toBe('config.json');
    });

    it('should skip tool_call blocks with no name tag', () => {
      const text = `<tool_call>
<parameters>{"path": "test.txt"}</parameters>
</tool_call>`;

      // The primary regex won't match (no name), scanner will skip it
      const calls = ToolParser.parseToolCalls(text);
      expect(calls).toHaveLength(0);
    });

    it('should handle empty parameters', () => {
      const text = `<tool_call>
<name>list_tools</name>
<parameters>{}</parameters>
</tool_call>`;

      const calls = ToolParser.parseToolCalls(text);
      expect(calls).toHaveLength(1);
      expect(calls[0].parameters).toEqual({});
    });
  });

  describe('safeParseJSON (via parseToolCalls)', () => {
    it('should handle JSON wrapped in markdown code fences', () => {
      const text = `<tool_call>
<name>bash</name>
<parameters>\`\`\`json
{"command": "echo hello"}
\`\`\`</parameters>
</tool_call>`;

      const calls = ToolParser.parseToolCalls(text);
      expect(calls).toHaveLength(1);
      expect(calls[0].parameters).toEqual({ command: 'echo hello' });
    });

    it('should extract JSON from surrounding text', () => {
      const text = `<tool_call>
<name>bash</name>
<parameters>Here is the JSON: {"command": "pwd"} that I want to use</parameters>
</tool_call>`;

      const calls = ToolParser.parseToolCalls(text);
      expect(calls).toHaveLength(1);
      expect(calls[0].parameters).toEqual({ command: 'pwd' });
    });

    it('should return _parseError for completely invalid JSON', () => {
      const text = `<tool_call>
<name>bash</name>
<parameters>not valid json at all</parameters>
</tool_call>`;

      const calls = ToolParser.parseToolCalls(text);
      expect(calls).toHaveLength(1);
      expect(calls[0].parameters._parseError).toBe('Invalid JSON in parameters');
      expect(calls[0].parameters._raw).toBeDefined();
    });

    it('should handle empty parameter text', () => {
      const text = `<tool_call>
<name>bash</name>
<parameters></parameters>
</tool_call>`;

      const calls = ToolParser.parseToolCalls(text);
      expect(calls).toHaveLength(1);
      expect(calls[0].parameters).toEqual({});
    });
  });

  describe('hasToolCalls', () => {
    it('should return true when tool_call tag present', () => {
      expect(ToolParser.hasToolCalls('text <tool_call> more text')).toBe(true);
    });

    it('should return false when no tool_call tag', () => {
      expect(ToolParser.hasToolCalls('just plain text')).toBe(false);
    });
  });

  describe('hasFinalAnswer', () => {
    it('should return true when both open and close tags present', () => {
      expect(ToolParser.hasFinalAnswer('<final_answer>Done!</final_answer>')).toBe(true);
    });

    it('should return false with only open tag', () => {
      expect(ToolParser.hasFinalAnswer('<final_answer>incomplete')).toBe(false);
    });

    it('should return false with only close tag', () => {
      expect(ToolParser.hasFinalAnswer('no open</final_answer>')).toBe(false);
    });

    it('should return false with no tags', () => {
      expect(ToolParser.hasFinalAnswer('no tags at all')).toBe(false);
    });
  });

  describe('extractFinalAnswer', () => {
    it('should extract content between final_answer tags', () => {
      const text = 'Some preamble\n<final_answer>The result is 42.</final_answer>\nSome epilogue';
      expect(ToolParser.extractFinalAnswer(text)).toBe('The result is 42.');
    });

    it('should handle multiline final answers', () => {
      const text = `<final_answer>
Line 1
Line 2
Line 3
</final_answer>`;
      const result = ToolParser.extractFinalAnswer(text);
      expect(result).toContain('Line 1');
      expect(result).toContain('Line 3');
    });

    it('should return null when tags are missing', () => {
      expect(ToolParser.extractFinalAnswer('no tags here')).toBeNull();
    });

    it('should return null when close tag comes before open tag', () => {
      expect(ToolParser.extractFinalAnswer('</final_answer>wrong order<final_answer>')).toBeNull();
    });
  });

  describe('extractTextOutsideTags', () => {
    it('should strip tool_call tags and return surrounding text', () => {
      const text = `I will read the file.
<tool_call><name>file_read</name><parameters>{"path":"a.txt"}</parameters></tool_call>
That's my plan.`;

      const result = ToolParser.extractTextOutsideTags(text);
      expect(result).toContain('I will read the file.');
      expect(result).toContain("That's my plan.");
      expect(result).not.toContain('file_read');
    });

    it('should strip final_answer tags', () => {
      const text = 'Preamble <final_answer>answer</final_answer> epilogue';
      const result = ToolParser.extractTextOutsideTags(text);
      expect(result).toContain('Preamble');
      expect(result).toContain('epilogue');
      expect(result).not.toContain('answer');
    });

    it('should strip tool_result tags', () => {
      const text = 'Before <tool_result name="bash" status="success">output</tool_result> after';
      const result = ToolParser.extractTextOutsideTags(text);
      expect(result).toContain('Before');
      expect(result).toContain('after');
      expect(result).not.toContain('output');
    });

    it('should handle text with no tags', () => {
      expect(ToolParser.extractTextOutsideTags('plain text')).toBe('plain text');
    });
  });

  describe('formatToolResult', () => {
    it('should format a success result', () => {
      const result = ToolParser.formatToolResult('bash', 'success', 'hello world');
      expect(result).toBe('<tool_result name="bash" status="success">\nhello world\n</tool_result>');
    });

    it('should format an error result', () => {
      const result = ToolParser.formatToolResult('file_read', 'error', 'File not found');
      expect(result).toContain('status="error"');
      expect(result).toContain('File not found');
    });
  });

  describe('convenience exports', () => {
    it('parseToolCalls should be the same as ToolParser.parseToolCalls', () => {
      expect(parseToolCalls).toBe(ToolParser.parseToolCalls);
    });

    it('hasToolCalls should be the same as ToolParser.hasToolCalls', () => {
      expect(hasToolCalls).toBe(ToolParser.hasToolCalls);
    });
  });

  describe('validateToolCall', () => {
    it('should validate a well-formed tool call', () => {
      const result = validateToolCall({ name: 'bash', parameters: { command: 'ls' } });
      expect(result.isValid).toBe(true);
    });

    it('should reject missing name', () => {
      const result = validateToolCall({ name: '', parameters: { command: 'ls' } });
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('name');
    });

    it('should reject non-string name', () => {
      const result = validateToolCall({ name: 123 as any, parameters: {} });
      expect(result.isValid).toBe(false);
    });

    it('should reject non-object parameters', () => {
      const result = validateToolCall({ name: 'bash', parameters: 'invalid' as any });
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('parameters');
    });

    it('should reject null parameters', () => {
      const result = validateToolCall({ name: 'bash', parameters: null as any });
      expect(result.isValid).toBe(false);
    });
  });
});
