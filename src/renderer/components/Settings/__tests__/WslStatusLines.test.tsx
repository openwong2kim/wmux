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
    expect(html.replace(/<[^>]+>/g, '')).toBe('WSL Ubuntu: signed in · 5h 40% · 7d 12%');
    // When it was seen is the tooltip, so the line never cuts it off.
    expect(html).toContain('title="WSL Ubuntu: signed in · 5h 40% · 7d 12% · seen 3m ago (me)"');
    expect(html).toContain('data-account-wsl-status="Ubuntu"');
    expect(html).toContain('var(--text-sub)');
  });

  it('says signed out in the error colour, without the usage, with its own Sign in for that distro', () => {
    const html = render([{ ...base, signedIn: false }]);
    expect(html).toContain('WSL Ubuntu: signed out');
    expect(html).toContain('var(--accent-red)');
    expect(html).not.toContain('5h');
    expect(renderToStaticMarkup(createElement(WslStatusLines, { statuses: [{ ...base, signedIn: false }], onSignIn: () => undefined })))
      .toContain('data-account-wsl-sign-in="Ubuntu"');
  });

  it('marks a reading older than ten minutes stale, without the amber', () => {
    const text = render([{ ...base, sessionPct: 91, seenAtMs: Date.now() - 50 * 60_000 }]);
    expect(text.replace(/<[^>]+>/g, '')).toBe('WSL Ubuntu: signed in · 5h 91% · 7d 12% (stale)');
    expect(text).not.toContain('accent-yellow');
  });

  it('turns a window amber past 80%, and says when it was seen only with a reading', () => {
    expect(render([{ ...base, sessionPct: 91 }])).toContain('<span style="color:var(--accent-yellow);white-space:nowrap">5h 91%</span>');
    const text = render([{ ...base, signedIn: null, sessionPct: null, weeklyPct: null }]).replace(/<[^>]+>/g, '');
    expect(text).toBe('WSL Ubuntu: no reading yet');
  });

  it('one line per distro, and nothing for an account no WSL pane reported', () => {
    expect(render([base, { ...base, distribution: 'Debian', signedIn: null, sessionPct: null, weeklyPct: null, seenAtMs: null }]))
      .toContain('WSL Debian: no reading yet');
    expect(render([])).toBe('');
  });
});
