// Quota switching for a launch in WSL: decided from the WSL homes' own
// readings (wslAccountState.ts), never the Windows entries, and the reverse
// for a native launch.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountRotationService, type AccountRotationDeps } from '../AccountRotationService';
import type { Account } from '../accountStore';
import type { AccountUsageEntry } from '../AccountUsageService';
import { WSL_CANDIDATE_MAX_AGE_MS, WslAccountState } from '../wslAccountState';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const RESET_SEC = Math.floor((NOW + 3 * 3600_000) / 1000);
const UBUNTU_ME = { distribution: 'Ubuntu', user: 'me' };
const acct = (id: string, vendor: 'claude' | 'codex' = 'claude'): Account => ({ id, name: id, vendor, configDir: `/acc/${id}`, createdAt: 0 });
const sample = (pct: number) => ({ session: { pct, resetEpochSec: RESET_SEC }, weekly: { pct: 10, resetEpochSec: RESET_SEC + 86_400 } });

describe('AccountRotationService for a WSL launch', () => {
  let dataDir: string;
  let clock: number;
  let state: WslAccountState;
  let windowsEntries: AccountUsageEntry[];
  let refreshForLaunch: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;

  const make = (accounts: Account[], extra: AccountRotationDeps = {}) => new AccountRotationService({
    dataDir,
    now: () => clock,
    accounts: () => accounts,
    getBinding: (_ws, vendor) => (vendor === 'claude' ? 'a' : 'ca'),
    claudeUsage: { getAll: () => windowsEntries, refreshForLaunch },
    readCodexLimits: async () => null,
    dirExists: () => true,
    wslReading: (id, place, role) => state.reading(id, place, role),
    ...extra,
  });

  beforeEach(() => {
    clock = NOW;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-rotation-wsl-'));
    state = new WslAccountState(() => clock);
    windowsEntries = [];
    refreshForLaunch = vi.fn(async () => undefined);
  });
  afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

  it('(a) an exhausted bound WSL account switches on a 20-minute-old reading, before its reset', async () => {
    const s = make([acct('a'), acct('b')]);
    await s.setEnabled('claude', true);
    state.noteSample('a', UBUNTU_ME, sample(100));
    clock = NOW + 20 * 60_000;
    state.noteSample('b', UBUNTU_ME, sample(10));
    expect(await s.prepareLaunch('claude', 'ws', { wsl: UBUNTU_ME })).toMatchObject({ kind: 'switch', accountId: 'b' });
    // Never the Windows probe: a WSL home has no Windows credential to refresh.
    expect(refreshForLaunch).not.toHaveBeenCalled();
  });

  it('a stale candidate is never a target', async () => {
    const s = make([acct('a'), acct('b')]);
    await s.setEnabled('claude', true);
    state.noteSample('b', UBUNTU_ME, sample(10));
    clock = NOW + WSL_CANDIDATE_MAX_AGE_MS + 1;
    state.noteSample('a', UBUNTU_ME, sample(100));
    expect(await s.prepareLaunch('claude', 'ws', { wsl: UBUNTU_ME })).toEqual({ kind: 'keep' });
  });

  it('(b) the same distro as another user reads nothing; each user reads its own key', async () => {
    const s = make([acct('a'), acct('b')]);
    await s.setEnabled('claude', true);
    state.noteSample('a', UBUNTU_ME, sample(100));
    state.noteSample('b', UBUNTU_ME, sample(10));
    expect(await s.prepareLaunch('claude', 'ws', { wsl: { distribution: 'Ubuntu', user: 'other' } })).toEqual({ kind: 'keep' });
    // The distro name compares in any case, as the daemon's target does.
    expect(await s.prepareLaunch('claude', 'ws', { wsl: { distribution: 'ubuntu', user: 'me' } })).toMatchObject({ kind: 'switch', accountId: 'b' });
  });

  it('an unknown place, or Codex in WSL, keeps the launch as it is', async () => {
    const s = make([acct('a'), acct('b'), acct('ca', 'codex'), acct('cb', 'codex')]);
    await s.setEnabled('claude', true);
    await s.setEnabled('codex', true);
    state.noteSample('a', UBUNTU_ME, sample(100));
    state.noteSample('b', UBUNTU_ME, sample(10));
    expect(await s.prepareLaunch('claude', 'ws', { wsl: null })).toEqual({ kind: 'keep' });
    expect(await s.prepareLaunch('codex', 'ws', { wsl: UBUNTU_ME })).toEqual({ kind: 'keep' });
  });

  it('a WSL-only reading never moves a native launch, and a Windows refresh that finds no credential leaves the WSL launch its reading', async () => {
    const s = make([acct('a'), acct('b')]);
    await s.setEnabled('claude', true);
    // The Windows side: a exhausted, b has no credential (token-missing).
    windowsEntries = [
      { accountId: 'a', status: 'ok', snapshot: { sessionPct: 100, sessionResetEpochSec: RESET_SEC, fetchedAtMs: NOW }, fetchedAtMs: NOW, lastError: null },
      { accountId: 'b', status: 'token-missing', snapshot: null, fetchedAtMs: NOW, lastError: null },
    ];
    state.noteSample('b', UBUNTU_ME, sample(10));
    expect(await s.prepareLaunch('claude', 'ws')).not.toMatchObject({ kind: 'switch' });
    state.noteSample('a', UBUNTU_ME, sample(100));
    expect(await s.prepareLaunch('claude', 'ws', { wsl: UBUNTU_ME })).toMatchObject({ kind: 'switch', accountId: 'b' });
    // Settings rows and cachedVerdict stay the Windows side's.
    expect((await s.cachedVerdict('b'))?.remaining ?? null).toBeNull();
  });
});
