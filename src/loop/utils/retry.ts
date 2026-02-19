/**
 * Retry utility with exponential backoff
 */

/**
 * Retry configuration
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries: number;
  /** Base delay between retries in ms (default: 1000) */
  baseDelayMs: number;
  /** Maximum delay between retries in ms (default: 30000) */
  maxDelayMs: number;
}

/** Default retry configuration */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

/**
 * Determine if an error is retryable (rate limits, server errors, network errors)
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();

  // Rate limit errors (HTTP 429)
  if (message.includes('429') || message.includes('rate limit') || message.includes('too many requests')) {
    return true;
  }

  // Server errors (5xx)
  if (/\b5\d{2}\b/.test(message) || message.includes('internal server error') || message.includes('server error')) {
    return true;
  }

  // Network errors
  const networkErrors = ['econnreset', 'etimedout', 'econnrefused', 'enotfound', 'epipe', 'socket hang up', 'network error', 'fetch failed'];
  if (networkErrors.some(e => message.includes(e))) {
    return true;
  }

  // Overloaded API
  if (message.includes('overloaded') || message.includes('capacity')) {
    return true;
  }

  return false;
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateDelay(attempt: number, config: RetryConfig): number {
  const exponentialDelay = config.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * config.baseDelayMs;
  return Math.min(exponentialDelay + jitter, config.maxDelayMs);
}

/**
 * Retry an async operation with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  onRetry?: (error: Error, attempt: number, delayMs: number) => void
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt >= config.maxRetries || !isRetryableError(error)) {
        throw lastError;
      }

      const delayMs = calculateDelay(attempt, config);
      if (onRetry) {
        onRetry(lastError, attempt + 1, delayMs);
      }

      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  // Should not reach here, but TypeScript needs this
  throw lastError;
}
