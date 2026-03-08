import type { ToolDefinition, ToolHandler } from '../../loop/index.js';
import type { WoodburyToolDefinition } from '../../types';

// Convert ToolDefinition to WoodburyToolDefinition format for consistency
function convertToolDefinition(name: string, description: string, parameters: any, handler: ToolHandler): WoodburyToolDefinition {
  return {
    name,
    description,
    parameters,
    execute: async (params: any) => {
      try {
        const result = await handler(params, {
          workingDirectory: process.cwd(),
          timeout: 30000
        });
        return {
          success: true,
          data: result
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  };
}

// Google Search Tool
export const google_search: WoodburyToolDefinition = {
  name: 'google_search',
  description: 'Search the web using Google Custom Search. Returns titles, snippets, and links for matching results.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query'
      },
      numResults: {
        type: 'number',
        description: 'Number of results to return (1-10, default: 5)',
        default: 5
      },
      siteSearch: {
        type: 'string',
        description: 'Restrict results to a specific site (e.g. "developer.mozilla.org")'
      }
    },
    required: ['query']
  },
  async execute(params: { query: string; numResults?: number; siteSearch?: string }) {
    try {
      // This would integrate with actual Google Search API
      // For now, return a mock response
      return {
        success: true,
        data: {
          query: params.query,
          results: [
            {
              title: `Search results for: ${params.query}`,
              snippet: 'Mock search result - Google Search API integration needed',
              link: 'https://example.com'
            }
          ]
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
};

// DuckDuckGo Search Tool
export const duckduckgo_search: WoodburyToolDefinition = {
  name: 'duckduckgo_search',
  description: 'Search the web using DuckDuckGo Instant Answer API. Returns instant answers, abstracts, and related topics. Good for factual queries and finding official documentation. No API key required.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query'
      },
      numResults: {
        type: 'number',
        description: 'Maximum number of results to return (1-20, default: 10)',
        default: 10
      }
    },
    required: ['query']
  },
  async execute(params: { query: string; numResults?: number }) {
    try {
      // This would integrate with actual DuckDuckGo API
      // For now, return a mock response
      return {
        success: true,
        data: {
          query: params.query,
          abstract: `Mock search result for: ${params.query}`,
          abstractText: 'DuckDuckGo search integration needed',
          abstractURL: 'https://example.com',
          results: []
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
};

// API Search Tool
export const api_search: WoodburyToolDefinition = {
  name: 'api_search',
  description: 'Intelligent API documentation search. Combines direct documentation access, web search, and smart URL pattern matching to find authentication methods and integration guides for APIs.',
  parameters: {
    type: 'object',
    properties: {
      apiName: {
        type: 'string',
        description: 'Name of the API or service (e.g., "Stripe", "PayPal", "Twilio")'
      },
      searchQuery: {
        type: 'string',
        description: 'Optional specific search query. If not provided, will search for authentication documentation.'
      },
      includeAuth: {
        type: 'boolean',
        description: 'Whether to specifically look for authentication documentation (default: true)',
        default: true
      }
    },
    required: ['apiName']
  },
  async execute(params: { apiName: string; searchQuery?: string; includeAuth?: boolean }) {
    try {
      // This would integrate with actual API documentation sources
      // For now, return a mock response
      const query = params.searchQuery || `${params.apiName} API authentication`;
      
      return {
        success: true,
        data: {
          apiName: params.apiName,
          query,
          documentation: {
            name: params.apiName,
            baseUrl: `https://api.${params.apiName.toLowerCase()}.com`,
            authMethods: ['API Key', 'OAuth 2.0'],
            endpoints: [
              {
                method: 'GET',
                path: '/v1/resource',
                description: `Get ${params.apiName} resource`
              }
            ]
          },
          searchResults: [
            {
              title: `${params.apiName} API Documentation`,
              url: `https://docs.${params.apiName.toLowerCase()}.com`,
              snippet: `Official ${params.apiName} API documentation and authentication guide`
            }
          ]
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
};
