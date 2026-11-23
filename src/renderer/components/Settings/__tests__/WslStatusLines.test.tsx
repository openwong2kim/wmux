import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WslStatusLines } from '../AccountsSection';
import type { WslAccountStatus } from '../../../../main/account/wslAccountState';

const base: WslAccountStatus = { accountId: 'a', distribution: 'Ubuntu', user: 'me', signedIn: true, sessionPct: 40, weeklyPct: 12, seenAtMs: Date.now() - 3 * 60_000 };
const render = (statuses: WslAccountStatus[]) => renderToStaticMarkup(createElement(WslStatusLines, { statuses }));

describe('WslStatusLines', () => {
  it('shows each WSL home of the account: signed in with its usage and when it was seen', () => {
    const html = render([base]);
    expect(html).toContain('WSL Ubuntu: signed in · 5h 40% · 7d 12% · seen 3m ago');
    expect(html).toContain('data-account-wsl-status="Ubuntu"');
    expect(html).toContain('var(--text-sub)');
  });

  it('says signed out in the error colour, without the stale usage', () => {
    const html = render([{ ...base, signedIn: false }]);
    expect(html).toContain('WSL Ubuntu: signed out<');
    expect(html).toContain('var(--accent-red)');
  });

  it('one line per distro, and nothing for an account no WSL pane reported', () => {
    expect(render([base, { ...base, distribution: 'Debian', signedIn: null, sessionPct: null, weeklyPct: null, seenAtMs: null }]))
      .toContain('WSL Debian: not seen working yet');
    expect(render([])).toBe('');
  });
});
