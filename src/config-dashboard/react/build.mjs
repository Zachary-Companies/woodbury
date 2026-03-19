#!/usr/bin/env node
/**
 * Build React components for the Woodbury dashboard.
 * Bundles JSX/TSX into a single JS file that can be loaded via <script>.
 * React and ReactDOM are loaded from CDN, so they're externalized.
 */
import { build } from 'esbuild';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(__dirname, 'index.tsx')],
  bundle: true,
  outfile: join(__dirname, '..', 'react-app.js'),
  format: 'iife',
  globalName: 'WoodburyReact',
  platform: 'browser',
  target: ['es2020'],
  jsx: 'automatic',
  jsxImportSource: 'react',
  external: [],  // Bundle everything including React
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  minify: false,  // Keep readable for debugging
  sourcemap: 'inline',
  loader: {
    '.tsx': 'tsx',
    '.ts': 'ts',
    '.jsx': 'jsx',
  },
});

console.log('✓ React dashboard bundle built → react-app.js');
