import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RpcRouter } from '../../RpcRouter';
import {
  registerUsageRpc,
  resolveUsageTarget,
  validateRateLimitsParams,
  type UsageRpcDeps,
} from '../usage.rpc';
import { paneUsageWindows, resetPaneUsageLimitsForTest } from '../../../usageLimit/paneUsageLimits';
import { wslAccountHomeKey } from '../../../../shared/wslAccountHome';

const RESET = 1_900_000_000;
// Platform-neutral fixtures: absolute on POSIX and Windows alike.
const ACCT_A = path.resolve('/acct/a');
const NOWHERE = path.resolve('/nowhere/.claude');

function sample(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    configDir: null,
    ptyId: 'pty-1',
    rateLimits: {
      five_hour: { pct: 12.6, resets_at: RESET },
      seven_day: { pct: 40, resets_at: RESET + 3600 },
    },
    ...overrides,
  };
}

describe('validateRateLimitsParams', () => {
  it('accepts the statusline shape and rounds fractional pct', () => {
    const v = validateRateLimitsParams(sample());
    expect(v?.update.session).toEqual({ pct: 13, resetEpochSec: RESET });
    expect(v?.update.weekly).toEqual({ pct: 40, resetEpochSec: RESET + 3600 });
    expect(v?.configDir).toBeNull();
  });

  it('accepts one window alone', () => {
    const v = validateRateLimitsParams(sample({ rateLimits: { seven_day: { pct: 1, resets_at: RESET } } }));
    expect(v?.update.session).toBeUndefined();
    expect(v?.update.weekly?.pct).toBe(1);
  });

  it.each([
    ['negative pct', { five_hour: { pct: -1, resets_at: RESET } }],
    ['NaN-ish pct', { five_hour: { pct: 'x', resets_at: RESET } }],
    ['millisecond reset', { five_hour: { pct: 1, resets_at: RESET * 1000 } }],
    ['fractional reset', { five_hour: { pct: 1, resets_at: RESET + 0.5 } }],
    ['ISO reset', { five_hour: { pct: 1, resets_at: '2030-01-01T00:00:00Z' } }],
    ['no windows', {}],
  ])('rejects %s', (_label, rateLimits) => {
    expect(validateRateLimitsParams(sample({ rateLimits }))).toBeNull();
  });

  it('clamps pct above 100 instead of rejecting', () => {
    const v = validateRateLimitsParams(sample({ rateLimits: { five_hour: { pct: 104.2, resets_at: RESET } } }));
    expect(v?.update.session?.pct).toBe(100);
  });

  it('rejects oversized or malformed identity strings', () => {
    expect(validateRateLimitsParams(sample({ configDir: 'x'.repeat(5000) }))).toBeNull();
    expect(validateRateLimitsParams(sample({ configDir: 42 }))).toBeNull();
    expect(validateRateLimitsParams(sample({ ptyId: 'p'.repeat(200) }))).toBeNull();
  });
});

describe('resolveUsageTarget', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function mkdir(): string {
    const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-usage-rpc-')));
    tmpDirs.push(d);
    return d;
  }

  it('unset config dir → default profile', async () => {
    const r = await resolveUsageTarget(null, { listClaudeAccounts: () => [], defaultConfigDir: () => NOWHERE });
    expect(r).toEqual({ isDefault: true, accountIds: [] });
  });

  it('unmatched config dir → nothing', async () => {
    const acct = mkdir();
    const r = await resolveUsageTarget(path.resolve('/some/other/dir'), {
      listClaudeAccounts: () => [{ id: 'A', configDir: acct }],
      defaultConfigDir: () => NOWHERE,
    });
    expect(r).toEqual({ isDefault: false, accountIds: [] });
  });

  it('a symlinked spelling of a registered dir resolves to that account', async () => {
    const root = mkdir();
    const real = path.join(root, 'real');
    fs.mkdirSync(real);
    const link = path.join(root, 'link');
    fs.symlinkSync(real, link, 'junction'); // 'junction' needs no privilege on Windows; ignored elsewhere
    const r = await resolveUsageTarget(`${link}${path.sep}`, {
      listClaudeAccounts: () => [{ id: 'A', configDir: real }, { id: 'B', configDir: root }],
      defaultConfigDir: () => NOWHERE,
    });
    expect(r).toEqual({ isDefault: false, accountIds: ['A'] });
  });

  it('an explicit path equal to the default dir → default profile', async () => {
    const home = mkdir();
    const r = await resolveUsageTarget(home, { listClaudeAccounts: () => [], defaultConfigDir: () => home });
    expect(r.isDefault).toBe(true);
  });
});

