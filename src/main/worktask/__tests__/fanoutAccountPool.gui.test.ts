// A fan-out a person starts (the dialog, the Git page's hand-off, hand out)
// picks its workers' accounts from the pool as the wire does: WSL task panes
// on their homes there, and a fall to the caller's account said once and why.
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WORKER_SLOTS_FILENAME, WorkerSlots } from '../../factory/workerSlots';
import { guiFanOutAccountPick, learnPoolStartPlaces, pickFromPool, type FanoutAccountPoolHost, type PickDeps, type PreparedPool } from '../fanoutAccountPool';
import type { Account } from '../../account/accountStore';
import { DEFAULT_FANOUT_ACCOUNT_POOL_SETTINGS } from '../../../shared/fanoutAccountPool';
import { WslAccountState } from '../../account/wslAccountState';
import { trackedTempDir } from '../../../test-utils/trackedTempDir';

const BOX = { distribution: 'wmuxbox', user: 'box' };
const reset = Math.floor(Date.now() / 1000) + 3600;

function setup(over: { signedIn?: string[]; place?: typeof BOX; wsl?: boolean; held?: boolean; sessions?: (pool: PreparedPool) => unknown[] } = {}) {
  // Signed out on Windows: no Windows member; A and B are WSL members, C has no home in the distro.
  const pool: PreparedPool = {
    settings: { ...DEFAULT_FANOUT_ACCOUNT_POOL_SETTINGS, enabled: true },
    group: 'R',
    members: over.held ? [{ id: 'acc-n', configDir: trackedTempDir('wmux-acc-n-') }] : [],
    wslMembers: ['acc-a', 'acc-b', 'acc-c'].map((id) => ({ id, configDir: trackedTempDir(`wmux-${id}-`) })),
  };
  const wslState = new WslAccountState();
  for (const id of over.signedIn ?? ['acc-a', 'acc-b']) wslState.noteSample(id, BOX, { session: { pct: 10, resetEpochSec: reset } });
  const slots = new WorkerSlots(path.join(trackedTempDir('wmux-slots-'), 'factory', WORKER_SLOTS_FILENAME), () => [], () => undefined);
  slots.load();
  const prepare = vi.fn(async () => pool);
  const daemonHost = { daemonSessions: async () => over.sessions?.(pool) ?? [] } as unknown as FanoutAccountPoolHost;
  const accounts = () => (pool.wslMembers ?? []).map((m) => ({ id: m.id, vendor: 'claude', configDir: m.configDir })) as unknown as Account[];
  const learn = vi.fn(async () => { if (over.sessions) await learnPoolStartPlaces({ host: daemonHost, state: wslState, accounts }); });
  const log = vi.fn();
  const notifyFallback = vi.fn();
  const untilMs = Date.now() + 3_600_000;
  const pick = (p: PreparedPool, d: PickDeps) => pickFromPool(p, { ...d, host: null, slots, workerMayRun: () => true, holdFor: () => (over.held ? { untilMs } : null) });
  const accountPick = guiFanOutAccountPick('ws-1', (k) => k !== 9, {
    prepare, learn, log, notifyFallback, pick, wslState,
    paneShell: () => ({ wsl: over.wsl ?? true, distro: 'wmuxbox' }),
    defaultPlace: () => ('place' in over ? over.place : BOX),
  });
  return { accountPick, prepare, learn, log, notifyFallback, slots, wslState };
}

describe('a GUI fan-out\'s account pick', () => {
  it('spreads task panes that start WSL over the homes signed in there', async () => {
    const h = setup();
    const picks: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      await h.accountPick.prepare({ index: i });
      const p = h.accountPick.pick({ index: i, cwd: `C:\\wmux\\worktrees\\t${i}` });
      picks.push(p);
      if (p && 'accountId' in p) h.slots.beginLaunch({ taskId: `wt-${i}`, origin: 'owner', ownerWorkspaceId: 'ws-1', accountId: p.accountId, wslPlace: p.wslPlace ?? null });
    }
    expect(picks).toEqual([
      { accountId: 'acc-a', wslPlace: BOX }, { accountId: 'acc-b', wslPlace: BOX },
      { accountId: 'acc-a', wslPlace: BOX }, { accountId: 'acc-b', wslPlace: BOX },
    ]);
    // One read of the pool for the batch, and the start places learned after it.
    expect(h.prepare).toHaveBeenCalledTimes(1);
    expect(h.learn).toHaveBeenCalledTimes(1);
    expect(h.notifyFallback).not.toHaveBeenCalled();
  });

  it('after an app restart, picks a home whose reattached pane still runs claude, with no turn or sample since', async () => {
    // The daemon kept B's pane: same process, claude idle on B's home (no redraw, so no sample comes).
    const h = setup({
      signedIn: [],
      sessions: (pool) => [{
        id: 'pty-b', state: 'attached', liveAgent: 'claude', wslTarget: BOX,
        env: { CLAUDE_CONFIG_DIR: pool.wslMembers![1].configDir!, WMUX_WSL_ACCOUNT_KEYS: 'CLAUDE_CONFIG_DIR' },
      }],
    });
    await h.accountPick.prepare({ index: 0 });
    expect(h.accountPick.pick({ index: 0, cwd: 'C:\\wt' })).toEqual({ accountId: 'acc-b', wslPlace: BOX });
    expect(h.notifyFallback).not.toHaveBeenCalled();
  });

  it('a worker of another agent gets no pool account', async () => {
    const h = setup();
    await h.accountPick.prepare({ index: 9 });
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.accountPick.pick({ index: 9, cwd: 'C:\\wt' })).toBeNull();
  });

  it('with no home signed in there, runs on the caller\'s account, says so and logs why', async () => {
    const h = setup({ signedIn: [] });
    await h.accountPick.prepare({ index: 0 });
    expect(h.accountPick.pick({ index: 0, cwd: 'C:\\wt' })).toBeNull();
    expect(h.notifyFallback).toHaveBeenCalledTimes(1);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('[fanout-pool] task 1 runs on the caller\'s account: no pool account has a usable sign-in on its home in WSL wmuxbox as box'));
  });

  it('with no start place known for the distro, runs on the caller\'s account and logs why', async () => {
    const h = setup({ place: undefined });
    await h.accountPick.prepare({ index: 0 });
    expect(h.accountPick.pick({ index: 0, cwd: 'C:\\wt' })).toBeNull();
    expect(h.notifyFallback).toHaveBeenCalledTimes(1);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('no start place is known in this run for WSL wmuxbox'));
  });

  it('a click is never refused by the pool: every native account held runs on the caller\'s account', async () => {
    const h = setup({ wsl: false, held: true });
    await h.accountPick.prepare({ index: 0 });
    expect(h.accountPick.pick({ index: 0, cwd: 'C:\\wt' })).toBeNull();
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('no pool account is free (held)'));
  });
});
