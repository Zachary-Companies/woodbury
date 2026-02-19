import puppeteer from 'puppeteer';
import * as cheerio from 'cheerio';
import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';
import { htmlToText, truncateAtWordBoundary, NOISE_SELECTORS } from './utils/html-to-text.js';

const DEFAULT_MAX_CONTENT_LENGTH = 50000;
const DEFAULT_TIMEOUT_MS = 30000;

export const webCrawlRenderedDefinition: ToolDefinition = {
  name: 'web_crawl_rendered',
  description:
    'Crawl a web page using a headless browser to render JavaScript-heavy content (SPAs, client-side rendered pages). Extracts clean readable text with markdown formatting and all links — same output format as web_crawl but for pages that require JavaScript execution.',
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
      waitForSelector: {
        type: 'string',
        description: 'CSS selector to wait for before extracting content (e.g. "#app", ".content-loaded")'
      },
      includeLinks: {
        type: 'boolean',
        description: 'Whether to append a "Links found on page" section (default: true)',
        default: true
      },
      maxContentLength: {
        type: 'number',
        description: 'Maximum text content characters before truncation (default: 50000)',
        default: DEFAULT_MAX_CONTENT_LENGTH
      }
    },
    required: ['url']
  }
};

export const webCrawlRenderedHandler: ToolHandler = async (params: any, context?: ToolContext) => {
  const url = params.url as string;
  const selector = params.selector as string | undefined;
  const waitForSelector = params.waitForSelector as string | undefined;
  const includeLinks = params.includeLinks !== false;
  const maxContentLength = (params.maxContentLength as number) || DEFAULT_MAX_CONTENT_LENGTH;

  if (!url) {
    throw new Error('url parameter is required');
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error('url must start with http:// or https://');
  }

  const timeout = context?.toolTimeout || DEFAULT_TIMEOUT_MS;

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.goto(url, { waitUntil: 'networkidle2', timeout });

    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout });
    }

    const renderedHtml = await page.content();
    const title = await page.title();

    // Close browser as soon as we have the content
    await browser.close();
    browser = null;

    // Process rendered HTML with cheerio — same pipeline as web_crawl
    const $ = cheerio.load(renderedHtml);

    const pageTitle = title?.trim() || $('title').first().text().trim() || 'Untitled';

    // Determine content scope
    const selectorToUse = selector || 'body';
    let $scope = $(selectorToUse);
    if ($scope.length === 0) {
      $scope = $('body');
    }

    // Strip noise elements if the function exists
    if (typeof NOISE_SELECTORS === 'string') {
      $scope.find(NOISE_SELECTORS).remove();
    }

    // Extract links before converting to text
    const links: { text: string; href: string }[] = [];
    if (includeLinks) {
      $scope.find('a').each((_i, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        if (href === '#' || href.startsWith('javascript:') || href.startsWith('mailto:')) return;

        let absoluteUrl: string;
        try {
          absoluteUrl = new URL(href, url).href;
        } catch {
          return;
        }

        const anchorText = $(el).text().trim();
        if (!anchorText) return;

        // Deduplicate by URL
        if (!links.some((l) => l.href === absoluteUrl)) {
          links.push({ text: anchorText, href: absoluteUrl });
        }
      });
    }

    // Convert HTML to markdown-like text
    let textContent: string;
    if (typeof htmlToText === 'function') {
      textContent = htmlToText($, $scope, url);
    } else {
      // Fallback to simple text extraction
      textContent = $scope.text().replace(/\s+/g, ' ').trim();
    }

    // Collapse 3+ consecutive blank lines to 2
    textContent = textContent.replace(/\n{3,}/g, '\n\n');
    textContent = textContent.trim();

    // Truncate if needed
    let truncated = false;
    if (textContent.length > maxContentLength) {
      if (typeof truncateAtWordBoundary === 'function') {
        textContent = truncateAtWordBoundary(textContent, maxContentLength);
      } else {
        textContent = textContent.substring(0, maxContentLength) + '...';
      }
      truncated = true;
    }

    // Assemble output
    const parts: string[] = [
      `# ${pageTitle}`,
      `Source: ${url}`,
      `Rendered: Yes`,
      '',
      textContent,
    ];

    if (truncated) {
      parts.push(`\n(Content truncated at ${maxContentLength} characters)`);
    }

    if (includeLinks && links.length > 0) {
      parts.push('', '---', '', `## Links found on page (${links.length} links)`, '');
      links.forEach((link, i) => {
        parts.push(`${i + 1}. [${link.text}](${link.href})`);
      });
    }

    return parts.join('\n');
  } finally {
    if (browser) {
      await browser.close();
    }
  }
};
