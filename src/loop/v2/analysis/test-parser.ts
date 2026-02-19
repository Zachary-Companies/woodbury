/**
 * Test Parser - Parse test failures from Jest/Vitest/pytest output
 */

/**
 * Parsed test failure
 */
export interface TestFailure {
  testName: string;
  suiteName?: string;
  message: string;
  stack?: string;
  location?: {
    file: string;
    line: number;
    column?: number;
  };
  expected?: string;
  actual?: string;
  diff?: string;
}

/**
 * Test run result
 */
export interface TestRunResult {
  framework: 'jest' | 'vitest' | 'pytest' | 'unknown';
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  duration?: number;
  failures: TestFailure[];
  rawOutput: string;
  exitCode: number;
}

/**
 * Test parser for multiple frameworks
 */
export class TestParser {
  /**
   * Parse test output from any supported framework
   */
  parse(output: string, hint?: 'jest' | 'vitest' | 'pytest', exitCode: number = 0): TestRunResult {
    const framework = hint || this.detectFramework(output);

    switch (framework) {
      case 'jest':
        return this.parseJest(output, exitCode);
      case 'vitest':
        return this.parseVitest(output, exitCode);
      case 'pytest':
        return this.parsePytest(output, exitCode);
      default:
        return this.parseGeneric(output, exitCode);
    }
  }

  /**
   * Detect test framework from output
   */
  private detectFramework(output: string): 'jest' | 'vitest' | 'pytest' | 'unknown' {
    if (output.includes('PASS') && output.includes('FAIL') && output.includes('Test Suites:')) {
      return 'jest';
    }
    if (output.includes('✓') && output.includes('VITEST')) {
      return 'vitest';
    }
    if (output.includes('PASSED') && output.includes('FAILED') && output.includes('pytest')) {
      return 'pytest';
    }
    if (output.includes('Test Suites:') || output.includes('Tests:')) {
      return 'jest';
    }
    return 'unknown';
  }

  /**
   * Parse Jest/Vitest output
   */
  private parseJest(output: string, exitCode: number): TestRunResult {
    const failures: TestFailure[] = [];

    // Parse summary line: "Tests: X failed, Y passed, Z total"
    const summaryMatch = output.match(/Tests:\s*(?:(\d+)\s*failed,?\s*)?(?:(\d+)\s*skipped,?\s*)?(?:(\d+)\s*passed,?\s*)?(\d+)\s*total/i);

    let failed = 0, skipped = 0, passed = 0, total = 0;
    if (summaryMatch) {
      failed = parseInt(summaryMatch[1] || '0', 10);
      skipped = parseInt(summaryMatch[2] || '0', 10);
      passed = parseInt(summaryMatch[3] || '0', 10);
      total = parseInt(summaryMatch[4] || '0', 10);
    }

    // Parse duration: "Time: X.XXs"
    const durationMatch = output.match(/Time:\s*([\d.]+)\s*s/i);
    const duration = durationMatch ? parseFloat(durationMatch[1]) * 1000 : undefined;

    // Parse individual failures
    // Jest format: "● Suite name › test name"
    const failureBlocks = output.split(/●\s+/).slice(1);

    for (const block of failureBlocks) {
      const failure = this.parseJestFailure(block);
      if (failure) {
        failures.push(failure);
      }
    }

    return {
      framework: 'jest',
      passed,
      failed,
      skipped,
      total,
      duration,
      failures,
      rawOutput: output,
      exitCode,
    };
  }

