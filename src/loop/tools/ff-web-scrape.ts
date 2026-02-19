import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const ffWebScrapeDefinition: ToolDefinition = {
  name: 'web_scrape',
  description: 'Crawl an entire website starting from a URL, staying on the same hostname. Returns the text content of every page found. Useful for scraping documentation sites, wikis, or any multi-page website into plain text.',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Starting URL to crawl (must start with http:// or https://)'
      },
      maxPages: {
        type: 'number',
        description: 'Maximum number of pages to crawl (default: 20)',
        default: 20
      }
    },
    required: ['url']
  }
};

export const ffWebScrapeHandler: ToolHandler = async (params: any, context?: ToolContext) => {
  const url = params.url as string;
  const maxPages = (params.maxPages as number) || 20;

  if (!url) {
    throw new Error('url parameter is required');
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error('URL must start with http:// or https://');
  }

  let crawl: any;
  try {
    const mod = await import('flow-frame-core/dist/scraper.js');
    crawl = mod.crawl || mod.default;
  } catch (err: any) {
    throw new Error(`Failed to load flow-frame-core scraper module: ${err.message}`);
  }

  try {
    const pages: Record<string, string> = await crawl(url);
    const urls = Object.keys(pages);

    // Limit to maxPages
    const limitedUrls = urls.slice(0, maxPages);

    const lines: string[] = [];
    lines.push(`# Web Scrape: ${url}`);
    lines.push(`- Pages found: ${urls.length}`);
    if (urls.length > maxPages) {
      lines.push(`- Showing first ${maxPages} pages (limit reached)`);
    }
    lines.push('');

    let totalLength = lines.join('\n').length;
    const MAX_OUTPUT = 100000;
    const MAX_PAGE = 5000;

    for (const pageUrl of limitedUrls) {
      const pageText = pages[pageUrl] || '';
      const header = `\n## ${pageUrl}\n`;

      if (totalLength + header.length > MAX_OUTPUT) {
        lines.push(`\n[Output truncated — ${limitedUrls.length - lines.length} more pages not shown]`);
        break;
      }

      lines.push(header);

      let content = pageText;
      if (content.length > MAX_PAGE) {
        content = content.substring(0, MAX_PAGE) + '\n[Page truncated at 5000 chars...]';
      }

      if (totalLength + header.length + content.length > MAX_OUTPUT) {
        lines.push('[Page content truncated due to total output limit]');
        break;
      }

      lines.push(content);
      totalLength += header.length + content.length;
    }

    return lines.join('\n');
  } catch (err: any) {
    throw new Error(`Web scraping failed: ${err.message}`);
  }
};
