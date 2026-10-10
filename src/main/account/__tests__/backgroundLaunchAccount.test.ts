import { describe, expect, it, vi } from 'vitest';
import { resolveBackgroundLaunch, resolveConversationAccount, type BackgroundLaunchDeps } from '../backgroundLaunchAccount';
import type { RotationDecision } from '../AccountRotationService';
import type { Account } from '../accountStore';
import type { QuotaVerdict } from '../../../shared/accountQuota';

const acct = (id: string): Account => ({ id, name: `name-${id}`, vendor: 'claude', configDir: `/acc/${id}`, createdAt: 0 });
const ACCOUNTS: Record<string, Account> = { a: acct('a'), b: acct('b') };
const OUT: QuotaVerdict = { usable: false, remaining: 0, availableAtMs: null };
const OK: QuotaVerdict = { usable: true, remaining: 0.5, availableAtMs: null };

function deps(opts: {
  binding?: string;
  on?: boolean;
  decision?: RotationDecision;
  verdicts?: Record<string, QuotaVerdict>;
  prepareThrows?: boolean;
}) {
  const prepareLaunch = vi.fn(async (): Promise<RotationDecision> => {
    if (opts.prepareThrows) throw new Error('boom');
    return opts.decision ?? { kind: 'keep' };
  });
  const cachedVerdict = vi.fn(async (id: string) => opts.verdicts?.[id] ?? OK);
  const d: BackgroundLaunchDeps = {
    store: {
      getAccount: (id) => ACCOUNTS[id],
      getBinding: () => opts.binding,
      resolveAccountEnv: (): Record<string, string> => (opts.binding ? { CLAUDE_CONFIG_DIR: ACCOUNTS[opts.binding].configDir } : {}),
    },
    rotation: { getSettings: () => ({ claude: !!opts.on, codex: false }), prepareLaunch, cachedVerdict },
    dirExists: () => true,
  };
  return { d, prepareLaunch, cachedVerdict };
}

