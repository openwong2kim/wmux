import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  forgetPaneUsage,
  notePaneUsageLimit,
  notePaneUsageSample,
  paneUsageWindows,
  resetPaneUsageLimitsForTest,
  setPaneUsageWindowsListener,
  setUsageLimitResetFiller,
  usageLimitHoldDetail,
} from '../paneUsageLimits';
import { nearLimitWindow } from '../../../shared/usageLimit';

afterEach(() => resetPaneUsageLimitsForTest());

describe('paneUsageLimits', () => {
  it('names a held pane for the delivery gate and releases it after the reset', () => {
    const now = Date.now();
    notePaneUsageLimit('p1', { ptyId: 'p1', provider: 'claude', detectedAt: now, resetsAt: now + 3_600_000, source: 'hook' });
    expect(usageLimitHoldDetail('p1', now)).toMatch(/usage limit; held until it resets at .* \(in 1h\)/);
    expect(usageLimitHoldDetail('p1', now + 3_600_000 + 60_000)).toBeNull();
    expect(usageLimitHoldDetail('other', now)).toBeNull();
  });

  it("fills a Claude pane's unknown reset from its own exhausted statusline window", () => {
    const fill = vi.fn();
    setUsageLimitResetFiller(fill);
    const resetSec = Math.floor(Date.now() / 1000) + 7200;
    notePaneUsageLimit('p1', { ptyId: 'p1', provider: 'claude', detectedAt: Date.now(), source: 'hook' });
    expect(fill).not.toHaveBeenCalled();
    notePaneUsageSample('p1', { session: { pct: 100, resetEpochSec: resetSec }, weekly: { pct: 40, resetEpochSec: resetSec + 86_400 } });
    expect(fill).toHaveBeenCalledWith('p1', resetSec * 1000);
  });

  it("gives every pane on one account that account's latest 5-hour window, and drops it at the reset", () => {
    const now = 1_800_000_000_000;
    const reset = now / 1000 + 3600;
    const changed = vi.fn();
    setPaneUsageWindowsListener(changed);
    // Two panes on one config dir; the statusline sends a changed sample from whichever drew first.
    notePaneUsageSample('a', { session: { pct: 80, resetEpochSec: reset } }, '/acct/work', now);
    notePaneUsageSample('b', { session: { pct: 80, resetEpochSec: reset } }, '/acct/work', now);
    notePaneUsageSample('c', { session: { pct: 10, resetEpochSec: reset } }, null, now);
    notePaneUsageSample('a', { session: { pct: 91, resetEpochSec: reset } }, '/acct/work', now);
    const windows = paneUsageWindows(now);
    expect(windows).toEqual({
      a: { pct: 91, resetsAt: reset * 1000 },
      b: { pct: 91, resetsAt: reset * 1000 },
      c: { pct: 10, resetsAt: reset * 1000 },
    });
    expect(changed).toHaveBeenCalled();
    // Close to the limit from 90%, until the reset.
    expect(nearLimitWindow(windows.b, now)).toEqual(windows.b);
    expect(nearLimitWindow(windows.c, now)).toBeNull();
    expect(nearLimitWindow(windows.b, reset * 1000)).toBeNull();
    expect(paneUsageWindows(reset * 1000)).toEqual({});
    forgetPaneUsage('b');
    expect(Object.keys(paneUsageWindows(now))).toEqual(['a', 'c']);
  });
});
