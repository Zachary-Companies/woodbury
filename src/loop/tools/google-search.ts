import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

interface GoogleSearchResult {
  title: string;
  link: string;
  snippet: string;
  displayLink: string;
}

interface GoogleSearchResponse {
  items?: GoogleSearchResult[];
  searchInformation?: {
    totalResults: string;
    searchTime: string;
  };
  error?: {
    message: string;
  };
}

export const googleSearchDefinition: ToolDefinition = {
  name: 'google_search',
  description: 'Search the web using Google Custom Search. Returns titles, snippets, and links for matching results.',
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
        description: 'Number of results to return (1-10, default: 5)',
        default: 5
      },
      siteSearch: {
        type: 'string',
        description: 'Restrict results to a specific site (e.g. "developer.mozilla.org")'
      }
    },
    required: ['query']
  }
};

export const googleSearchHandler: ToolHandler = async (params: any, context?: ToolContext) => {
  const query = params.query as string;
  const numResults = Math.max(1, Math.min((params.numResults as number) || 5, 10));
  const siteSearch = params.siteSearch as string | undefined;
  
  if (!query) {
    throw new Error('query parameter is required');
  }
  
  const apiKey = process.env.GOOGLE_API_KEY;
  const searchEngineId = process.env.GOOGLE_SEARCH_ENGINE_ID;
  
  if (!apiKey || !searchEngineId) {
    throw new Error(
      'Google API credentials not configured. Set GOOGLE_API_KEY and GOOGLE_SEARCH_ENGINE_ID environment variables.'
    );
  }
  
  try {
    const params = new URLSearchParams({
      key: apiKey,
      cx: searchEngineId,
      q: query,
      num: numResults.toString()
    });
    
    if (siteSearch) {
      params.append('siteSearch', siteSearch);
    }
    
    const response = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);
    
    if (!response.ok) {
      throw new Error(`Google Search API error: ${response.status} ${response.statusText}`);
    }
    
    const data: GoogleSearchResponse = await response.json() as unknown as GoogleSearchResponse;
    
    if (data.error) {
      throw new Error(`Google Search API error: ${data.error.message}`);
    }
    
    const results = (data.items || []).map(item => ({
      title: item.title,
      link: item.link,
      snippet: item.snippet,
      displayLink: item.displayLink
    }));
    
    if (results.length === 0) {
      return `No results found for query: ${query}`;
    }
    
    const output = [
      `Google Search Results for: ${query}`,
      `Found ${data.searchInformation?.totalResults || 'unknown'} results (${data.searchInformation?.searchTime || 'unknown'}s)`,
      `Showing top ${results.length} results:`,
      ''
    ];
    
    results.forEach((result, i) => {
      output.push(`${i + 1}. **${result.title}**`);
      output.push(`   ${result.link}`);
      output.push(`   ${result.snippet}`);
      output.push('');
    });
    
    return output.join('\n');
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to perform Google search: ${error.message}`);
    }
    throw new Error(`Failed to perform Google search: ${String(error)}`);
  }
};
