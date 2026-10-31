// The status bar usage widget shows only the windows the account reports: an
// Ultra plan has no 5h window, and its reading must not render as "5h %".
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { UsageWidgetView, usageWindowsText, type UsageWidgetProps } from '../UsageWidget';

const NOW_MS = Date.parse('2026-10-31T00:00:00Z');
const NOW_SEC = NOW_MS / 1000;

function render(snapshot: UsageWidgetProps['snapshot']): string {
  return renderToStaticMarkup(createElement(UsageWidgetView, {
    status: 'ok', snapshot, lastError: null, subscriptionType: null, nowMs: NOW_MS,
  }));
}

describe('usage widget', () => {
  it('shows both windows when both are reported', () => {
    const html = render({ sessionPct: 40, sessionResetEpochSec: NOW_SEC + 3600, weeklyPct: 12, weeklyResetEpochSec: NOW_SEC + 86_400, fetchedAtMs: NOW_MS });
    expect(html).toContain('5h 40%');
    expect(html).toContain('7d 12%');
  });

  it('leaves out the 5h segment, its separator and its tooltip line when there is no 5h window', () => {
    const html = render({ weeklyPct: 12, weeklyResetEpochSec: NOW_SEC + 86_400, fetchedAtMs: NOW_MS });
    expect(html).toContain('7d 12%');
    // Neither the segment nor the tooltip names a 5h window.
    expect(html).not.toContain('5h');
    expect(html).not.toContain('text-[var(--text-muted)]');
  });

  it('writes the windows a reading has as text', () => {
    expect(usageWindowsText({ sessionPct: 40, weeklyPct: 12 })).toBe('5h 40% · 7d 12%');
    expect(usageWindowsText({ weeklyPct: 12 })).toBe('7d 12%');
    expect(usageWindowsText({ sessionPct: 40 })).toBe('5h 40%');
  });
});
