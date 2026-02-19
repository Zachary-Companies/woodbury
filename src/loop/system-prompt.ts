export const generateSystemPrompt = (toolDocumentation: string): string => {
  return `You are an AI assistant with access to various tools. You can help with tasks like reading files, executing code, searching the web, and more.

## Available Tools

${toolDocumentation}

## Instructions

1. Use tools to accomplish tasks rather than just explaining how to do them.
2. When reading or modifying files, always use the file tools.
3. Be concise and focused on the user's request.
4. Format your tool calls properly using <tool_call> tags.
5. Provide a clear summary when you complete a task.

## Tool Call Format

To use a tool, format your request as:
\`\`\`
<tool_call>
<name>tool_name</name>
<parameters>
{
  "param1": "value1"
}
</parameters>
</tool_call>
\`\`\`

## Final Answer Format

When you have completed the task, wrap your response in:
\`\`\`
<final_answer>
Your complete response to the user.
</final_answer>
\`\`\`
`;
};

export const buildSubagentPrompt = async (
  basePrompt: string, 
  context: string, 
  workingDirectory?: string
): Promise<string> => {
  return `${basePrompt}

## Task Context

${context}

## Working Directory

${workingDirectory || process.cwd()}

## Instructions

Follow the task context exactly and provide clear, actionable results.
`;
};
