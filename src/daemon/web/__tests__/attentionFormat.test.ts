import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

/**
 * The frontend has no bundler — `attentionFormat.js` is inlined into
 * terminal.html by scripts/build-daemon-web.mjs. Evaluate the shipped file
 * verbatim so this test covers exactly the code the phone runs.
 */
type Formatted = { title: string; sub: string };
type Formatter = (kind: string, data: unknown) => Formatted;

let formatAttention: Formatter;

beforeAll(() => {
  const src = readFileSync(
    join(__dirname, '..', 'frontend', 'attentionFormat.js'),
    'utf8',
  );
  const sandbox: Record<string, unknown> = {};
  runInNewContext(src, sandbox);
  formatAttention = (sandbox.wmuxAttentionFormat as { formatAttention: Formatter }).formatAttention;
});

describe('formatAttention', () => {
  it('names the approval and quotes the action for a critical event', () => {
    expect(formatAttention('critical', { action: 'delete files', riskLevel: 'critical' })).toEqual({
      title: 'Approval needed',
      sub: 'delete files',
    });
  });

  it('still says what is happening when a critical event carries no action', () => {
    expect(formatAttention('critical', {})).toEqual({
      title: 'Approval needed',
      sub: 'A pane is waiting on you.',
    });
  });

  it('#597: an OSC 9 notification (no title) shows its BODY, not the word "Notification"', () => {
    expect(formatAttention('notify', {
      source: 'osc9',
      title: null,
      body: 'Build finished, 3 tests failed',
    })).toEqual({ title: 'Build finished, 3 tests failed', sub: '' });
  });

  it('uses title + body when the notification carries both (OSC 777)', () => {
    expect(formatAttention('notify', { source: 'osc777', title: 'wmux', body: 'done' })).toEqual({
      title: 'wmux',
      sub: 'done',
    });
  });

  it('falls back to a title-only notification', () => {
    expect(formatAttention('notify', { title: 'Heads up', body: '' })).toEqual({
      title: 'Heads up',
      sub: '',
    });
  });

  it('only says "Notification" when the payload is genuinely empty', () => {
    expect(formatAttention('notify', {})).toEqual({ title: 'Notification', sub: '' });
    expect(formatAttention('notify', undefined)).toEqual({ title: 'Notification', sub: '' });
  });

  it('ignores non-string garbage instead of rendering [object Object]', () => {
    expect(formatAttention('notify', { title: { a: 1 }, body: 42 })).toEqual({
      title: 'Notification',
      sub: '',
    });
  });
});
