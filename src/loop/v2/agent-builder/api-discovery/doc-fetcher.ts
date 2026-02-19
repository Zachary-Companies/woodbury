/**
 * API Documentation Fetcher
 * Fetches and caches API documentation from various sources
 */

import * as https from 'https'
import * as http from 'http'

/**
 * Fetched documentation result
 */
export interface FetchedDoc {
  /** Original URL */
  url: string

  /** Raw content */
  content: string

  /** Detected content type */
  contentType: DocContentType

  /** HTTP status code */
  statusCode: number

  /** Response headers */
  headers: Record<string, string>

  /** Fetch timestamp */
  fetchedAt: number

  /** Content hash for caching */
  contentHash: string
}

export type DocContentType =
  | 'openapi-json'
  | 'openapi-yaml'
  | 'swagger-json'
  | 'swagger-yaml'
  | 'graphql-schema'
  | 'html'
  | 'markdown'
  | 'text'
  | 'unknown'

/**
 * Fetch options
 */
export interface FetchOptions {
  /** Request timeout in ms */
  timeoutMs?: number

  /** Custom headers */
  headers?: Record<string, string>

  /** Whether to follow redirects */
  followRedirects?: boolean

  /** Maximum redirects to follow */
  maxRedirects?: number

  /** User agent string */
  userAgent?: string
}

/**
 * Document cache entry
 */
interface CacheEntry {
  doc: FetchedDoc
  expiresAt: number
}

/**
 * Simple in-memory cache for fetched documents
 */
class DocCache {
  private cache = new Map<string, CacheEntry>()
  private readonly defaultTTL = 3600000 // 1 hour

  get(url: string): FetchedDoc | undefined {
    const entry = this.cache.get(url)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(url)
      return undefined
    }
    return entry.doc
  }

  set(url: string, doc: FetchedDoc, ttlMs?: number): void {
    this.cache.set(url, {
      doc,
      expiresAt: Date.now() + (ttlMs || this.defaultTTL)
    })
  }

  clear(): void {
    this.cache.clear()
  }

  has(url: string): boolean {
    return this.get(url) !== undefined
  }
}

const cache = new DocCache()

/**
 * Fetch API documentation from a URL
 */
export async function fetchDoc(
  url: string,
  options: FetchOptions = {}
): Promise<FetchedDoc> {
  // Check cache first
  const cached = cache.get(url)
  if (cached) {
    return cached
  }

  const {
    timeoutMs = 30000,
    headers = {},
    followRedirects = true,
    maxRedirects = 5,
    userAgent = 'AgentBuilder/1.0'
  } = options

  const fetchedDoc = await fetchWithRedirects(url, {
    timeoutMs,
    headers: {
      'User-Agent': userAgent,
      'Accept': 'application/json, application/yaml, text/yaml, text/html, text/markdown, */*',
      ...headers
    },
    followRedirects,
    maxRedirects
  })

  // Cache the result
  cache.set(url, fetchedDoc)

  return fetchedDoc
}

/**
 * Fetch with redirect handling
 */
async function fetchWithRedirects(
  url: string,
  options: FetchOptions & { redirectCount?: number }
): Promise<FetchedDoc> {
  const { redirectCount = 0, maxRedirects = 5, followRedirects = true } = options

  if (redirectCount > maxRedirects) {
    throw new Error(`Too many redirects (max: ${maxRedirects})`)
  }

  const result = await doFetch(url, options)

  // Handle redirects
  if (followRedirects && [301, 302, 303, 307, 308].includes(result.statusCode)) {
    const location = result.headers['location']
    if (location) {
      const redirectUrl = new URL(location, url).toString()
      return fetchWithRedirects(redirectUrl, {
        ...options,
        redirectCount: redirectCount + 1
      })
    }
  }

  return result
}

/**
 * Perform the actual HTTP fetch
 */
function doFetch(url: string, options: FetchOptions): Promise<FetchedDoc> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url)
    const isHttps = parsedUrl.protocol === 'https:'
    const httpModule = isHttps ? https : http

    const requestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: options.headers || {},
      timeout: options.timeoutMs || 30000
    }

    const req = httpModule.request(requestOptions, (res) => {
      const chunks: Buffer[] = []

      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
      })

      res.on('end', () => {
        const content = Buffer.concat(chunks).toString('utf-8')
        const headers: Record<string, string> = {}

        // Convert headers to plain object
        for (const [key, value] of Object.entries(res.headers)) {
          if (typeof value === 'string') {
            headers[key.toLowerCase()] = value
          } else if (Array.isArray(value)) {
            headers[key.toLowerCase()] = value.join(', ')
          }
        }

        const contentType = detectContentType(content, headers['content-type'] || '')

        resolve({
          url,
          content,
          contentType,
          statusCode: res.statusCode || 0,
          headers,
          fetchedAt: Date.now(),
          contentHash: simpleHash(content)
        })
      })

      res.on('error', reject)
    })

    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`Request timeout after ${options.timeoutMs}ms`))
    })

    req.end()
  })
}

