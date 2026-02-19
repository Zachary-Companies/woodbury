/**
 * Mocks
 * Mock API responses for testing agents without real network calls
 */

/**
 * Mock response configuration
 */
export interface MockResponse {
  /** Response data */
  data: unknown

  /** HTTP status code */
  status?: number

  /** Response headers */
  headers?: Record<string, string>

  /** Delay before returning (ms) */
  delay?: number

  /** Error to throw instead of returning data */
  error?: string

  /** Number of times this mock can be used (undefined = unlimited) */
  uses?: number
}

/**
 * Mock request matcher
 */
export interface MockMatcher {
  /** Match by component ID */
  componentId?: string

  /** Match by operation ID */
  operationId?: string

  /** Match by URL pattern */
  urlPattern?: string | RegExp

  /** Match by request body */
  bodyMatcher?: (body: unknown) => boolean

  /** Custom matcher function */
  custom?: (request: MockRequest) => boolean
}

/**
 * Incoming mock request
 */
export interface MockRequest {
  componentId: string
  operationId?: string
  url?: string
  method?: string
  body?: unknown
  headers?: Record<string, string>
}

/**
 * Mock entry with matcher and response
 */
interface MockEntry {
  id: string
  matcher: MockMatcher
  response: MockResponse
  callCount: number
  maxUses?: number
}

/**
 * Registry for mock responses
 */
export class MockRegistry {
  private mocks = new Map<string, MockEntry>()
  private defaultResponses = new Map<string, MockResponse>()
  private callHistory: MockCallRecord[] = []

  /**
   * Add a mock by component ID
   */
  set(componentId: string, response: MockResponse): void {
    const id = `mock_${componentId}`
    this.mocks.set(id, {
      id,
      matcher: { componentId },
      response,
      callCount: 0,
      maxUses: response.uses
    })
  }

