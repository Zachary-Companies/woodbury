import { ToolDefinition, ToolHandler, ToolContext } from '../types';

export const searxngSearchDefinition: ToolDefinition = {
  name: 'searxng_search',
  description: 'Search the web using SearXNG, a privacy-respecting metasearch engine.',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query'
      },
      numResults: {
        type: 'number',
        description: 'Number of results to return (default: 10)',
        default: 10
      },
      categories: {
        type: 'array',
        description: 'Search categories (e.g. ["general", "news", "images", "videos"])'
      },
      engines: {
        type: 'array',
        description: 'Specific search engines to use'
      },
      language: {
        type: 'string',
        description: 'Search language (e.g. "en", "de", "fr")'
      },
      instance: {
        type: 'string',
        description: 'SearXNG instance URL (if not using default)'
      }
    },
    required: ['query']
  }
};

export const searxngSearchHandler: ToolHandler = async (parameters: any, context?: ToolContext) => {
  const { query, numResults = 10, categories, engines, language, instance } = parameters;

  try {
    // Default SearXNG instance - in production, this should be configurable
    const baseUrl = instance || 'https://search.bus-hit.me';
    
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      pageno: '1'
    });

    if (categories && categories.length > 0) {
      params.append('categories', categories.join(','));
    }
    
    if (engines && engines.length > 0) {
      params.append('engines', engines.join(','));
    }
    
    if (language) {
      params.append('language', language);
    }

    const response = await fetch(`${baseUrl}/search?${params}`, {
      headers: {
        'User-Agent': 'Agentic-Loop/1.0'
      }
    });

    if (!response.ok) {
      return {
        success: false,
        error: `SearXNG search failed: ${response.status} ${response.statusText}`
      };
    }

    const data = await response.json() as any;
    
    if (!data.results) {
      return {
        success: false,
        error: 'No results found or invalid response format'
      };
    }

    const results = data.results.slice(0, numResults).map((result: any) => ({
      title: result.title,
      url: result.url,
      content: result.content,
      engine: result.engine,
      category: result.category
    }));

    return {
      success: true,
      result: `Found ${results.length} search results`,
      query,
      totalResults: data.number_of_results || results.length,
      results,
      instance: baseUrl
    };
  } catch (error: any) {
    return {
      success: false,
      error: `Failed to perform SearXNG search: ${error.message}`
    };
  }
};
