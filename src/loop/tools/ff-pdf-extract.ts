import { resolve } from 'path';
import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const ffPdfExtractDefinition: ToolDefinition = {
  name: 'pdf_extract',
  description: 'Extract text, images, and page renders from a PDF file. Returns structured text by page, with optional image extraction and page rendering to PNG. Much more capable than basic PDF reading — handles protected PDFs, embedded images, and high-quality page renders.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the PDF file (relative to working directory or absolute)'
      },
      outDir: {
        type: 'string',
        description: 'Output directory for extracted images and rendered pages. Defaults to a temp directory next to the PDF.'
      },
      extractText: {
        type: 'boolean',
        description: 'Extract text from each page (default: true)',
        default: true
      },
      extractImages: {
        type: 'boolean',
        description: 'Extract embedded images from the PDF (default: false)',
        default: false
      },
      renderPages: {
        type: 'boolean',
        description: 'Render each page as a PNG image (default: false)',
        default: false
      },
      pageRenderScale: {
        type: 'number',
        description: 'Scale factor for page rendering (default: 2 for high quality)',
        default: 2
      },
      password: {
        type: 'string',
        description: 'Password for protected PDFs'
      }
    },
    required: ['path']
  }
};

export const ffPdfExtractHandler: ToolHandler = async (params: any, context?: ToolContext) => {
  const path = params.path as string;

  if (!path) {
    throw new Error('path parameter is required');
  }

  const workingDirectory = context?.workingDirectory || process.cwd();
  const fullPath = resolve(workingDirectory, path);

  // Security check
  if (!fullPath.startsWith(resolve(workingDirectory))) {
    throw new Error('Access denied: path is outside working directory');
  }

  let extractPdf: any;
  try {
    const mod = await import('flow-frame-core/dist/services/extractPdf.js');
    extractPdf = mod.extractPdf || mod.default;
  } catch (err: any) {
    throw new Error(`Failed to load flow-frame-core PDF module: ${err.message}`);
  }

  const outDir = params.outDir
    ? resolve(workingDirectory, params.outDir)
    : resolve(workingDirectory, '.woodbury-pdf-output');

  try {
    const result = await extractPdf({
      pdfPath: fullPath,
      outDir,
      extractText: params.extractText !== false,
      extractImages: params.extractImages === true,
      renderPages: params.renderPages === true,
      pageRenderScale: params.pageRenderScale || 2,
      password: params.password
    });

    // Format result for LLM
    const lines: string[] = [];
    lines.push(`# PDF Extraction: ${path}`);
    lines.push(`- Pages: ${result.numPages}`);
    lines.push(`- Output directory: ${outDir}`);
    lines.push('');

    // Text by page
    if (result.textByPage && Object.keys(result.textByPage).length > 0) {
      lines.push('## Text Content');
      for (const [pageNum, text] of Object.entries(result.textByPage)) {
        lines.push(`\n### Page ${pageNum}`);
        const pageText = String(text);
        if (pageText.length > 5000) {
          lines.push(pageText.substring(0, 5000) + '\n[Page text truncated at 5000 chars...]');
        } else {
          lines.push(pageText);
        }
      }
    }

    // Images
    if (result.images && result.images.length > 0) {
      lines.push('\n## Extracted Images');
      result.images.forEach((img: string, i: number) => {
        lines.push(`- Image ${i + 1}: ${img}`);
      });
    }

    // Rendered pages
    if (result.renderedPages && result.renderedPages.length > 0) {
      lines.push('\n## Rendered Pages');
      result.renderedPages.forEach((page: string, i: number) => {
        lines.push(`- Page ${i + 1}: ${page}`);
      });
    }

    let output = lines.join('\n');
    if (output.length > 100000) {
      output = output.substring(0, 100000) + '\n\n[Output truncated at 100k chars...]';
    }
    return output;
  } catch (err: any) {
    throw new Error(`PDF extraction failed: ${err.message}`);
  }
};