describe('usage.rateLimits handler', () => {
  function setup(accounts: Array<{ id: string; configDir: string }> = [], applied = true) {
    let handler: ((p: Record<string, unknown>) => Promise<unknown>) | null = null;
    const router = { register: (_m: string, h: typeof handler) => { handler = h; } } as unknown as RpcRouter;
    const deps: UsageRpcDeps = {
      listClaudeAccounts: () => accounts,
      defaultConfigDir: () => NOWHERE,
      ingestDefault: vi.fn(() => applied),
      ingestAccount: vi.fn(() => applied),
    };
    registerUsageRpc(router, deps);
    return { call: (p: Record<string, unknown>) => (handler ? handler(p) : Promise.reject(new Error("not registered"))), deps };
  }

  it('routes an unset config dir to the default poller', async () => {
    const { call, deps } = setup();
    await expect(call(sample())).resolves.toEqual({ ok: true, applied: true });
    expect(deps.ingestDefault).toHaveBeenCalledTimes(1);
    expect(deps.ingestAccount).not.toHaveBeenCalled();
  });

  it('drops an unknown config dir and an invalid payload without ingesting', async () => {
    const { call, deps } = setup([{ id: 'A', configDir: ACCT_A }]);
    await expect(call(sample({ configDir: path.resolve('/acct/zzz') }))).resolves.toEqual({ ok: false, reason: 'unknown-account' });
    await expect(call(sample({ rateLimits: 'nope' }))).resolves.toEqual({ ok: false, reason: 'invalid' });
    expect(deps.ingestDefault).not.toHaveBeenCalled();
    expect(deps.ingestAccount).not.toHaveBeenCalled();
  });

  it('reports a sample no entry accepted as not applied', async () => {
    const { call } = setup([], false);
    await expect(call(sample())).resolves.toEqual({ ok: false, reason: 'not-applied' });
  });

  it('matches a registered dir however the caller spells it (trailing separator, case on Windows)', async () => {
    const { call, deps } = setup([{ id: 'A', configDir: ACCT_A }]);
    const spelled = process.platform === 'win32' ? `${ACCT_A.toUpperCase()}\\` : `${ACCT_A}/`;
    await call(sample({ configDir: spelled }));
    expect(deps.ingestAccount).toHaveBeenCalledWith('A', expect.anything());
  });

  it('gives panes on one account one 5-hour window, however their statusline spells the dir', async () => {
    resetPaneUsageLimitsForTest();
    const { call } = setup();
    // Unset (the default profile) and the default dir spelled out are one account.
    await call(sample({ ptyId: 'p-unset' }));
    await call(sample({ ptyId: 'p-spelled', configDir: `${NOWHERE}${path.sep}`, rateLimits: { five_hour: { pct: 91, resets_at: RESET } } }));
    const now = (RESET - 60) * 1000;
    expect(paneUsageWindows(now)).toEqual({
      'p-spelled': { pct: 91, resetsAt: RESET * 1000 },
      'p-unset': { pct: 91, resetsAt: RESET * 1000 },
    });
    resetPaneUsageLimitsForTest();
  });

  it('routes a registered config dir to that account', async () => {
    const { call, deps } = setup([{ id: 'A', configDir: ACCT_A }]);
    await call(sample({ configDir: ACCT_A }));
    expect(deps.ingestAccount).toHaveBeenCalledWith('A', expect.objectContaining({ session: { pct: 13, resetEpochSec: RESET } }));
  });
});

