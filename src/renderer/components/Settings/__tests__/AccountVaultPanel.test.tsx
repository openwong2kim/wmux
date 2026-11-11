import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountVaultTable, parseGenerateLength, vaultAddBlock, vaultNameError } from '../AccountVaultPanel';
import type { AccountVaultEntry } from '../../../../main/account/accountVault';

const TOKEN = 'CLAUDE_CODE_OAUTH_TOKEN';

/** Metadata only: entries never carry a value. */
function entry(name: string, extra: Partial<AccountVaultEntry> = {}): AccountVaultEntry {
  return { accountId: 'acc-1', name, inject: true, length: 40, createdAt: 1, updatedAt: 1, usable: true, fingerprint: '1a2b3c4d', ...extra };
}

function table(entries: AccountVaultEntry[], managedName?: string): string {
  return renderToStaticMarkup(createElement(AccountVaultTable, {
    entries, managedName, confirming: null, busy: false,
    onToggle: () => undefined, onAskRemove: () => undefined, onRemove: () => undefined, onCancelRemove: () => undefined,
  }));
}

describe('vault name and limit rules', () => {
  it('takes a credential-shaped env name and refuses a bad, taken or reserved one', () => {
    const entries = [entry('GITHUB_TOKEN')];
    expect(vaultNameError('HF_TOKEN', entries, TOKEN)).toBeNull();
    expect(vaultNameError('github_token', entries, TOKEN)).toBe('invalid');
    expect(vaultNameError('EDITOR', entries, TOKEN)).toBe('invalid');
    expect(vaultNameError('WMUX_TOKEN', entries, TOKEN)).toBe('invalid');
    expect(vaultNameError('GITHUB_TOKEN', entries, TOKEN)).toBe('taken');
    expect(vaultNameError(TOKEN, [], TOKEN)).toBe('reserved');
  });

  it('blocks adding at the limit, and before that when nothing can be stored', () => {
    expect(vaultAddBlock(7, 8, null)).toBeNull();
    expect(vaultAddBlock(8, 8, null)).toBe('full');
    expect(vaultAddBlock(0, 8, { code: 'encryption_unavailable' })).toBe('encryption_unavailable');
    expect(vaultAddBlock(8, 8, { code: 'basic_text' })).toBe('basic_text');
  });

  it('reads an empty length as the default and refuses one out of range', () => {
    expect(parseGenerateLength('')).toBeUndefined();
    expect(parseGenerateLength('64')).toBe(64);
    expect(parseGenerateLength('4')).toBeNull();
    expect(parseGenerateLength('300')).toBeNull();
    expect(parseGenerateLength('3e1')).toBeNull();
  });
});

describe('AccountVaultTable', () => {
  it('shows the sign-in token as a managed row: no checkbox, no remove, always injected', () => {
    const html = table([entry(TOKEN), entry('GITHUB_TOKEN', { inject: false })], TOKEN);
    const tokenRow = html.slice(html.indexOf(`data-account-vault-entry="${TOKEN}"`), html.indexOf('data-account-vault-entry="GITHUB_TOKEN"'));
    expect(tokenRow).toContain('For sign-in (automatic)');
    expect(tokenRow).toContain('Always');
    expect(tokenRow).not.toContain('role="checkbox"');
    expect(tokenRow).not.toContain(`Remove ${TOKEN}`);
    const other = html.slice(html.indexOf('data-account-vault-entry="GITHUB_TOKEN"'));
    expect(other).toContain('role="checkbox"');
    expect(other).toContain('aria-checked="false"');
    expect(other).toContain('Remove GITHUB_TOKEN');
    expect(html).toContain('40 · 1a2b3c4d');
  });

  it('lists the token as an ordinary row when the account does not sign in with it', () => {
    const html = table([entry(TOKEN)]);
    expect(html).not.toContain('For sign-in (automatic)');
    expect(html).toContain('role="checkbox"');
  });

  it('says an entry this computer cannot decrypt must be saved again, with no fingerprint', () => {
    const html = table([entry('HF_TOKEN', { usable: false, fingerprint: null })]);
    expect(html).toContain('save it again');
    expect(html).not.toContain('1a2b3c4d');
  });
});
