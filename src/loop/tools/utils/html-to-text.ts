import * as cheerio from 'cheerio';

export const NOISE_SELECTORS =
  'script, style, noscript, iframe, svg, nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]';

/**
 * Recursively convert a cheerio node tree to markdown-like text.
 */
export function htmlToText(
  $: cheerio.CheerioAPI,
  $root: ReturnType<cheerio.CheerioAPI>,
  baseUrl: string
): string {
  const output: string[] = [];

  function walk(nodes: ReturnType<cheerio.CheerioAPI>): void {
    nodes.contents().each((_i, node) => {
      if (node.type === 'text') {
        const text = $(node).text().replace(/\s+/g, ' ');
        output.push(text);
        return;
      }

      if (node.type !== 'tag') return;

      const tagName = (node as any).tagName?.toLowerCase();
      const $el = $(node);

      switch (tagName) {
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6': {
          const level = parseInt(tagName[1], 10);
          const prefix = '#'.repeat(level);
          output.push(`\n\n${prefix} `);
          walk($el);
          output.push('\n\n');
          break;
        }

        case 'p':
        case 'div':
        case 'section':
        case 'article':
        case 'blockquote':
          output.push('\n\n');
          walk($el);
          output.push('\n\n');
          break;

        case 'br':
          output.push('\n');
          break;

        case 'hr':
          output.push('\n\n---\n\n');
          break;

        case 'tr':
          output.push('\n');
          walk($el);
          break;

        case 'a': {
          const href = $el.attr('href');
          const linkText: string[] = [];
          // Collect inner text without recursing into output
          $el.contents().each((_j, child) => {
            if (child.type === 'text') {
              linkText.push($(child).text());
            } else if (child.type === 'tag') {
              linkText.push($(child).text());
            }
          });
          const text = linkText.join('').replace(/\s+/g, ' ').trim();
          if (href && text && !href.startsWith('javascript:') && !href.startsWith('mailto:')) {
            let absoluteUrl: string;
            try {
              absoluteUrl = new URL(href, baseUrl).href;
            } catch {
              output.push(text);
              break;
            }
            output.push(`[${text}](${absoluteUrl})`);
          } else {
            output.push(text);
          }
          break;
        }

        case 'img': {
          const alt = $el.attr('alt')?.trim();
          const src = $el.attr('src');
          if (alt && src) {
            let absoluteSrc: string;
            try {
              absoluteSrc = new URL(src, baseUrl).href;
            } catch {
              break;
            }
            output.push(`![${alt}](${absoluteSrc})`);
          }
          break;
        }

        case 'strong':
        case 'b':
          output.push('**');
          walk($el);
          output.push('**');
          break;

        case 'em':
        case 'i':
          output.push('*');
          walk($el);
          output.push('*');
          break;

        case 'code':
          // Check if inside a pre — if so, skip the backtick wrapping
          if ($el.parent().is('pre')) {
            walk($el);
          } else {
            output.push('`');
            walk($el);
            output.push('`');
          }
          break;

        case 'pre': {
          output.push('\n\n```\n');
          // Get raw text content of pre
          const preText = $el.text();
          output.push(preText);
          output.push('\n```\n\n');
          break;
        }

        case 'ul':
        case 'ol':
          output.push('\n');
          $el.children('li').each((idx, li) => {
            const prefix = tagName === 'ol' ? `${idx + 1}. ` : '- ';
            output.push(prefix);
            walk($(li));
            output.push('\n');
          });
          output.push('\n');
          break;

        case 'li':
          // Handled by ul/ol parent
          walk($el);
          break;

        default:
          walk($el);
          break;
      }
    });
  }

  walk($root);
  return output.join('');
}

/**
 * Truncate text at the nearest word boundary before maxLength.
 */
export function truncateAtWordBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  const truncated = text.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLength * 0.8) {
    return truncated.slice(0, lastSpace) + '...';
  }
  return truncated + '...';
}
