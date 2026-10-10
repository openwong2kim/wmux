import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: true } }));

import { e2eHooksEnabled } from '../e2eHooks';

describe('e2eHooksEnabled — dev builds only, opt-in', () => {
  it('needs both an unpackaged build and WMUX_E2E_HOOKS=1', () => {
    expect(e2eHooksEnabled({ WMUX_E2E_HOOKS: '1' }, false)).toBe(true);
    expect(e2eHooksEnabled({ WMUX_E2E_HOOKS: '1' }, true)).toBe(false);
    expect(e2eHooksEnabled({}, false)).toBe(false);
    expect(e2eHooksEnabled({ WMUX_E2E_HOOKS: 'true' }, false)).toBe(false);
  });

  it('a packaged app never installs them, whatever the environment says', () => {
    expect(e2eHooksEnabled({ WMUX_E2E_HOOKS: '1' })).toBe(false);
  });
});
