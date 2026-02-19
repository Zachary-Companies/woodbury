// Use require to get chalk directly (chalk v4 is CommonJS)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const chalk = require('chalk') as import('chalk').Chalk;

/**
 * Detect whether the terminal has a light or dark background.
 *
 * Detection cascade:
 * 1. WOODBURY_THEME env var — explicit user override ("light" or "dark")
 * 2. COLORFGBG env var — format "fg;bg", bg >= 8 means light background
 * 3. TERM_PROGRAM heuristics — Apple_Terminal defaults to light
 * 4. Default to dark — most developer terminals are dark-themed
 */
function detectTerminalTheme(): 'light' | 'dark' {
  // 1. Explicit override
  const themeEnv = process.env.WOODBURY_THEME?.toLowerCase();
  if (themeEnv === 'light') return 'light';
  if (themeEnv === 'dark') return 'dark';

  // 2. COLORFGBG (set by some terminals like rxvt, Konsole)
  const colorfgbg = process.env.COLORFGBG;
  if (colorfgbg) {
    const parts = colorfgbg.split(';');
    const bg = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(bg)) {
      // In the standard 16-color palette:
      // 0-6 = dark colors, 7 = light gray, 8 = dark gray, 9-15 = bright/light colors
      // bg >= 8 is generally a light background (bright colors)
      // Exception: 8 is dark gray, so treat >= 9 as light, or 7 as light
      if (bg === 7 || bg >= 9) return 'light';
      return 'dark';
    }
  }

  // 3. TERM_PROGRAM heuristics
  const termProgram = process.env.TERM_PROGRAM;
  if (termProgram === 'Apple_Terminal') {
    // macOS Terminal.app defaults to a light profile
    return 'light';
  }

  // 4. Default to dark
  return 'dark';
}

/** The detected terminal theme */
export const terminalTheme: 'light' | 'dark' = detectTerminalTheme();
const isLight = terminalTheme === 'light';

/**
 * Centralized color palette for Woodbury CLI
 * Adapts to light and dark terminal backgrounds automatically.
 * Override with WOODBURY_THEME=light or WOODBURY_THEME=dark.
 */
export const colors = {
  // Primary colors for main content
  primary: chalk.hex('#7C3AED'),      // Purple - brand color
  secondary: chalk.hex('#06B6D4'),    // Cyan - secondary actions

  // Status colors
  success: chalk.hex('#10B981'),      // Emerald green
  error: chalk.hex('#EF4444'),        // Red
  warning: chalk.hex('#F59E0B'),      // Amber
  info: chalk.hex('#3B82F6'),         // Blue

  // Content colors — slightly darker variants on light backgrounds for contrast
  user: chalk.hex(isLight ? '#2563EB' : '#60A5FA'),         // Blue for user input
  assistant: chalk.hex(isLight ? '#059669' : '#34D399'),    // Green for assistant
  system: chalk.hex(isLight ? '#7C3AED' : '#A78BFA'),       // Purple for system

  // Tool colors
  toolName: chalk.hex(isLight ? '#DB2777' : '#F472B6'),     // Pink - tool names
  toolParam: chalk.hex(isLight ? '#64748B' : '#94A3B8'),    // Slate - parameters
  toolSuccess: chalk.hex('#10B981'),  // Green - successful tool
  toolError: chalk.hex('#F87171'),    // Light red - failed tool

  // Meta/decorative colors — inverted luminance for light backgrounds
  muted: chalk.hex(isLight ? '#4B5563' : '#6B7280'),        // Gray - muted text
  dim: chalk.hex(isLight ? '#9CA3AF' : '#4B5563'),          // Decorative gray
  highlight: chalk.hex('#FBBF24'),    // Yellow - highlights

  // Text colors — use chalk.visible (terminal default foreground) for dark theme
  // instead of chalk.white, which is unreadable on light backgrounds when theme
  // detection fails. chalk.visible passes through text without forcing a color
  // but still supports chaining (e.g., colors.text.bold).
  text: isLight ? chalk.hex('#1F2937') : chalk.visible,
  textMuted: chalk.hex(isLight ? '#6B7280' : '#9CA3AF'),
  textBright: isLight ? chalk.hex('#111827') : chalk.visible,

  // Border/divider colors
  border: chalk.hex(isLight ? '#D1D5DB' : '#374151'),
  borderLight: chalk.hex(isLight ? '#E5E7EB' : '#4B5563'),
};