  /**
   * Parse a single Jest failure block
   */
  private parseJestFailure(block: string): TestFailure | null {
    const lines = block.split('\n');
    if (lines.length === 0) return null;

    // First line: "Suite name › test name" or just "test name"
    const titleLine = lines[0].trim();
    const titleParts = titleLine.split(' › ');
    const testName = titleParts.pop() || titleLine;
    const suiteName = titleParts.length > 0 ? titleParts.join(' › ') : undefined;

    // Find error message and assertion
    let message = '';
    let expected: string | undefined;
    let actual: string | undefined;
    let diff: string | undefined;
    let location: TestFailure['location'] | undefined;
    let stack: string | undefined;

    let i = 1;
    const messageLines: string[] = [];
    const stackLines: string[] = [];
    let inStack = false;

    while (i < lines.length) {
      const line = lines[i];

      // Check for expected/actual
      if (line.includes('Expected:') || line.includes('expect(')) {
        const expectedMatch = line.match(/Expected:\s*(.+)/);
        if (expectedMatch) expected = expectedMatch[1].trim();
      }
      if (line.includes('Received:') || line.includes('toBe')) {
        const actualMatch = line.match(/Received:\s*(.+)/);
        if (actualMatch) actual = actualMatch[1].trim();
      }

      // Check for location
      const locationMatch = line.match(/at\s+.*\((.+):(\d+):(\d+)\)/);
      if (locationMatch && !location) {
        location = {
          file: locationMatch[1],
          line: parseInt(locationMatch[2], 10),
          column: parseInt(locationMatch[3], 10),
        };
        inStack = true;
      }

      // Check for simple location
      const simpleLocationMatch = line.match(/^\s*at\s+(.+):(\d+):(\d+)/);
      if (simpleLocationMatch && !location) {
        location = {
          file: simpleLocationMatch[1],
          line: parseInt(simpleLocationMatch[2], 10),
          column: parseInt(simpleLocationMatch[3], 10),
        };
        inStack = true;
      }

      if (inStack) {
        stackLines.push(line);
      } else if (line.trim()) {
        messageLines.push(line.trim());
      }

      i++;
    }

    message = messageLines.join(' ').substring(0, 500);
    stack = stackLines.join('\n');

    return {
      testName,
      suiteName,
      message: message || 'Test failed',
      stack: stack || undefined,
      location,
      expected,
      actual,
      diff,
    };
  }

  /**
   * Parse Vitest output (similar to Jest)
   */
  private parseVitest(output: string, exitCode: number): TestRunResult {
    // Vitest output is similar to Jest
    return this.parseJest(output, exitCode);
  }

  /**
   * Parse pytest output
   */
  private parsePytest(output: string, exitCode: number): TestRunResult {
    const failures: TestFailure[] = [];

    // Parse summary: "X passed, Y failed, Z skipped"
    const summaryMatch = output.match(/(\d+)\s*passed(?:,\s*(\d+)\s*failed)?(?:,\s*(\d+)\s*skipped)?/i);

    let passed = 0, failed = 0, skipped = 0;
    if (summaryMatch) {
      passed = parseInt(summaryMatch[1] || '0', 10);
      failed = parseInt(summaryMatch[2] || '0', 10);
      skipped = parseInt(summaryMatch[3] || '0', 10);
    }

    // Parse duration
    const durationMatch = output.match(/in\s*([\d.]+)\s*s/i);
    const duration = durationMatch ? parseFloat(durationMatch[1]) * 1000 : undefined;

    // Parse failures - pytest format: "FAILED test_file.py::test_name"
    const failedTests = output.match(/FAILED\s+(\S+)/g) || [];
    const failureBlocks = output.split(/_{5,}\s*FAILURES\s*_{5,}/);

    if (failureBlocks.length > 1) {
      const failuresSection = failureBlocks[1];
      const individualFailures = failuresSection.split(/_{5,}\s+(\S+)\s+_{5,}/);

      for (let i = 1; i < individualFailures.length; i += 2) {
        const testPath = individualFailures[i];
        const content = individualFailures[i + 1] || '';

        const parts = testPath.split('::');
        const testName = parts.pop() || testPath;
        const suiteName = parts.join('::') || undefined;

        // Extract assertion error
        const assertMatch = content.match(/AssertionError:\s*(.+)/s);
        const errorMatch = content.match(/E\s+(.+)/);

        let expected: string | undefined;
        let actual: string | undefined;

        // Look for assert patterns
        const assertPattern = content.match(/assert\s+(.+?)\s*==\s*(.+)/);
        if (assertPattern) {
          actual = assertPattern[1].trim();
          expected = assertPattern[2].trim();
        }

        // Look for location
        const locationMatch = content.match(/(\S+\.py):(\d+)/);
        const location = locationMatch ? {
          file: locationMatch[1],
          line: parseInt(locationMatch[2], 10),
        } : undefined;

        failures.push({
          testName,
          suiteName,
          message: assertMatch?.[1] || errorMatch?.[1] || 'Test failed',
          location,
          expected,
          actual,
          stack: content.substring(0, 1000),
        });
      }
    }

    return {
      framework: 'pytest',
      passed,
      failed,
      skipped,
      total: passed + failed + skipped,
      duration,
      failures,
      rawOutput: output,
      exitCode,
    };
  }

