import { Agent, AgentFactory } from './agent-factory.js';
import { CodeGenerationRequest, CodeGenerationResult, CodeExample } from './types.js';
import { createLogger, Logger } from './logger.js';

export class CodeGenerator {
  private logger: Logger;
  private agent: Agent;

  constructor(config: {
    provider?: 'openai' | 'anthropic' | 'groq';
    model?: string;
    apiKey?: string;
    logger?: Logger;
  } = {}) {
    this.logger = config.logger || createLogger('CodeGenerator');
    
    // Create agent with code generation specific configuration
    const agentConfig = {
      name: 'CodeGeneratorAgent',
      provider: config.provider || 'openai',
      model: config.model || 'gpt-4',
      apiKey: config.apiKey,
      systemPrompt: this.getSystemPrompt(),
      maxTokens: 4000,
      temperature: 0.1, // Low temperature for consistent code generation
    };

    this.agent = AgentFactory.create(agentConfig);
  }

  private getSystemPrompt(): string {
    return `You are a code generation assistant. Generate clean, well-documented code based on user requirements.

Instructions:
- Generate functional, production-ready code
- Include proper error handling
- Add clear comments and documentation
- Follow best practices for the target language/framework
- Provide explanations when helpful
- Include examples when appropriate

Response format should be structured with:
- Generated code
- Brief explanation of approach
- Usage examples if helpful
- Dependencies or setup notes if needed`;
  }

  async generateCode(request: CodeGenerationRequest): Promise<CodeGenerationResult> {
    try {
      this.logger.info('Generating code for request', { 
        language: request.language,
        framework: request.framework,
        hasExamples: Boolean(request.examples?.length),
        functionName: request.functionName
      });

      // Build the prompt with all available context
      const prompt = this.buildPrompt(request);
      
      this.logger.debug('Built prompt', { prompt });

      // Execute the agent to generate code
      const result = await this.agent.execute(prompt);

      if (!result.success) {
        throw new Error(`Code generation failed: ${result.error}`);
      }

      // Parse and structure the response
      const codeResult = this.parseCodeResponse(result.content, request);
      
      this.logger.info('Code generation completed successfully');
      
      return codeResult;
    } catch (error) {
      this.logger.error('Code generation failed', error);
      throw error;
    }
  }

  private buildPrompt(request: CodeGenerationRequest): string {
    let prompt = request.prompt;

    // Add language/framework context
    if (request.language) {
      prompt += `\n\nTarget language: ${request.language}`;
    }
    if (request.framework) {
      prompt += `\nTarget framework: ${request.framework}`;
    }
    if (request.functionName) {
      prompt += `\nFunction/method name: ${request.functionName}`;
    }

    // Add examples if provided
    if (request.examples && request.examples.length > 0) {
      prompt += '\n\nExamples:';
      request.examples.forEach((example, index) => {
        prompt += `\n\nExample ${index + 1}:`;
        prompt += `\nInput: ${example.input}`;
        prompt += `\nExpected Output: ${example.output}`;
        if (example.description) {
          prompt += `\nDescription: ${example.description}`;
        }
      });
    }

    // Add constraints if provided
    if (request.constraints && request.constraints.length > 0) {
      prompt += '\n\nConstraints:';
      request.constraints.forEach(constraint => {
        prompt += `\n- ${constraint}`;
      });
    }

    return prompt;
  }

