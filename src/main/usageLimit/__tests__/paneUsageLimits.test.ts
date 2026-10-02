import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  notePaneUsageLimit,
  notePaneUsageSample,
  resetPaneUsageLimitsForTest,
  setUsageLimitResetFiller,
  usageLimitHoldDetail,
} from '../paneUsageLimits';

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
});
