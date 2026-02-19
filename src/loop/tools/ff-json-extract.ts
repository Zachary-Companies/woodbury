import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const ffJsonExtractDefinition: ToolDefinition = {
  name: 'json_extract',
  description: 'Extract JSON from messy text — strips markdown code fences, prose preambles, and other wrappers to find valid JSON. Handles common LLM output formats. Can extract single or multiple JSON objects from a string.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The text to extract JSON from (can contain markdown fences, prose, etc.)'
      },
      multiple: {
        type: 'boolean',
        description: 'If true, extract all JSON objects found in the text. If false, extract the first one (default: false)',
        default: false
      }
    },
    required: ['text']
  }
};

export const ffJsonExtractHandler: ToolHandler = async (params: any, context?: ToolContext) => {
  const text = params.text as string;
  const multiple = params.multiple === true;

  if (!text) {
    throw new Error('text parameter is required');
  }

  let extractJSON: any;
  let extractMultipleJSON: any;
  try {
    const mod = await import('flow-frame-core/dist/jsonHandler.js');
    extractJSON = mod.extractJSON;
    extractMultipleJSON = mod.extractMultipleJSON;
  } catch (err: any) {
    throw new Error(`Failed to load flow-frame-core JSON module: ${err.message}`);
  }

  try {
    if (multiple) {
      const results = extractMultipleJSON(text);
      if (!results || results.length === 0) {
        return 'No JSON objects found in the provided text.';
      }
      const formatted = results.map((obj: any, i: number) =>
        `### JSON Object ${i + 1}\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``
      ).join('\n\n');
      return `Found ${results.length} JSON object(s):\n\n${formatted}`;
    } else {
      const result = extractJSON(text);
      if (result === null || result === undefined) {
        return 'No valid JSON found in the provided text.';
      }
      return `Extracted JSON:\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
    }
  } catch (err: any) {
    throw new Error(`JSON extraction failed: ${err.message}`);
  }
};
