import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountRowStatus, tokenExpiryDate } from '../AccountsSection';
import type { AccountRow } from '../../../../main/ipc/handlers/account.handler';
import type { AccountUsageEntry } from '../../../../main/account/AccountUsageService';

const SAVED_AT = Date.UTC(2026, 10, 11, 12, 0, 0);

function row(extra: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 'acc-1',
    name: 'Work',
    vendor: 'claude',
    configDir: '/tmp/.wmux/accounts/claude-1',
    createdAt: 0,
    status: { loggedIn: false },
    loginCommand: 'claude auth login',
    ...extra,
  } as AccountRow;
}

const expired: AccountUsageEntry = { accountId: 'acc-1', status: 'unauthorized', snapshot: null, fetchedAtMs: SAVED_AT, lastError: '401' };

function render(r: AccountRow, usage: AccountUsageEntry | undefined = expired): string {
  return renderToStaticMarkup(createElement(AccountRowStatus, { row: r, usage, pending: false, rotationRow: undefined }));
}

describe('AccountRowStatus', () => {
  it('shows a token row as token sign-in with its expiry, never the usage, expired or logged-out state', () => {
    const html = render(row({ tokenSignIn: { createdAt: SAVED_AT, usable: true } }));
    expect(html).toContain('Token sign-in · usage not available · expires about 2027-11-11');
    expect(html).not.toContain('auth expired');
    expect(html).not.toContain('logged out');
    expect(html).not.toContain('Log in again');
  });

  it('says a token this computer cannot decrypt must be pasted again', () => {
    const html = render(row({ tokenSignIn: { createdAt: SAVED_AT, usable: false } }));
    expect(html).toContain('paste it again');
    expect(html).not.toContain('expires about');
  });

  it('keeps the browser-login state and usage for an account without a token', () => {
    const html = render(row());
    expect(html).toContain('Log in again');
    expect(html).toContain('auth expired');
    expect(html).not.toContain('Token sign-in');
  });

  it('counts a year from when the token was saved', () => {
    expect(tokenExpiryDate(SAVED_AT)).toBe('2027-11-11');
  });
});
