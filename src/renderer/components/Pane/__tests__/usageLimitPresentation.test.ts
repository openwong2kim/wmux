import { describe, it, expect } from 'vitest';
import { t } from '../../../i18n';
import { usageLimitFleetDetail, usageLimitStatusText, usageLimitView } from '../usageLimitPresentation';
import type { PaneUsageLimit } from '../../../../shared/usageLimit';

const NOW = new Date(2026, 9, 3, 13, 12).getTime();
const base: PaneUsageLimit = { ptyId: 'p', provider: 'claude', detectedAt: NOW - 60_000, source: 'hook' };

describe('usageLimitView', () => {
  it('counts down to a known reset and offers the arm toggle, not Resume', () => {
    const view = usageLimitView({ ...base, resetsAt: NOW + (2 * 60 + 4) * 60_000 }, NOW, 'en-US');
    expect(view).toMatchObject({ phase: 'waiting', duration: '2h 4m', armed: false, canArm: true, canResumeNow: false });
    expect(usageLimitStatusText(view, t)).toBe(`resets ${view.clock} · 2h 4m`);
    expect(view.clock).toMatch(/3:16\s?PM/);
    expect(usageLimitFleetDetail(view, t)).toBe(`Usage limit · resets ${view.clock} (in 2h 4m)`);
  });

  it('says the limit has reset once now passes resetsAt, and offers Resume', () => {
    const view = usageLimitView({ ...base, resetsAt: NOW - 1, autoResume: true }, NOW, 'en-US');
    expect(view).toMatchObject({ phase: 'reset', armed: true, canArm: false, canResumeNow: true });
    expect(usageLimitStatusText(view, t)).toBe('Limit has reset');
  });

  it('reports an unknown reset without a clock or arm toggle', () => {
    const view = usageLimitView(base, NOW, 'en-US');
    expect(view).toMatchObject({ phase: 'unknown', canArm: false, canResumeNow: true });
    expect(view.clock).toBeUndefined();
    expect(usageLimitStatusText(view, t)).toBe('reset time unknown');
  });
});
