/**
 * Convert a glob pattern to a RegExp.
 *
 * Supported syntax:
 *   *    → matches any characters except path separators
 *   **   → matches any characters including path separators (recursive)
 *   ?    → matches a single non-separator character
 *   [ab] → character class (passed through)
 *   {a,b}→ alternation
 *
 * All other regex-special characters are escaped.
 */
export function globToRegex(glob: string): RegExp {
  let regex = '';
  let i = 0;

  while (i < glob.length) {
    const ch = glob[i];

    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // ** matches everything including /
        regex += '.*';
        i += 2;
        // skip trailing slash after **
        if (glob[i] === '/' || glob[i] === '\\') {
          i++;
        }
      } else {
        // * matches everything except /
        regex += '[^/\\\\]*';
        i++;
      }
    } else if (ch === '?') {
      regex += '[^/\\\\]';
      i++;
    } else if (ch === '[') {
      // Pass character class through
      const close = glob.indexOf(']', i + 1);
      if (close === -1) {
        regex += '\\[';
        i++;
      } else {
        regex += glob.slice(i, close + 1);
        i = close + 1;
      }
    } else if (ch === '{') {
      // Convert {a,b} to (a|b)
      const close = glob.indexOf('}', i + 1);
      if (close === -1) {
        regex += '\\{';
        i++;
      } else {
        const inner = glob.slice(i + 1, close).split(',').join('|');
        regex += `(${inner})`;
        i = close + 1;
      }
    } else if (ch === '/' || ch === '\\') {
      regex += '[/\\\\]';
      i++;
    } else if ('.+^$|()'.includes(ch)) {
      regex += '\\' + ch;
      i++;
    } else {
      regex += ch;
      i++;
    }
  }

  return new RegExp(`^${regex}$`, 'i');
}