describe('usage.rateLimits from a WSL pane', () => {
  const FOLDER = 'C:\\Users\\me\\.wmux\\accounts\\claude-b';
  const TARGET = { distribution: 'Ubuntu', user: 'me' };
  const ENV = { CLAUDE_CONFIG_DIR: FOLDER, WMUX_WSL_ACCOUNT_KEYS: 'CLAUDE_CONFIG_DIR' };
  const HOME = `/home/me/.wmux/accounts/claude-${wslAccountHomeKey(FOLDER)}`;
  afterEach(() => resetPaneUsageLimitsForTest());

  type Pane = { target: typeof TARGET; env: Record<string, string> } | null | Error;
  function setup(pane: Pane | ((fresh: boolean) => Pane), wsl = true) {
    let handler: ((p: Record<string, unknown>) => Promise<unknown>) | null = null;
    const router = { register: (_m: string, h: typeof handler) => { handler = h; } } as unknown as RpcRouter;
    const deps: UsageRpcDeps = {
      listClaudeAccounts: () => [{ id: 'B', configDir: FOLDER.toUpperCase() }],
      defaultConfigDir: () => NOWHERE,
      ingestDefault: vi.fn(() => true),
      ingestAccount: vi.fn(() => true),
      isWslPane: () => wsl,
      wslPane: vi.fn(async (_id: string, fresh: boolean) => {
        const p = typeof pane === 'function' ? pane(fresh) : pane;
        if (p instanceof Error) throw p;
        return p;
      }),
    };
    registerUsageRpc(router, deps);
    return { call: (p: Record<string, unknown>) => (handler ? handler(p) : Promise.reject(new Error('not registered'))), deps };
  }

  it('takes the pane\'s own account home as the pane\'s window only, never the account\'s (Windows) entry', async () => {
    // The distro home may be signed in to another login than the account's
    // Windows folder: its numbers must not move what rotation and the reserve read.
    const { call, deps } = setup({ target: TARGET, env: ENV });
    await expect(call(sample({ configDir: HOME }))).resolves.toEqual({ ok: true, applied: true });
    expect(deps.ingestAccount).not.toHaveBeenCalled();
    expect(deps.ingestDefault).not.toHaveBeenCalled();
    expect(Object.keys(paneUsageWindows())).toEqual(['pty-1']);
  });

  it('maps nothing for another home, another user, a failed lookup, or an unmarked env', async () => {
    const cases: Array<[Pane, string]> = [
      [{ target: TARGET, env: ENV }, '/home/me/.claude'],
      [{ target: { ...TARGET, user: 'other' }, env: ENV }, HOME],
      [{ target: TARGET, env: { CLAUDE_CONFIG_DIR: FOLDER } }, HOME],
      [null, HOME],
      [new Error('daemon gone'), HOME],
    ];
    for (const [pane, configDir] of cases) {
      const { call, deps } = setup(pane);
      await expect(call(sample({ configDir }))).resolves.toEqual({ ok: false, reason: 'unknown-account' });
      expect(deps.ingestAccount).not.toHaveBeenCalled();
      expect(deps.ingestDefault).not.toHaveBeenCalled();
    }
  });

  it('asks again past a kept lookup when the sample names another home (the pane was rebound)', async () => {
    const OTHER = 'C:\\Users\\me\\.wmux\\accounts\\claude-c';
    const homeC = `/home/me/.wmux/accounts/claude-${wslAccountHomeKey(OTHER)}`;
    const { call, deps } = setup((fresh) => ({ target: TARGET, env: fresh ? { ...ENV, CLAUDE_CONFIG_DIR: OTHER } : ENV }));
    await expect(call(sample({ configDir: homeC }))).resolves.toEqual({ ok: true, applied: true });
    expect(deps.wslPane).toHaveBeenNthCalledWith(1, 'pty-1', false);
    expect(deps.wslPane).toHaveBeenNthCalledWith(2, 'pty-1', true);
    // A match needs no second look.
    const again = setup({ target: TARGET, env: ENV });
    await again.call(sample({ configDir: HOME }));
    expect(again.deps.wslPane).toHaveBeenCalledTimes(1);
  });

  it('asks the WSL lookup with the sample\'s config dir (a pane main has not seen yet is judged by it)', async () => {
    const { call, deps } = setup({ target: TARGET, env: ENV });
    const isWslPane = vi.fn(() => true);
    deps.isWslPane = isWslPane;
    await call(sample({ configDir: HOME }));
    expect(isWslPane).toHaveBeenCalledWith('pty-1', HOME);
  });

  it('an unset config dir is the distro\'s own sign-in: no account and not the Windows default, only the pane\'s window', async () => {
    const { call, deps } = setup({ target: TARGET, env: ENV });
    await expect(call(sample())).resolves.toEqual({ ok: false, reason: 'unknown-account' });
    expect(deps.ingestDefault).not.toHaveBeenCalled();
    expect(deps.ingestAccount).not.toHaveBeenCalled();
    expect(Object.keys(paneUsageWindows())).toEqual(['pty-1']);
  });

  it('a native pane never asks the daemon, and its unset config dir is the default profile', async () => {
    const native = setup({ target: TARGET, env: ENV }, false);
    await native.call(sample({ configDir: HOME }));
    await expect(native.call(sample())).resolves.toEqual({ ok: true, applied: true });
    expect(native.deps.wslPane).not.toHaveBeenCalled();
    expect(native.deps.ingestAccount).not.toHaveBeenCalled();
    expect(native.deps.ingestDefault).toHaveBeenCalledTimes(1);
  });
});
