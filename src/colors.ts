// Use require to get chalk directly (chalk v4 is CommonJS)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const chalk = require('chalk') as import('chalk').Chalk;

/**
 * Centralized color palette for Woodbury CLI
 * Uses a cohesive color scheme for better readability
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
  
  // Content colors
  user: chalk.hex('#60A5FA'),         // Light blue for user input
  assistant: chalk.hex('#34D399'),    // Light green for assistant
  system: chalk.hex('#A78BFA'),       // Light purple for system
  
  // Tool colors
  toolName: chalk.hex('#F472B6'),     // Pink - tool names
  toolParam: chalk.hex('#94A3B8'),    // Slate - parameters
  toolSuccess: chalk.hex('#10B981'),  // Green - successful tool
  toolError: chalk.hex('#F87171'),    // Light red - failed tool
  
  // Meta/decorative colors
  muted: chalk.hex('#6B7280'),        // Gray - muted text
  dim: chalk.hex('#4B5563'),          // Darker gray
  highlight: chalk.hex('#FBBF24'),    // Yellow - highlights
  
  // Text colors
  text: chalk.white,
  textMuted: chalk.hex('#9CA3AF'),
  textBright: chalk.whiteBright,
  
  // Border/divider colors
  border: chalk.hex('#374151'),
  borderLight: chalk.hex('#4B5563'),
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

export default { colors, icons, labels, format, box };