  private parseCodeResponse(content: string, request: CodeGenerationRequest): CodeGenerationResult {
    // Try to extract code blocks from markdown
    const codeBlockRegex = /```(?:\w+)?\n([\s\S]*?)\n```/g;
    const codeBlocks: string[] = [];
    let match;
    
    while ((match = codeBlockRegex.exec(content)) !== null) {
      codeBlocks.push(match[1].trim());
    }

    // If we found code blocks, use the first/main one
    let code = '';
    if (codeBlocks.length > 0) {
      code = codeBlocks[0];
    } else {
      // Fallback: try to extract code-like content
      const lines = content.split('\n');
      const codeLines: string[] = [];
      let inCodeSection = false;
      
      for (const line of lines) {
        if (line.toLowerCase().includes('code:') || line.toLowerCase().includes('solution:')) {
          inCodeSection = true;
          continue;
        }
        if (inCodeSection && (line.startsWith('function') || line.startsWith('class') || line.startsWith('def ') || line.includes('{') || line.includes('=') || line.trim().startsWith('//') || line.trim().startsWith('#'))) {
          codeLines.push(line);
        } else if (inCodeSection && line.trim() === '') {
          codeLines.push(line);
        } else if (inCodeSection && !line.match(/^[a-zA-Z\s:]+$/)) {
          codeLines.push(line);
        }
      }
      
      if (codeLines.length > 0) {
        code = codeLines.join('\n').trim();
      } else {
        // Last resort: use the entire content
        code = content.trim();
      }
    }

    // Extract explanation (text that's not in code blocks)
    let explanation: string | undefined = content.replace(/```(?:\w+)?\n[\s\S]*?\n```/g, '').trim();
    if (explanation === code) {
      explanation = undefined; // Avoid duplication
    }

    // Try to extract dependencies mentioned in the response
    const dependencies: string[] = [];
    const depRegex = /(?:import|require|from)\s+['"]([^'"]+)['"]/g;
    let depMatch;
    while ((depMatch = depRegex.exec(code)) !== null) {
      const dep = depMatch[1];
      if (!dep.startsWith('.') && !dep.startsWith('/') && !dependencies.includes(dep)) {
        dependencies.push(dep);
      }
    }

    return {
      code,
      explanation,
      examples: request.examples,
      dependencies: dependencies.length > 0 ? dependencies : undefined
    };
  }

  async generateFunction(options: {
    functionName: string;
    description: string;
    parameters?: { name: string; type: string; description?: string }[];
    returnType?: string;
    language?: string;
    framework?: string;
    examples?: CodeExample[];
    constraints?: string[];
  }): Promise<CodeGenerationResult> {
    const { functionName, description, parameters = [], returnType, language, framework, examples, constraints } = options;
    
    let prompt = `Generate a ${language || 'JavaScript'} function named "${functionName}".

Description: ${description}`;
    
    if (parameters.length > 0) {
      prompt += '\n\nParameters:';
      parameters.forEach(param => {
        prompt += `\n- ${param.name}: ${param.type}`;
        if (param.description) {
          prompt += ` - ${param.description}`;
        }
      });
    }
    
    if (returnType) {
      prompt += `\n\nReturn type: ${returnType}`;
    }
    
    return this.generateCode({
      prompt,
      language,
      framework,
      functionName,
      examples,
      constraints
    });
  }

  async generateClass(options: {
    className: string;
    description: string;
    methods?: { name: string; description: string; parameters?: any[]; returnType?: string }[];
    properties?: { name: string; type: string; description?: string }[];
    language?: string;
    framework?: string;
    examples?: CodeExample[];
    constraints?: string[];
  }): Promise<CodeGenerationResult> {
    const { className, description, methods = [], properties = [], language, framework, examples, constraints } = options;
    
    let prompt = `Generate a ${language || 'JavaScript'} class named "${className}".

Description: ${description}`;
    
    if (properties.length > 0) {
      prompt += '\n\nProperties:';
      properties.forEach(prop => {
        prompt += `\n- ${prop.name}: ${prop.type}`;
        if (prop.description) {
          prompt += ` - ${prop.description}`;
        }
      });
    }
    
    if (methods.length > 0) {
      prompt += '\n\nMethods:';
      methods.forEach(method => {
        prompt += `\n- ${method.name}: ${method.description}`;
        if (method.parameters && method.parameters.length > 0) {
          prompt += ` (parameters: ${method.parameters.map(p => `${p.name}: ${p.type}`).join(', ')})`;
        }
        if (method.returnType) {
          prompt += ` -> ${method.returnType}`;
        }
      });
    }
    
    return this.generateCode({
      prompt,
      language,
      framework,
      examples,
      constraints
    });
  }

  async generateFromExamples(examples: CodeExample[], options: {
    language?: string;
    framework?: string;
    functionName?: string;
    description?: string;
    constraints?: string[];
  } = {}): Promise<CodeGenerationResult> {
    const { language, framework, functionName, description, constraints } = options;
    
    let prompt = description || 'Generate code based on the following input/output examples:';
    
    if (functionName) {
      prompt += `\n\nFunction name: ${functionName}`;
    }
    
    prompt += '\n\nAnalyze the pattern in these examples and generate the corresponding code:';
    
    return this.generateCode({
      prompt,
      language,
      framework,
      functionName,
      examples,
      constraints
    });
  }
}

// Export a default instance
export const codeGenerator = new CodeGenerator();