/**
 * Detect the content type of the fetched document
 */
export function detectContentType(content: string, contentTypeHeader: string): DocContentType {
  const headerLower = contentTypeHeader.toLowerCase()
  const contentTrimmed = content.trim()

  // Check content-type header first
  if (headerLower.includes('application/json') || headerLower.includes('application/openapi+json')) {
    if (isOpenApiJson(contentTrimmed)) return 'openapi-json'
    if (isSwaggerJson(contentTrimmed)) return 'swagger-json'
    return 'openapi-json' // Assume OpenAPI for JSON
  }

  if (headerLower.includes('application/yaml') ||
      headerLower.includes('text/yaml') ||
      headerLower.includes('application/x-yaml')) {
    if (isOpenApiYaml(contentTrimmed)) return 'openapi-yaml'
    if (isSwaggerYaml(contentTrimmed)) return 'swagger-yaml'
    return 'openapi-yaml' // Assume OpenAPI for YAML
  }

  if (headerLower.includes('application/graphql')) {
    return 'graphql-schema'
  }

  if (headerLower.includes('text/html')) {
    return 'html'
  }

  if (headerLower.includes('text/markdown')) {
    return 'markdown'
  }

  // Content-based detection
  if (contentTrimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(contentTrimmed)
      if (parsed.openapi) return 'openapi-json'
      if (parsed.swagger) return 'swagger-json'
      return 'openapi-json' // Default JSON to OpenAPI
    } catch {
      // Not valid JSON
    }
  }

  if (contentTrimmed.startsWith('openapi:') || contentTrimmed.includes('\nopenapi:')) {
    return 'openapi-yaml'
  }

  if (contentTrimmed.startsWith('swagger:') || contentTrimmed.includes('\nswagger:')) {
    return 'swagger-yaml'
  }

  if (contentTrimmed.includes('type Query') || contentTrimmed.includes('type Mutation')) {
    return 'graphql-schema'
  }

  if (contentTrimmed.startsWith('<!DOCTYPE html') || contentTrimmed.startsWith('<html')) {
    return 'html'
  }

  if (contentTrimmed.startsWith('#') || contentTrimmed.includes('\n## ')) {
    return 'markdown'
  }

  return 'unknown'
}

/**
 * Check if content is OpenAPI JSON
 */
function isOpenApiJson(content: string): boolean {
  try {
    const parsed = JSON.parse(content)
    return !!parsed.openapi && typeof parsed.openapi === 'string'
  } catch {
    return false
  }
}

/**
 * Check if content is Swagger JSON
 */
function isSwaggerJson(content: string): boolean {
  try {
    const parsed = JSON.parse(content)
    return !!parsed.swagger && typeof parsed.swagger === 'string'
  } catch {
    return false
  }
}

/**
 * Check if content is OpenAPI YAML
 */
function isOpenApiYaml(content: string): boolean {
  return content.includes('openapi:') && (
    content.includes('paths:') || content.includes('components:')
  )
}

/**
 * Check if content is Swagger YAML
 */
function isSwaggerYaml(content: string): boolean {
  return content.includes('swagger:') && (
    content.includes('paths:') || content.includes('definitions:')
  )
}

/**
 * Simple hash function for content
 */
function simpleHash(content: string): string {
  let hash = 0
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16)
}

/**
 * Batch fetch multiple documentation URLs
 */
export async function fetchDocs(
  urls: string[],
  options: FetchOptions = {}
): Promise<Map<string, FetchedDoc | Error>> {
  const results = new Map<string, FetchedDoc | Error>()

  await Promise.all(
    urls.map(async (url) => {
      try {
        const doc = await fetchDoc(url, options)
        results.set(url, doc)
      } catch (error) {
        results.set(url, error instanceof Error ? error : new Error(String(error)))
      }
    })
  )

  return results
}

/**
 * Clear the documentation cache
 */
export function clearDocCache(): void {
  cache.clear()
}

/**
 * Check if a URL is in the cache
 */
export function isDocCached(url: string): boolean {
  return cache.has(url)
}

/**
 * Parse inline documentation content
 */
export function parseInlineDoc(content: string, hint?: DocContentType): FetchedDoc {
  const contentType = hint || detectContentType(content, '')

  return {
    url: 'inline://',
    content,
    contentType,
    statusCode: 200,
    headers: {},
    fetchedAt: Date.now(),
    contentHash: simpleHash(content)
  }
}

/**
 * Validate that a URL is accessible
 */
export async function validateDocUrl(url: string): Promise<{
  valid: boolean
  contentType?: DocContentType
  error?: string
}> {
  try {
    const doc = await fetchDoc(url, { timeoutMs: 10000 })

    if (doc.statusCode >= 400) {
      return {
        valid: false,
        error: `HTTP ${doc.statusCode}`
      }
    }

    if (doc.contentType === 'unknown') {
      return {
        valid: false,
        contentType: doc.contentType,
        error: 'Unable to determine content type'
      }
    }

    return {
      valid: true,
      contentType: doc.contentType
    }
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
