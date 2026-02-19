import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';
import * as cheerio from 'cheerio';
import { htmlToText, NOISE_SELECTORS } from './utils/html-to-text.js';

export const webCrawlDefinition: ToolDefinition = {
  name: 'web_crawl',
  description: 'Crawl a web page: fetches HTML, converts it to clean readable text with markdown formatting, and extracts all links. Useful for reading page content and discovering links to follow for deeper research.',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL to crawl (must start with http:// or https://)'
      },
      selector: {
        type: 'string',
        description: 'CSS selector to focus on a specific content area (e.g. "main", "article", "#content")'
      },
      includeLinks: {
        type: 'boolean',
        description: 'Whether to append a "Links found on page" section (default: true)',
        default: true
      },
      maxContentLength: {
        type: 'number',
        description: 'Maximum text content characters before truncation (default: 50000)',
        default: 50000
      }
    },
    required: ['url']
  }
};

export const webCrawlHandler: ToolHandler = async (params: any, context?: ToolContext) => {
  const url = params.url as string;
  const selector = params.selector as string | undefined;
  const includeLinks = params.includeLinks !== false; // default to true
  const maxContentLength = (params.maxContentLength as number) || 50000;
  
  if (!url) {
    throw new Error('url parameter is required');
  }
  
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error('URL must start with http:// or https://');
  }
  
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Agentic-Loop/1.0'
      }
    });

    const contentType = response.headers.get('content-type') || '';
    const isHtml = contentType.includes('text/html');
    const rawText = await response.text();

    if (!isHtml) {
        return `Content type: ${contentType} (not HTML)\n\n${rawText}`;
    }
    
    let statusInfo = '';
    if (response.status < 200 || response.status >= 300) {
      statusInfo = `Status: ${response.status} ${response.statusText}\n\n`;
    }
    
    const html = rawText;
    const $ = cheerio.load(html);
    
    // Remove unwanted elements
    $(NOISE_SELECTORS).remove();
    $('.advertisement, .ads').remove();
    
    // Focus on specific content area if selector provided
    let contentElement = selector ? $(selector) : $('body');
    if (selector && contentElement.length === 0) {
      contentElement = $('body'); // Fallback to body if selector not found
    }
    
    // Extract title
    const title = $('title').text().trim();
    let content = '';
    
    if (title) {
      content += `# ${title}\n\n`;
    }

    if (statusInfo) {
      content += statusInfo;
    }
    
    // Extract text content with basic markdown formatting
    content += htmlToText($, contentElement, url);
    
    // Clean up content
    content = content
      .replace(/\n{3,}/g, '\n\n') // Remove excessive newlines
      .replace(/^\n+/, '') // Remove leading newlines
      .trim();
    
    // Truncate if too long
    if (content.length > maxContentLength) {
      content = content.substring(0, maxContentLength) + `\n\n[Content truncated at ${maxContentLength} characters...]`;
    }
    
    // Extract links if requested
    let links: {text: string, url: string}[] = [];
    if (includeLinks) {
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        const text = $(el).text().trim();
        if (href && text && href !== '#') {
          // Filter out javascript: and mailto: links
          if (href.startsWith('javascript:') || href.startsWith('mailto:')) {
            return;
          }

          let absoluteUrl = href;
          if (href.startsWith('/')) {
            const urlObj = new URL(url);
            absoluteUrl = urlObj.origin + href;
          } else if (!href.startsWith('http')) {
            try {
              absoluteUrl = new URL(href, url).href;
            } catch {
              // Skip invalid URLs
              return;
            }
          }
          links.push({ text, url: absoluteUrl });
        }
      });

      // Deduplicate links based on URL
      const uniqueLinks = new Map();
      links.forEach(link => {
        if (!uniqueLinks.has(link.url)) {
            uniqueLinks.set(link.url, link);
        }
      });
      links = Array.from(uniqueLinks.values());
    }
    
    // Format final result
    let result = content;
    if (includeLinks && links.length > 0) {
      result += '\n\n## Links found on page\n\n';
      links.forEach(link => {
        result += `- [${link.text}](${link.url})\n`;
      });
    }
    
    return result;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to crawl page: ${error.message}`);
    }
    throw new Error(`Failed to crawl page: ${String(error)}`);
  }
};