describe('resolveBackgroundLaunch', () => {
  it('runs a new conversation on the account rotation switched to', async () => {
    const { d } = deps({ binding: 'a', on: true, decision: { kind: 'switch', accountId: 'b', env: { CLAUDE_CONFIG_DIR: '/acc/b' } } });
    const r = await resolveBackgroundLaunch('ws', 'claude', { resuming: false }, d);
    expect(r).toEqual({ kind: 'run', env: { CLAUDE_CONFIG_DIR: '/acc/b' }, accountId: 'b' });
  });

  it('holds a new conversation when rotation finds every account out', async () => {
    const { d } = deps({ binding: 'a', on: true, decision: { kind: 'hold', availableAtMs: null } });
    const r = await resolveBackgroundLaunch('ws', 'claude', { resuming: false }, d);
    expect(r.kind).toBe('hold');
    expect(r.kind === 'hold' && r.message).toMatch(/every registered Claude Code account is out of quota/);
  });

  it('with the switch off, runs on the binding without reading quota, even when it reads out', async () => {
    const { d, cachedVerdict } = deps({ binding: 'a', on: false, verdicts: { a: OUT } });
    const r = await resolveBackgroundLaunch('ws', 'claude', { resuming: false }, d);
    expect(cachedVerdict).not.toHaveBeenCalled();
    expect(r).toEqual({ kind: 'run', env: { CLAUDE_CONFIG_DIR: '/acc/a' }, accountId: 'a' });
  });

  it('with the switch off, resumes on the moved-to account without holding', async () => {
    const { d, cachedVerdict } = deps({ binding: 'a', on: false, verdicts: { b: OUT } });
    const r = await resolveBackgroundLaunch('ws', 'claude', { resuming: true, conversationAccountId: 'b' }, d);
    expect(cachedVerdict).not.toHaveBeenCalled();
    expect(r).toEqual({ kind: 'run', env: { CLAUDE_CONFIG_DIR: '/acc/b' }, accountId: 'b' });
  });

  it('keeps a resumed conversation on the account it moved to, without rotating', async () => {
    const { d, prepareLaunch } = deps({ binding: 'a', on: true });
    const r = await resolveBackgroundLaunch('ws', 'claude', { resuming: true, conversationAccountId: 'b' }, d);
    expect(prepareLaunch).not.toHaveBeenCalled();
    expect(r).toEqual({ kind: 'run', env: { CLAUDE_CONFIG_DIR: '/acc/b' }, accountId: 'b' });
  });

  it('holds a resumed conversation whose account is out', async () => {
    const { d } = deps({ binding: 'a', on: true, verdicts: { b: OUT } });
    const r = await resolveBackgroundLaunch('ws', 'claude', { resuming: true, conversationAccountId: 'b' }, d);
    expect(r.kind === 'hold' && r.message).toMatch(/conversation runs on \("name-b"\) is out of quota/);
  });

  it('resumes on the binding when the moved-to account is no longer registered', async () => {
    const { d } = deps({ binding: 'a', on: true });
    const r = await resolveBackgroundLaunch('ws', 'claude', { resuming: true, conversationAccountId: 'gone' }, d);
    expect(r).toEqual({ kind: 'run', env: { CLAUDE_CONFIG_DIR: '/acc/a' }, accountId: 'a' });
  });

  it('falls back to the binding when the quota check throws', async () => {
    const { d } = deps({ binding: 'a', on: true, prepareThrows: true });
    const r = await resolveBackgroundLaunch('ws', 'claude', { resuming: false }, d);
    expect(r).toEqual({ kind: 'run', env: { CLAUDE_CONFIG_DIR: '/acc/a' }, accountId: 'a' });
  });

  it('skips the quota check for a launch that does not use the account to sign in', async () => {
    const { d, prepareLaunch, cachedVerdict } = deps({ binding: 'a', on: true, verdicts: { a: OUT } });
    const r = await resolveBackgroundLaunch('ws', 'claude', { resuming: false, checkQuota: false }, d);
    expect(prepareLaunch).not.toHaveBeenCalled();
    expect(cachedVerdict).not.toHaveBeenCalled();
    expect(r).toEqual({ kind: 'run', env: { CLAUDE_CONFIG_DIR: '/acc/a' }, accountId: 'a' });
  });

  it('still resumes on the moved-to account when the quota check is skipped', async () => {
    const { d, cachedVerdict } = deps({ binding: 'a', on: true, verdicts: { b: OUT } });
    const r = await resolveBackgroundLaunch('ws', 'claude', { resuming: true, conversationAccountId: 'b', checkQuota: false }, d);
    expect(cachedVerdict).not.toHaveBeenCalled();
    expect(r).toEqual({ kind: 'run', env: { CLAUDE_CONFIG_DIR: '/acc/b' }, accountId: 'b' });
  });

  it('resumes on the moved-to account when its quota check throws', async () => {
    const { d, cachedVerdict } = deps({ binding: 'a', on: true });
    cachedVerdict.mockRejectedValueOnce(new Error('boom'));
    const r = await resolveBackgroundLaunch('ws', 'claude', { resuming: true, conversationAccountId: 'b' }, d);
    expect(r).toEqual({ kind: 'run', env: { CLAUDE_CONFIG_DIR: '/acc/b' }, accountId: 'b' });
  });

  // #2029: a conversation stays on the account it started on, even after a rebind.
  it('resumes a conversation that started on the binding on that account after a rebind', async () => {
    const { d } = deps({ binding: 'b', on: false });
    const r = await resolveBackgroundLaunch('ws', 'claude', { resuming: true, conversationAccountId: 'a' }, d);
    expect(r).toEqual({ kind: 'run', env: { CLAUDE_CONFIG_DIR: '/acc/a' }, accountId: 'a' });
  });

  it('resumes a default-login conversation on the default login after the workspace was bound', async () => {
    const { d } = deps({ binding: 'b', on: true });
    const r = await resolveBackgroundLaunch('ws', 'claude', { resuming: true, conversationAccountId: null }, d);
    expect(r).toEqual({ kind: 'run', env: {}, accountId: null });
  });

  it('resumes on the binding when the conversation\'s account is unknown (saved before accounts were recorded)', async () => {
    const { d } = deps({ binding: 'b', on: false });
    const r = await resolveBackgroundLaunch('ws', 'claude', { resuming: true }, d);
    expect(r).toEqual({ kind: 'run', env: { CLAUDE_CONFIG_DIR: '/acc/b' }, accountId: 'b' });
  });

  it('leaves an unbound workspace on the default login', async () => {
    const { d, cachedVerdict } = deps({ on: false });
    const r = await resolveBackgroundLaunch('ws', 'claude', { resuming: false }, d);
    expect(cachedVerdict).not.toHaveBeenCalled();
    expect(r).toEqual({ kind: 'run', env: {}, accountId: null });
  });
});

describe('resolveConversationAccount (shared by the resume launch and the Moa transcript lookup)', () => {
  it('uses the recorded account while its config dir is there', () => {
    const { d } = deps({ binding: 'b' });
    expect(resolveConversationAccount('ws', 'claude', 'a', d)).toEqual({
      run: { kind: 'run', env: { CLAUDE_CONFIG_DIR: '/acc/a' }, accountId: 'a' },
      fellBack: false,
    });
  });

  it('falls back to the binding when the recorded account\'s config dir is missing', () => {
    const { d } = deps({ binding: 'b' });
    const r = resolveConversationAccount('ws', 'claude', 'a', { ...d, dirExists: (dir) => dir !== '/acc/a' });
    expect(r).toEqual({ run: { kind: 'run', env: { CLAUDE_CONFIG_DIR: '/acc/b' }, accountId: 'b' }, fellBack: true });
  });

  it('uses the default login for null and the binding when unknown', () => {
    const { d } = deps({ binding: 'b' });
    expect(resolveConversationAccount('ws', 'claude', null, d).run.env).toEqual({});
    expect(resolveConversationAccount('ws', 'claude', undefined, d).run.env).toEqual({ CLAUDE_CONFIG_DIR: '/acc/b' });
  });
});
