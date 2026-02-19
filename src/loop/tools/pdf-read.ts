import { promises as fs } from 'fs';
import { resolve } from 'path';
import { ToolDefinition, ToolHandler } from '../types.js';

export const pdfReadDefinition: ToolDefinition = {
  name: 'pdf_read',
  description: 'Extract text content from a PDF file. Returns the text content, number of pages, and metadata. Requires the pdf-parse package to be installed.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the PDF file (relative to working directory or absolute)',
        required: true
      },
      pages: {
        type: 'string',
        description: 'Page range to extract (e.g., "1-5", "1,3,5", "all"). Default: "all"',
        required: false,
        default: 'all'
      },
      maxLength: {
        type: 'number',
        description: 'Maximum characters to return (default: 100000). Use to limit output for large PDFs.',
        required: false,
        default: 100000
      }
    },
    required: ['path']
  },
  dangerous: false
};

interface PDFInfo {
  Title?: string;
  Author?: string;
  Subject?: string;
  Creator?: string;
  Producer?: string;
  CreationDate?: string;
  ModDate?: string;
  [key: string]: unknown;
}

/**
 * Parse a page range string into an array of page numbers (1-indexed)
 */
function parsePageRange(pageSpec: string, totalPages: number): number[] {
  if (pageSpec === 'all') {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const pages = new Set<number>();
  const parts = pageSpec.split(',');

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.includes('-')) {
      const [start, end] = trimmed.split('-').map(n => parseInt(n.trim(), 10));
      if (!isNaN(start) && !isNaN(end)) {
        for (let i = Math.max(1, start); i <= Math.min(end, totalPages); i++) {
          pages.add(i);
        }
      }
    } else {
      const page = parseInt(trimmed, 10);
      if (!isNaN(page) && page >= 1 && page <= totalPages) {
        pages.add(page);
      }
    }
  }

  return Array.from(pages).sort((a, b) => a - b);
}

export const pdfReadHandler: ToolHandler = async (params, context) => {
  const { path, pages = 'all', maxLength = 100000 } = params;

  if (!path) {
    throw new Error('path parameter is required');
  }

  if (typeof path !== 'string') {
    throw new Error('path must be a string');
  }

  const workingDirectory = context?.workingDirectory || process.cwd();
  const fullPath = resolve(workingDirectory, path as string);

  // Basic security check - prevent directory traversal outside working directory
  if (!fullPath.startsWith(resolve(workingDirectory))) {
    throw new Error('Access denied: path is outside working directory');
  }

  // Check if file exists and is a PDF
  try {
    await fs.access(fullPath);
  } catch {
    throw new Error(`File not found: ${path}`);
  }

  if (!fullPath.toLowerCase().endsWith('.pdf')) {
    throw new Error('File does not appear to be a PDF (expected .pdf extension)');
  }

  // Dynamically import pdf-parse to avoid requiring it as a hard dependency
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let PDFParse: any;
  try {
    const module = await import('pdf-parse');
    PDFParse = module.PDFParse;
    if (!PDFParse) {
      throw new Error('PDFParse class not found in module');
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('PDFParse class not found')) {
      throw error;
    }
    throw new Error(
      'pdf-parse package is not installed. Install it with: npm install pdf-parse\n' +
      'Note: pdf-parse requires Node.js and may need additional system dependencies.'
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parser: any = null;
  try {
    const dataBuffer = await fs.readFile(fullPath);
    
    parser = new PDFParse({});
    await parser.load(dataBuffer);
    
    // Get document info and page count
    const { info, numPages: totalPages } = await parser.getInfo() as { info: PDFInfo; numPages: number };
    const requestedPages = parsePageRange(String(pages), totalPages);
    
    // Get text content
    let text: string = await parser.getText();
    
    // If specific pages requested, note it (pdf-parse v2 getText() returns all pages)
    if (pages !== 'all' && requestedPages.length !== totalPages) {
      text = `[Note: Full document extracted. Page filtering (${pages}) requested but pdf-parse extracts all pages.]\n\n${text}`;
    }

    // Truncate if needed
    let truncated = false;
    if (text.length > maxLength) {
      text = text.substring(0, maxLength);
      truncated = true;
    }

    // Build metadata
    const metadata: Record<string, unknown> = {};
    if (info) {
      if (info.Title) metadata.title = info.Title;
      if (info.Author) metadata.author = info.Author;
      if (info.Subject) metadata.subject = info.Subject;
      if (info.Creator) metadata.creator = info.Creator;
      if (info.Producer) metadata.producer = info.Producer;
      if (info.CreationDate) metadata.creationDate = info.CreationDate;
      if (info.ModDate) metadata.modificationDate = info.ModDate;
    }

    // Format output as readable text
    let output = `# PDF Content: ${path}\n\n`;
    output += `**Pages:** ${totalPages}\n`;
    output += `**Characters:** ${text.length}${truncated ? ` (truncated from original, max: ${maxLength})` : ''}\n`;
    
    if (Object.keys(metadata).length > 0) {
      const metaItems: string[] = [];
      if (metadata.title) metaItems.push(`Title: ${metadata.title}`);
      if (metadata.author) metaItems.push(`Author: ${metadata.author}`);
      if (metadata.subject) metaItems.push(`Subject: ${metadata.subject}`);
      if (metaItems.length > 0) {
        output += `**Metadata:** ${metaItems.join(' | ')}\n`;
      }
    }
    
    output += `\n---\n\n${text}`;
    
    if (truncated) {
      output += `\n\n---\n[Content truncated at ${maxLength} characters. Use maxLength parameter to retrieve more.]`;
    }

    return output;
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('EACCES')) {
        throw new Error(`Permission denied: ${path}`);
      }
      throw new Error(`Failed to parse PDF: ${error.message}`);
    }
    throw new Error(`Failed to parse PDF: ${String(error)}`);
  } finally {
    // Clean up parser resources
    if (parser) {
      try {
        parser.destroy();
      } catch {
        // Ignore cleanup errors
      }
    }
  }
};
