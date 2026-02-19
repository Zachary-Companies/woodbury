/**
 * Scheduler
 * Cron-based and interval scheduling for agent execution
 */

/**
 * Schedule configuration
 */
export interface ScheduleConfig {
  /** Cron expression (e.g., "0 8 * * 1-5" for weekdays at 8 AM) */
  cron: string

  /** Timezone for the schedule (default: 'UTC') */
  timezone?: string

  /** Whether to run immediately when scheduled */
  runImmediately?: boolean

  /** Maximum number of runs (undefined = unlimited) */
  maxRuns?: number

  /** Whether the schedule is enabled */
  enabled?: boolean
}

/**
 * Scheduled job
 */
export interface ScheduledJob {
  id: string
  config: ScheduleConfig
  callback: () => Promise<void>
  lastRun?: number
  nextRun?: number
  runCount: number
  enabled: boolean
}

/**
 * Scheduler options
 */
export interface SchedulerOptions {
  /** Default timezone */
  timezone?: string

  /** Tick interval in ms (default: 1000) */
  tickInterval?: number

  /** Error handler */
  onError?: (error: Error, jobId: string) => void
}

/**
 * Parsed cron expression
 */
interface ParsedCron {
  minutes: number[]
  hours: number[]
  days: number[]
  months: number[]
  weekdays: number[]
}

/**
 * Scheduler for managing timed agent executions
 */
export class Scheduler {
  private jobs = new Map<string, ScheduledJob>()
  private running = false
  private tickInterval: number
  private intervalId?: ReturnType<typeof setInterval>
  private options: SchedulerOptions

  constructor(options: SchedulerOptions = {}) {
    this.options = options
    this.tickInterval = options.tickInterval || 1000
  }

  /**
   * Add a scheduled job
   */
  addJob(id: string, config: ScheduleConfig, callback: () => Promise<void>): void {
    if (this.jobs.has(id)) {
      throw new Error(`Job with id "${id}" already exists`)
    }

    const job: ScheduledJob = {
      id,
      config: {
        ...config,
        timezone: config.timezone || this.options.timezone || 'UTC'
      },
      callback,
      runCount: 0,
      enabled: config.enabled !== false
    }

    // Calculate next run time
    job.nextRun = this.calculateNextRun(job.config.cron, job.config.timezone!)

    this.jobs.set(id, job)

    // Run immediately if configured
    if (config.runImmediately && job.enabled) {
      this.executeJob(job).catch(error => {
        this.options.onError?.(error as Error, id)
      })
    }
  }

  /**
   * Remove a scheduled job
   */
  removeJob(id: string): boolean {
    return this.jobs.delete(id)
  }

  /**
   * Enable a job
   */
  enableJob(id: string): void {
    const job = this.jobs.get(id)
    if (job) {
      job.enabled = true
      job.nextRun = this.calculateNextRun(job.config.cron, job.config.timezone!)
    }
  }

  /**
   * Disable a job
   */
  disableJob(id: string): void {
    const job = this.jobs.get(id)
    if (job) {
      job.enabled = false
    }
  }

  /**
   * Get all jobs
   */
  getJobs(): ScheduledJob[] {
    return Array.from(this.jobs.values())
  }

  /**
   * Get a specific job
   */
  getJob(id: string): ScheduledJob | undefined {
    return this.jobs.get(id)
  }

