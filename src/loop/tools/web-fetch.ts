import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const webFetchDefinition: ToolDefinition = {
  name: 'web_fetch',
  description: 'Fetch content from a URL using HTTP. Supports GET, POST, PUT, DELETE, and PATCH methods. Response body is truncated at 100 KB.',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL to fetch (must start with http:// or https://)'
      },
      method: {
        type: 'string',
        description: 'HTTP method (default: "GET")',
        default: 'GET'
      },
      headers: {
        type: 'object',
        description: 'HTTP headers as key-value pairs'
      },
      body: {
        type: 'string',
        description: 'Request body (for POST, PUT, PATCH)'
      }
    },
    required: ['url']
  }
};

export const webFetchHandler: ToolHandler = async (params: any, context?: ToolContext) => {
  const url = params.url as string;
  const method = (params.method as string) || 'GET';
  const headers = (params.headers as Record<string, string>) || {};
  const body = params.body as string | undefined;
  
  if (!url) {
    throw new Error('url parameter is required');
  }
  
  if (typeof url !== 'string') {
    throw new Error('url must be a string');
  }
  
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error('URL must start with http:// or https://');
  }
  
  try {
    const requestInit: RequestInit = {
      method: method.toUpperCase(),
      headers: {
        'User-Agent': 'Agentic-Loop/1.0',
        ...headers
      }
    };
    
    if (body && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
      requestInit.body = body;
      if (!headers['Content-Type'] && !headers['content-type']) {
        requestInit.headers = {
          ...requestInit.headers,
          'Content-Type': 'application/json'
        };
      }
    }
    
    const response = await fetch(url, requestInit);
    
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    
    let responseBody: string;
    const contentLength = response.headers.get('content-length');
    const maxSize = 100 * 1024; // 100 KB
    
    if (contentLength && parseInt(contentLength) > maxSize) {
      responseBody = `[Response body truncated - size exceeds ${maxSize} bytes]`;
    } else {
      const text = await response.text();
      if (text.length > maxSize) {
        responseBody = text.substring(0, maxSize) + '\n[Response truncated...]';
      } else {
        responseBody = text;
      }
    }
    
    const result = [
      `Status: ${response.status} ${response.statusText}`,
      `URL: ${url}`,
      `Method: ${method.toUpperCase()}`,
      '',
      'Headers:'
    ];
    
    for (const [key, value] of Object.entries(responseHeaders)) {
      result.push(`  ${key}: ${value}`);
    }
    
    result.push('', 'Body:');
    result.push(responseBody);
    
    return result.join('\n');
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to fetch URL: ${error.message}`);
    }
    throw new Error(`Failed to fetch URL: ${String(error)}`);
  }
};