/**
 * Theme-aware marked-terminal color configuration.
 * Used by both renderer.ts and repl.ts to configure markdown rendering.
 */
export const markdownTheme = {
  // Code blocks — no background color to avoid clashing with unknown terminal bg
  code: chalk.hex(isLight ? '#0369A1' : '#A5D6FF'),
  codespan: chalk.hex(isLight ? '#0369A1' : '#A5D6FF'),
  // Headings
  heading: chalk.hex(isLight ? '#6D28D9' : '#C4B5FD').bold,
  // Links
  href: chalk.hex(isLight ? '#2563EB' : '#60A5FA').underline,
  // Lists — use theme-aware text color (NOT chalk.white)
  listitem: colors.text,
  // Emphasis — use theme-aware text
  strong: colors.textBright.bold,
  em: chalk.italic,
  // Block quotes
  blockquote: chalk.hex(isLight ? '#6B7280' : '#9CA3AF').italic,
  // Horizontal rule
  hr: colors.dim,
};

/**
 * Icon set with consistent styling
 */
export const icons = {
  // Status icons
  success: colors.success('✓'),
  error: colors.error('✗'),
  warning: colors.warning('⚠'),
  info: colors.info('ℹ'),

  // Actor icons
  user: colors.user('▶'),
  assistant: colors.assistant('◆'),
  system: colors.system('●'),

  // Tool icons
  tool: colors.toolName('⚡'),
  toolRun: colors.toolName('▸'),
  toolDone: colors.toolSuccess('◼'),

  // Progress/status icons
  thinking: colors.muted('◌'),
  running: colors.secondary('◉'),
  complete: colors.success('◉'),
  failed: colors.error('◉'),

  // Misc icons
  arrow: colors.muted('→'),
  bullet: colors.muted('•'),
  divider: colors.dim('─'),
};

/**
 * Pre-styled labels for common use cases
 */
export const labels = {
  you: colors.user.bold('YOU'),
  woodbury: colors.assistant.bold('WOODBURY'),
  system: colors.system.bold('SYSTEM'),
  tool: colors.toolName.bold('TOOL'),
  error: colors.error.bold('ERROR'),
  warning: colors.warning.bold('WARNING'),
  info: colors.info.bold('INFO'),
  debug: colors.muted.bold('DEBUG'),
  stats: colors.muted('STATS'),
};

/**
 * Format helpers for common patterns
 */
export const format = {
  // Format a header with prefix
  header: (icon: string, label: string) => `${icon}  ${label}`,

  // Format key-value pairs
  keyValue: (key: string, value: string) =>
    `${colors.textMuted(key + ':')} ${colors.text(value)}`,

  // Format a stat item
  stat: (label: string, value: string | number) =>
    `${colors.muted(label)} ${colors.secondary(String(value))}`,

  // Format duration
  duration: (ms: number) => {
    if (ms < 1000) return colors.secondary(`${ms}ms`);
    return colors.secondary(`${(ms / 1000).toFixed(1)}s`);
  },

  // Format count
  count: (n: number, singular: string, plural?: string) => {
    const word = n === 1 ? singular : (plural || singular + 's');
    return `${colors.secondary(String(n))} ${colors.muted(word)}`;
  },

  // Create a horizontal divider
  divider: (width: number = 60, char: string = '─') =>
    colors.dim(char.repeat(width)),

  // Format code/technical content
  code: (text: string) => colors.secondary(text),

  // Format a path
  path: (p: string) => colors.secondary.underline(p),

  // Format JSON for display
  json: (obj: any, indent: number = 2) =>
    colors.muted(JSON.stringify(obj, null, indent)),
};

/**
 * Box drawing helpers for framed content
 */
export const box = {
  topLeft: colors.border('╭'),
  topRight: colors.border('╮'),
  bottomLeft: colors.border('╰'),
  bottomRight: colors.border('╯'),
  horizontal: colors.border('─'),
  vertical: colors.border('│'),

  // Create a simple box around text
  wrap: (content: string, width: number = 60) => {
    const lines = content.split('\n');
    const maxLen = Math.max(...lines.map(l => l.length), width);
    const top = `╭${'─'.repeat(maxLen + 2)}╮`;
    const bottom = `╰${'─'.repeat(maxLen + 2)}╯`;
    const body = lines.map(l => `│ ${l.padEnd(maxLen)} │`).join('\n');
    return colors.border(`${top}\n${body}\n${bottom}`);
  },
};

export default { colors, icons, labels, format, box, terminalTheme, markdownTheme };