  /**
   * Start the scheduler
   */
  start(): void {
    if (this.running) {
      return
    }

    this.running = true
    this.intervalId = setInterval(() => this.tick(), this.tickInterval)
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    this.running = false
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
    }
  }

  /**
   * Check if scheduler is running
   */
  isRunning(): boolean {
    return this.running
  }

  /**
   * Manually trigger a job
   */
  async triggerJob(id: string): Promise<void> {
    const job = this.jobs.get(id)
    if (!job) {
      throw new Error(`Job not found: ${id}`)
    }
    await this.executeJob(job)
  }

  /**
   * Scheduler tick - check and execute due jobs
   */
  private tick(): void {
    const now = Date.now()

    for (const job of this.jobs.values()) {
      if (!job.enabled) continue
      if (!job.nextRun) continue
      if (job.config.maxRuns !== undefined && job.runCount >= job.config.maxRuns) {
        job.enabled = false
        continue
      }

      if (now >= job.nextRun) {
        this.executeJob(job).catch(error => {
          this.options.onError?.(error as Error, job.id)
        })
      }
    }
  }

  /**
   * Execute a job
   */
  private async executeJob(job: ScheduledJob): Promise<void> {
    job.lastRun = Date.now()
    job.runCount++

    // Calculate next run before executing (in case execution is slow)
    job.nextRun = this.calculateNextRun(job.config.cron, job.config.timezone!)

    try {
      await job.callback()
    } catch (error) {
      throw error
    }
  }

  /**
   * Calculate the next run time for a cron expression
   */
  private calculateNextRun(cron: string, _timezone: string): number {
    const parsed = this.parseCron(cron)
    const now = new Date()

    // Simple implementation: find next matching time
    // In production, use a proper cron library with timezone support

    // Start from the next minute
    const candidate = new Date(now)
    candidate.setSeconds(0)
    candidate.setMilliseconds(0)
    candidate.setMinutes(candidate.getMinutes() + 1)

    // Search for up to 1 year
    const maxIterations = 365 * 24 * 60
    for (let i = 0; i < maxIterations; i++) {
      if (this.matchesCron(candidate, parsed)) {
        return candidate.getTime()
      }
      candidate.setMinutes(candidate.getMinutes() + 1)
    }

    // Fallback: 1 hour from now
    return Date.now() + 3600000
  }

  /**
   * Parse a cron expression
   */
  private parseCron(cron: string): ParsedCron {
    const parts = cron.trim().split(/\s+/)

    if (parts.length < 5) {
      throw new Error(`Invalid cron expression: ${cron}`)
    }

    return {
      minutes: this.parseCronField(parts[0], 0, 59),
      hours: this.parseCronField(parts[1], 0, 23),
      days: this.parseCronField(parts[2], 1, 31),
      months: this.parseCronField(parts[3], 1, 12),
      weekdays: this.parseCronField(parts[4], 0, 6)
    }
  }

  /**
   * Parse a single cron field
   */
  private parseCronField(field: string, min: number, max: number): number[] {
    const values: number[] = []

    // Handle *
    if (field === '*') {
      for (let i = min; i <= max; i++) {
        values.push(i)
      }
      return values
    }

    // Handle ranges and steps
    const parts = field.split(',')
    for (const part of parts) {
      if (part.includes('/')) {
        // Step: */5 or 0-30/5
        const [range, stepStr] = part.split('/')
        const step = parseInt(stepStr, 10)
        const [start, end] = range === '*'
          ? [min, max]
          : range.split('-').map(n => parseInt(n, 10))

        for (let i = start || min; i <= (end || max); i += step) {
          values.push(i)
        }
      } else if (part.includes('-')) {
        // Range: 1-5
        const [start, end] = part.split('-').map(n => parseInt(n, 10))
        for (let i = start; i <= end; i++) {
          values.push(i)
        }
      } else {
        // Single value
        values.push(parseInt(part, 10))
      }
    }

    return [...new Set(values)].sort((a, b) => a - b)
  }

  /**
   * Check if a date matches a parsed cron expression
   */
  private matchesCron(date: Date, parsed: ParsedCron): boolean {
    return (
      parsed.minutes.includes(date.getMinutes()) &&
      parsed.hours.includes(date.getHours()) &&
      parsed.days.includes(date.getDate()) &&
      parsed.months.includes(date.getMonth() + 1) &&
      parsed.weekdays.includes(date.getDay())
    )
  }
}

/**
 * Create a simple interval-based scheduler
 */
export function createIntervalScheduler(
  intervalMs: number,
  callback: () => Promise<void>,
  options: { immediate?: boolean; maxRuns?: number } = {}
): { start: () => void; stop: () => void; isRunning: () => boolean } {
  let running = false
  let intervalId: ReturnType<typeof setInterval> | undefined
  let runCount = 0

  const execute = async () => {
    if (options.maxRuns !== undefined && runCount >= options.maxRuns) {
      stop()
      return
    }
    runCount++
    await callback()
  }

  const start = () => {
    if (running) return
    running = true

    if (options.immediate) {
      execute().catch(console.error)
    }

    intervalId = setInterval(() => {
      execute().catch(console.error)
    }, intervalMs)
  }

  const stop = () => {
    running = false
    if (intervalId) {
      clearInterval(intervalId)
      intervalId = undefined
    }
  }

  return {
    start,
    stop,
    isRunning: () => running
  }
}

/**
 * Common cron expressions
 */
