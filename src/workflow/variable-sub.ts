/**
 * Variable Substitution Engine
 *
 * Replaces {{varName}} placeholders in workflow step fields with
 * runtime variable values. Supports nested path access (e.g., {{item.name}}).
 */

const VARIABLE_PATTERN = /\{\{([^}]+)\}\}/g;

/**
 * Resolve a dotted path like "item.name" or "items[0]" against a context object.
 */
function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Replace all {{varName}} occurrences in a string with values from the context.
 * Returns the original string if no variables are found.
 * If the entire string is a single variable reference and the value is not a string,
 * returns the raw value (preserving type for numbers, booleans, arrays, objects).
 */
export function substituteString(
  template: string,
  variables: Record<string, unknown>
): unknown {
  // Check if the entire string is exactly one variable reference
  const trimmed = template.trim();
  const singleMatch = trimmed.match(/^\{\{([^}]+)\}\}$/);
  if (singleMatch) {
    const value = resolvePath(variables, singleMatch[1].trim());
    if (value !== undefined) return value;
    // If variable not found, return the original template string
    return template;
  }

  // Multiple variables or mixed text — always returns string
  return template.replace(VARIABLE_PATTERN, (_match, varPath: string) => {
    const value = resolvePath(variables, varPath.trim());
    if (value === undefined) return _match; // Leave unresolved
    return String(value);
  });
}

/**
 * Recursively substitute variables in all string fields of an object.
 * Returns a deep copy with variables replaced.
 */
export function substituteObject<T>(
  obj: T,
  variables: Record<string, unknown>
): T {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    return substituteString(obj, variables) as T;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => substituteObject(item, variables)) as T;
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = substituteObject(value, variables);
    }
    return result as T;
  }

  // Primitives (number, boolean) pass through unchanged
  return obj;
}

/**
 * Check if a string contains any {{variable}} references.
 */
export function hasVariables(text: string): boolean {
  return VARIABLE_PATTERN.test(text);
}

/**
 * Extract all variable names referenced in a string.
 */
export function extractVariableNames(text: string): string[] {
  const names: string[] = [];
  let match;
  const pattern = new RegExp(VARIABLE_PATTERN.source, 'g');
  while ((match = pattern.exec(text)) !== null) {
    names.push(match[1].trim());
  }
  return names;
}