  /**
   * Parse generic test output
   */
  private parseGeneric(output: string, exitCode: number): TestRunResult {
    const failures: TestFailure[] = [];

    // Try to detect pass/fail counts
    const passMatch = output.match(/(\d+)\s*(?:passed|pass|ok)/i);
    const failMatch = output.match(/(\d+)\s*(?:failed|fail|error)/i);

    const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
    const failed = failMatch ? parseInt(failMatch[1], 10) : (exitCode !== 0 ? 1 : 0);

    // Look for error patterns
    const errorPatterns = [
      /Error:\s*(.+)/g,
      /FAIL[ED]*:\s*(.+)/g,
      /AssertionError:\s*(.+)/g,
    ];

    for (const pattern of errorPatterns) {
      let match;
      while ((match = pattern.exec(output)) !== null) {
        failures.push({
          testName: 'Unknown test',
          message: match[1].substring(0, 200),
        });
      }
    }

    return {
      framework: 'unknown',
      passed,
      failed,
      skipped: 0,
      total: passed + failed,
      failures,
      rawOutput: output,
      exitCode,
    };
  }

  /**
   * Format test result for agent consumption
   */
  formatForAgent(result: TestRunResult): string {
    const lines: string[] = [];

    // Summary
    lines.push('## Test Results\n');
    lines.push(`**Status:** ${result.failed > 0 ? 'FAILED' : 'PASSED'}`);
    lines.push(`**Framework:** ${result.framework}`);
    lines.push(`**Summary:** ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped (${result.total} total)`);
    if (result.duration) {
      lines.push(`**Duration:** ${(result.duration / 1000).toFixed(2)}s`);
    }
    lines.push('');

    // Failures
    if (result.failures.length > 0) {
      lines.push('### Failures\n');

      for (let i = 0; i < result.failures.length; i++) {
        const failure = result.failures[i];
        lines.push(`#### ${i + 1}. ${failure.suiteName ? `${failure.suiteName} › ` : ''}${failure.testName}\n`);

        if (failure.location) {
          lines.push(`**Location:** ${failure.location.file}:${failure.location.line}`);
        }

        lines.push(`**Error:** ${failure.message}`);

        if (failure.expected && failure.actual) {
          lines.push(`**Expected:** ${failure.expected}`);
          lines.push(`**Actual:** ${failure.actual}`);
        }

        if (failure.stack) {
          lines.push('\n```');
          lines.push(failure.stack.substring(0, 500));
          lines.push('```\n');
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Get actionable fix suggestions based on failures
   */
  getSuggestions(result: TestRunResult): string[] {
    const suggestions: string[] = [];

    for (const failure of result.failures) {
      if (failure.expected && failure.actual) {
        suggestions.push(
          `Fix ${failure.testName}: Expected "${failure.expected}" but got "${failure.actual}"`
        );
      } else if (failure.location) {
        suggestions.push(
          `Check ${failure.location.file}:${failure.location.line} - ${failure.message}`
        );
      } else {
        suggestions.push(`Fix ${failure.testName}: ${failure.message}`);
      }
    }

    return suggestions;
  }
}

/**
 * Create a test parser
 */
export function createTestParser(): TestParser {
  return new TestParser();
}