export const CRON_EXPRESSIONS = {
  /** Every minute */
  EVERY_MINUTE: '* * * * *',

  /** Every 5 minutes */
  EVERY_5_MINUTES: '*/5 * * * *',

  /** Every 15 minutes */
  EVERY_15_MINUTES: '*/15 * * * *',

  /** Every 30 minutes */
  EVERY_30_MINUTES: '*/30 * * * *',

  /** Every hour */
  EVERY_HOUR: '0 * * * *',

  /** Every day at midnight */
  DAILY_MIDNIGHT: '0 0 * * *',

  /** Every day at 8 AM */
  DAILY_8AM: '0 8 * * *',

  /** Every day at 6 PM */
  DAILY_6PM: '0 18 * * *',

  /** Every weekday at 8 AM */
  WEEKDAYS_8AM: '0 8 * * 1-5',

  /** Every weekday at 9 AM */
  WEEKDAYS_9AM: '0 9 * * 1-5',

  /** Every Monday at 9 AM */
  WEEKLY_MONDAY_9AM: '0 9 * * 1',

  /** First day of month at midnight */
  MONTHLY_FIRST: '0 0 1 * *',

  /** Last day of month at midnight (approximation) */
  MONTHLY_LAST: '0 0 28-31 * *'
} as const

/**
 * Parse a human-readable schedule into cron
 */
export function parseHumanSchedule(schedule: string): string {
  const lower = schedule.toLowerCase().trim()

  // Check for predefined patterns
  if (lower.includes('every minute')) return CRON_EXPRESSIONS.EVERY_MINUTE
  if (lower.includes('every 5 min')) return CRON_EXPRESSIONS.EVERY_5_MINUTES
  if (lower.includes('every 15 min')) return CRON_EXPRESSIONS.EVERY_15_MINUTES
  if (lower.includes('every 30 min')) return CRON_EXPRESSIONS.EVERY_30_MINUTES
  if (lower.includes('every hour') || lower.includes('hourly')) return CRON_EXPRESSIONS.EVERY_HOUR
  if (lower.includes('midnight') || lower.includes('daily at 12 am')) return CRON_EXPRESSIONS.DAILY_MIDNIGHT

  // Weekday patterns
  if (lower.includes('weekday') && lower.includes('8 am')) return CRON_EXPRESSIONS.WEEKDAYS_8AM
  if (lower.includes('weekday') && lower.includes('9 am')) return CRON_EXPRESSIONS.WEEKDAYS_9AM

  // Time-based patterns
  const timeMatch = lower.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10)
    const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0
    const ampm = timeMatch[3]?.toLowerCase()

    if (ampm === 'pm' && hours < 12) hours += 12
    if (ampm === 'am' && hours === 12) hours = 0

    // Check for day patterns
    if (lower.includes('weekday')) {
      return `${minutes} ${hours} * * 1-5`
    }
    if (lower.includes('monday')) {
      return `${minutes} ${hours} * * 1`
    }
    if (lower.includes('daily') || lower.includes('every day')) {
      return `${minutes} ${hours} * * *`
    }

    // Default to daily
    return `${minutes} ${hours} * * *`
  }

  // Default fallback
  throw new Error(`Could not parse schedule: ${schedule}`)
}

/**
 * Format a cron expression as human-readable text
 */
export function formatCronAsHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/)
  if (parts.length < 5) return cron

  const [min, hour, day, month, weekday] = parts

  // Special cases
  if (cron === CRON_EXPRESSIONS.EVERY_MINUTE) return 'Every minute'
  if (cron === CRON_EXPRESSIONS.EVERY_HOUR) return 'Every hour'
  if (cron === CRON_EXPRESSIONS.DAILY_MIDNIGHT) return 'Daily at midnight'

  // Build description
  const descriptions: string[] = []

  // Time
  if (hour !== '*' && min !== '*') {
    const h = parseInt(hour, 10)
    const m = parseInt(min, 10)
    const ampm = h >= 12 ? 'PM' : 'AM'
    const displayHour = h > 12 ? h - 12 : h === 0 ? 12 : h
    const displayMin = m.toString().padStart(2, '0')
    descriptions.push(`at ${displayHour}:${displayMin} ${ampm}`)
  } else if (hour !== '*') {
    descriptions.push(`at ${hour}:00`)
  }

  // Day of week
  if (weekday !== '*') {
    const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    if (weekday === '1-5') {
      descriptions.push('on weekdays')
    } else if (weekday.includes(',')) {
      const days = weekday.split(',').map(d => weekdayNames[parseInt(d, 10)])
      descriptions.push(`on ${days.join(', ')}`)
    } else {
      descriptions.push(`on ${weekdayNames[parseInt(weekday, 10)]}`)
    }
  } else if (day !== '*') {
    descriptions.push(`on day ${day} of the month`)
  }

  if (month !== '*') {
    descriptions.push(`in month ${month}`)
  }

  return descriptions.join(' ') || cron
}
