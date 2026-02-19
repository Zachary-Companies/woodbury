declare module 'marked-terminal' {
  import type { MarkedExtension } from 'marked';
  export function markedTerminal(options?: Record<string, unknown>, highlightOptions?: Record<string, unknown>): MarkedExtension;
  const TerminalRenderer: new (options?: Record<string, unknown>, highlightOptions?: Record<string, unknown>) => any;
  export default TerminalRenderer;
}