  /**
   * Add a mock with custom matcher
   */
  addMock(matcher: MockMatcher, response: MockResponse): string {
    const id = `mock_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    this.mocks.set(id, {
      id,
      matcher,
      response,
      callCount: 0,
      maxUses: response.uses
    })
    return id
  }

  /**
   * Remove a mock
   */
  remove(id: string): boolean {
    return this.mocks.delete(id)
  }

  /**
   * Clear all mocks
   */
  clear(): void {
    this.mocks.clear()
    this.defaultResponses.clear()
    this.callHistory = []
  }

  /**
   * Get a mock response by component ID
   */
  get(componentId: string): MockResponse | undefined {
    // Find matching mock
    for (const entry of this.mocks.values()) {
      if (this.matchesMatcher(entry.matcher, { componentId })) {
        if (entry.maxUses !== undefined && entry.callCount >= entry.maxUses) {
          continue // Used up
        }
        return entry.response
      }
    }

    // Check defaults
    return this.defaultResponses.get(componentId)
  }

  /**
   * Match a request and get response
   */
  async match(request: MockRequest): Promise<MockResponse | undefined> {
    for (const entry of this.mocks.values()) {
      if (this.matchesMatcher(entry.matcher, request)) {
        if (entry.maxUses !== undefined && entry.callCount >= entry.maxUses) {
          continue
        }

        entry.callCount++

        // Record call
        this.callHistory.push({
          mockId: entry.id,
          request,
          response: entry.response,
          timestamp: Date.now()
        })

        // Apply delay if specified
        if (entry.response.delay) {
          await new Promise(resolve => setTimeout(resolve, entry.response.delay))
        }

        return entry.response
      }
    }

    // Check defaults
    const defaultResponse = this.defaultResponses.get(request.componentId)
    if (defaultResponse) {
      this.callHistory.push({
        mockId: 'default',
        request,
        response: defaultResponse,
        timestamp: Date.now()
      })
      return defaultResponse
    }

    return undefined
  }

  /**
   * Set a default response for unmocked requests
   */
  setDefault(componentId: string, response: MockResponse): void {
    this.defaultResponses.set(componentId, response)
  }

  /**
   * Check if a matcher matches a request
   */
  private matchesMatcher(matcher: MockMatcher, request: MockRequest): boolean {
    if (matcher.componentId && matcher.componentId !== request.componentId) {
      return false
    }

    if (matcher.operationId && matcher.operationId !== request.operationId) {
      return false
    }

    if (matcher.urlPattern && request.url) {
      if (typeof matcher.urlPattern === 'string') {
        if (!request.url.includes(matcher.urlPattern)) {
          return false
        }
      } else {
        if (!matcher.urlPattern.test(request.url)) {
          return false
        }
      }
    }

    if (matcher.bodyMatcher && !matcher.bodyMatcher(request.body)) {
      return false
    }

    if (matcher.custom && !matcher.custom(request)) {
      return false
    }

    return true
  }

  /**
   * Get call history
   */
  getCallHistory(): MockCallRecord[] {
    return [...this.callHistory]
  }

  /**
   * Get calls for a specific mock
   */
  getCallsFor(componentId: string): MockCallRecord[] {
    return this.callHistory.filter(c => c.request.componentId === componentId)
  }

  /**
   * Check if a mock was called
   */
  wasCalled(componentId: string): boolean {
    return this.callHistory.some(c => c.request.componentId === componentId)
  }

  /**
   * Get call count for a component
   */
  getCallCount(componentId: string): number {
    return this.callHistory.filter(c => c.request.componentId === componentId).length
  }

  /**
   * Reset call counts
   */
  resetCalls(): void {
    for (const entry of this.mocks.values()) {
      entry.callCount = 0
    }
    this.callHistory = []
  }
}

/**
 * Record of a mock call
 */
export interface MockCallRecord {
  mockId: string
  request: MockRequest
  response: MockResponse
  timestamp: number
}

/**
 * Create a mock response builder
 */
export function mockResponse(data: unknown): MockResponseBuilder {
  return new MockResponseBuilder(data)
}

/**
 * Builder for mock responses
 */
export class MockResponseBuilder {
  private response: MockResponse

  constructor(data: unknown) {
    this.response = { data }
  }

  status(code: number): this {
    this.response.status = code
    return this
  }

  headers(headers: Record<string, string>): this {
    this.response.headers = headers
    return this
  }

  delay(ms: number): this {
    this.response.delay = ms
    return this
  }

  error(message: string): this {
    this.response.error = message
    return this
  }

  uses(count: number): this {
    this.response.uses = count
    return this
  }

  build(): MockResponse {
    return this.response
  }
}

/**
 * Common mock data generators
 */
export const MockData = {
  /**
   * Generate a list of mock items
   */
  list<T>(generator: (index: number) => T, count: number): T[] {
    return Array.from({ length: count }, (_, i) => generator(i))
  },

  /**
   * Generate a mock user
   */
  user(overrides: Partial<MockUser> = {}): MockUser {
    const id = Math.random().toString(36).substr(2, 9)
    return {
      id,
      email: `user_${id}@example.com`,
      name: `User ${id}`,
      createdAt: new Date().toISOString(),
      ...overrides
    }
  },

  /**
   * Generate a mock policy (for insurance domain)
   */
  policy(overrides: Partial<MockPolicy> = {}): MockPolicy {
    const id = Math.random().toString(36).substr(2, 9)
    const startDate = new Date()
    const expirationDate = new Date(startDate)
    expirationDate.setFullYear(expirationDate.getFullYear() + 1)

    return {
      id,
      policyNumber: `POL-${id.toUpperCase()}`,
      clientId: `client_${Math.random().toString(36).substr(2, 6)}`,
      type: 'auto',
      status: 'active',
      startDate: startDate.toISOString(),
      expirationDate: expirationDate.toISOString(),
      premium: Math.floor(Math.random() * 2000) + 500,
      ...overrides
    }
  },

  /**
   * Generate a mock email
   */
  email(overrides: Partial<MockEmail> = {}): MockEmail {
    const id = Math.random().toString(36).substr(2, 9)
    return {
      id,
      from: `sender_${id}@example.com`,
      to: ['recipient@example.com'],
      subject: `Test email ${id}`,
      body: `This is a test email body for ${id}`,
      receivedAt: new Date().toISOString(),
      isRead: false,
      ...overrides
    }
  },

  /**
   * Generate mock API error response
   */
  error(status: number, message: string): MockResponse {
    return {
      data: { error: message, status },
      status,
      error: message
    }
  },

  /**
   * Generate paginated response
   */
  paginated<T>(items: T[], page: number, pageSize: number): MockPaginatedResponse<T> {
    const start = (page - 1) * pageSize
    const end = start + pageSize
    const pageItems = items.slice(start, end)

    return {
      items: pageItems,
      page,
      pageSize,
      totalItems: items.length,
      totalPages: Math.ceil(items.length / pageSize),
      hasNext: end < items.length,
      hasPrev: page > 1
    }
  }
}

// Mock data types
export interface MockUser {
  id: string
  email: string
  name: string
  createdAt: string
}

export interface MockPolicy {
  id: string
  policyNumber: string
  clientId: string
  type: string
  status: string
  startDate: string
  expirationDate: string
  premium: number
}

export interface MockEmail {
  id: string
  from: string
  to: string[]
  subject: string
  body: string
  receivedAt: string
  isRead: boolean
}

export interface MockPaginatedResponse<T> {
  items: T[]
  page: number
  pageSize: number
  totalItems: number
  totalPages: number
  hasNext: boolean
  hasPrev: boolean
}

/**
 * Create a mock registry with common mocks
 */
export function createMockRegistry(): MockRegistry {
  return new MockRegistry()
}

/**
 * Create mocks for a specific domain
 */
export function createDomainMocks(domain: 'insurance' | 'email' | 'crm'): MockRegistry {
  const registry = new MockRegistry()

  switch (domain) {
    case 'insurance':
      registry.set('hawksoft_connector', {
        data: {
          policies: MockData.list(() => MockData.policy(), 10)
        }
      })
      break

    case 'email':
      registry.set('email_connector', {
        data: {
          emails: MockData.list(() => MockData.email(), 20)
        }
      })
      break

    case 'crm':
      registry.set('crm_connector', {
        data: {
          users: MockData.list(() => MockData.user(), 50)
        }
      })
      break
  }

  return registry
}
