/**
 * Tests for two decision points that used to be buried inline in large handlers:
 *
 *  - shouldRetryScheduledRun(): guards the scheduler's retry of a failed
 *    scheduled composition run.
 *  - evaluateBranchCondition(): decides which way a pipeline branch node goes
 *    when a configured expression and an edge-supplied value are both present.
 */

import {
  shouldRetryScheduledRun,
  SCHEDULE_MAX_RETRIES,
  SCHEDULE_RETRY_DELAY_MS,
  type ScheduledRunState,
} from '../dashboard/server';
import { evaluateBranchCondition } from '../dashboard/routes/composition-run';

describe('shouldRetryScheduledRun', () => {
  const NOW = 1_000_000_000;
  const failedRun = (over: Partial<ScheduledRunState> = {}): ScheduledRunState => ({
    done: true,
    success: false,
    compositionId: 'comp-1',
    _scheduledRetries: 0,
    doneAt: NOW - SCHEDULE_RETRY_DELAY_MS,
    ...over,
  });

  it('retries a failed scheduled run once the delay has elapsed', () => {
    expect(shouldRetryScheduledRun(failedRun(), NOW)).toBe(true);
  });

  it('waits until the retry delay has elapsed', () => {
    const tooSoon = failedRun({ doneAt: NOW - (SCHEDULE_RETRY_DELAY_MS - 1) });
    expect(shouldRetryScheduledRun(tooSoon, NOW)).toBe(false);
  });

  it('ignores a run that is still in progress', () => {
    expect(shouldRetryScheduledRun(failedRun({ done: false }), NOW)).toBe(false);
  });

  it('ignores a run that succeeded', () => {
    expect(shouldRetryScheduledRun(failedRun({ success: true }), NOW)).toBe(false);
  });

  it('ignores runs the scheduler did not start', () => {
    // A manual run from the dashboard has no _scheduledRetries marker and must
    // not be resurrected by the scheduler.
    expect(shouldRetryScheduledRun(failedRun({ _scheduledRetries: undefined }), NOW)).toBe(false);
  });

  it('ignores a missing run', () => {
    expect(shouldRetryScheduledRun(null, NOW)).toBe(false);
    expect(shouldRetryScheduledRun(undefined, NOW)).toBe(false);
  });

  it('stops once the attempts are exhausted', () => {
    expect(shouldRetryScheduledRun(failedRun({ _scheduledRetries: SCHEDULE_MAX_RETRIES }), NOW)).toBe(false);
    expect(shouldRetryScheduledRun(failedRun({ _scheduledRetries: SCHEDULE_MAX_RETRIES - 1 }), NOW)).toBe(true);
  });

  it('terminates when the retry never manages to start a run', () => {
    // The regression: the counter was only written onto the NEW run object, so
    // a retry that came back without a runId left the failed run untouched and
    // this predicate stayed true on every 30s tick, forever. Consuming the
    // attempt on the failed run is what makes the loop finite.
    const run = failedRun();
    let dispatches = 0;

    for (let tick = 0; tick < 50; tick++) {
      const nowMs = NOW + tick * 30_000;
      if (shouldRetryScheduledRun(run, nowMs)) {
        dispatches++;
        // Simulate the caller: consume the attempt, then the retry fails to
        // start so activeCompRun is still this same failed run.
        run._scheduledRetries = (run._scheduledRetries ?? 0) + 1;
        run.doneAt = nowMs;
      }
    }

    expect(dispatches).toBe(SCHEDULE_MAX_RETRIES);
  });
});

describe('evaluateBranchCondition', () => {
  describe('edge-supplied condition', () => {
    it('uses the edge value when there is no expression', () => {
      expect(evaluateBranchCondition('', true, {})).toEqual({ value: true });
      expect(evaluateBranchCondition('', false, {})).toEqual({ value: false });
    });

    it('keeps the edge value when the expression cannot consume it', () => {
      // The regression: a leftover expression that mentions neither {{value}}
      // nor {{condition}} would be evaluated anyway, substitute null for its own
      // unknown variables, yield false, and discard a live edge value.
      const result = evaluateBranchCondition('{{status}} === "ok"', true, {});
      expect(result.value).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('lets an expression consume the edge value via {{value}}', () => {
      expect(evaluateBranchCondition('{{value}} > 10', 42, {}).value).toBe(true);
      expect(evaluateBranchCondition('{{value}} > 10', 5, {}).value).toBe(false);
    });

    it('lets an expression consume the edge value via {{condition}}', () => {
      expect(evaluateBranchCondition('{{condition}} === true', true, {}).value).toBe(true);
      expect(evaluateBranchCondition('{{condition}} === true', false, {}).value).toBe(false);
    });

    it('coerces a truthy non-boolean edge value', () => {
      expect(evaluateBranchCondition('', 'yes', {}).value).toBe(true);
      expect(evaluateBranchCondition('', 0, {}).value).toBe(false);
      expect(evaluateBranchCondition('', '', {}).value).toBe(false);
    });
  });

  describe('expression evaluation', () => {
    it('evaluates against merged inputs when no edge value is present', () => {
      expect(evaluateBranchCondition('{{count}} > 3', undefined, { count: 5 }).value).toBe(true);
      expect(evaluateBranchCondition('{{count}} > 3', undefined, { count: 1 }).value).toBe(false);
    });

    it('quotes string substitutions so they compare correctly', () => {
      expect(
        evaluateBranchCondition('{{status}} === "ok"', undefined, { status: 'ok' }).value
      ).toBe(true);
      expect(
        evaluateBranchCondition('{{status}} === "ok"', undefined, { status: 'bad' }).value
      ).toBe(false);
    });

    it('substitutes null for missing variables', () => {
      expect(evaluateBranchCondition('{{missing}} === null', undefined, {}).value).toBe(true);
    });

    it('honors literal true/false without evaluating', () => {
      expect(evaluateBranchCondition('true', undefined, {}).value).toBe(true);
      expect(evaluateBranchCondition('false', undefined, {}).value).toBe(false);
    });

    it('lets an edge value override a literal expression', () => {
      expect(evaluateBranchCondition('false', true, {}).value).toBe(true);
      expect(evaluateBranchCondition('true', false, {}).value).toBe(false);
    });

    it('reports a broken expression instead of silently branching false', () => {
      // A swallowed throw is indistinguishable from a legitimate false, which
      // makes a typo'd condition look like normal routing in the run log.
      const result = evaluateBranchCondition('this is not ( valid js', undefined, {});
      expect(result.value).toBe(false);
      expect(result.error).toMatch(/failed to evaluate/);
    });

    it('defaults to false with neither an expression nor an edge value', () => {
      expect(evaluateBranchCondition('', undefined, {})).toEqual({ value: false });
    });
  });
});
