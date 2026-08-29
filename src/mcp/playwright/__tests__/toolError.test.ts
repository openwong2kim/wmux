import { describe, expect, it } from 'vitest';
import { describeToolError } from '../toolError';

describe('describeToolError', () => {
  it('drops the internal call-path prefix bundled Playwright derives from our frames', () => {
    expect(describeToolError(new Error('mcpServer.executeToolHandler: Timeout 30000ms exceeded'))).toBe(
      'Timeout 30000ms exceeded',
    );
    expect(describeToolError(new Error('automationLease: net::ERR_NAME_NOT_RESOLVED'))).toBe(
      'net::ERR_NAME_NOT_RESOLVED',
    );
    expect(describeToolError(new Error('locator.click: Timeout 30000ms exceeded'))).toBe(
      'Timeout 30000ms exceeded',
    );
  });

  it('keeps prefixes that mean something to the agent', () => {
    // wmux tool names…
    expect(describeToolError(new Error('browser_click: element is not enabled'))).toBe(
      'browser_click: element is not enabled',
    );
    // …and error classes.
    expect(describeToolError(new Error('TypeError: x is not a function'))).toBe(
      'TypeError: x is not a function',
    );
    expect(describeToolError(new Error('Error: boom'))).toBe('Error: boom');
  });

  it('leaves messages without a call-path prefix alone', () => {
    expect(describeToolError(new Error('net::ERR_NAME_NOT_RESOLVED'))).toBe('net::ERR_NAME_NOT_RESOLVED');
    expect(describeToolError(new Error('Timeout 30000ms exceeded'))).toBe('Timeout 30000ms exceeded');
    expect(describeToolError(new Error('Navigation failed: the page closed'))).toBe(
      'Navigation failed: the page closed',
    );
    expect(
      describeToolError(new Error('Element with smartRef=3 not found. Run browser_smart_snapshot.')),
    ).toBe('Element with smartRef=3 not found. Run browser_smart_snapshot.');
  });

  it('never strips a message down to nothing', () => {
    expect(describeToolError(new Error('automationLease: '))).toBe('automationLease: ');
  });

  it('stringifies non-Error throws', () => {
    expect(describeToolError('page.goto: boom')).toBe('boom');
    expect(describeToolError(42)).toBe('42');
  });
});
