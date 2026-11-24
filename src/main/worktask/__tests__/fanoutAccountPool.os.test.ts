// The fan-out account pool (desktop): eligibility, the spread of parallel
// launches, and what a task pane's create takes from its launch record.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WORKER_SLOTS_FILENAME, WorkerSlots, beginPaneRelaunch, paneTaskPooled, setWorkerSlotsForTests } from '../../factory/workerSlots';
import { setUsageReserve } from '../../usage/usageReserve';
import {
  claudeFolderSignedIn,
  loadFanoutAccountPoolSettings,
  openWorkersByAccount,
  openWorkersOn,
  pickFromPool,
  poolCandidates,
  poolAccountForCreate,
  poolAllHeld,
  poolAccountOfPaneEnv,
  poolReserveHeldForWorkspace,
  poolAccountOfLivePane,
  poolCreateReserveRefusal,
  registerPoolCreateReserveHold,
  setFanoutAccountPoolHost,
  poolRelaunchRefusal,
  heldHomeKey,
  poolHeldInPlace,
  poolUsageKey,
  notePoolCallerFallback,
  poolFallsBackToCaller,
  preparePool,
  resetFanoutAccountPoolForTests,
  setFanoutAccountPoolSettings,
  type FanoutAccountPoolHost,
  type PreparedPool,
} from '../fanoutAccountPool';
import { DEFAULT_FANOUT_ACCOUNT_POOL_SETTINGS, POOL_DEFAULT_ACCOUNT, type FanoutAccountPoolSettings } from '../../../shared/fanoutAccountPool';
import type { Account } from '../../account/accountStore';
import { WslAccountState, wslStateKey } from '../../account/wslAccountState';
import { commandLineBinding } from '../../../daemon/transcript/agentCommandLineBinding';
import { trackedTempDir } from '../../../test-utils/trackedTempDir';
import { workerSlotStores } from '../../../test-utils/workerSlotStores';

const slotStores = workerSlotStores();
const tmp = (): string => trackedTempDir('wmux-pool-');

function slots(dir = tmp()): WorkerSlots {
  const s = new WorkerSlots(path.join(dir, 'factory', WORKER_SLOTS_FILENAME), () => [], () => undefined);
  s.load();
  slotStores.track(s);
  return s;
}

const on: FanoutAccountPoolSettings = { ...DEFAULT_FANOUT_ACCOUNT_POOL_SETTINGS, enabled: true };
const acct = (id: string, group?: string): Account => ({ id, name: id, vendor: 'claude', configDir: `/acc/${id}`, createdAt: 1, ...(group ? { group } : {}) });

function host(over: Partial<FanoutAccountPoolHost> = {}): FanoutAccountPoolHost {
  return {
    daemonConnected: () => true,
    claudeUsage: () => [],
    defaultSnapshot: () => null,
    hookDriftIds: async () => new Set(),
    isUnc: (d) => d.startsWith('//'),
    ...over,
  };
}

afterEach(() => {
  resetFanoutAccountPoolForTests();
  setWorkerSlotsForTests(null);
  setUsageReserve(null);
  vi.restoreAllMocks();
  slotStores.settle();
});

describe('preparePool', () => {
  it('off reads nothing: no account, binding, folder or sign-in', async () => {
    const touched = vi.fn(() => { throw new Error('read while off'); });
    const pool = await preparePool('ws-owner', {
      settings: () => DEFAULT_FANOUT_ACCOUNT_POOL_SETTINGS,
      host: host({ daemonConnected: touched, claudeUsage: touched, hookDriftIds: touched }),
      accounts: touched, binding: touched, dirOk: touched, signedIn: touched, vaultSignIn: touched,
    });
    expect(pool).toBeNull();
    expect(touched).not.toHaveBeenCalled();
  });

  it('is off without the daemon', async () => {
    expect(await preparePool('ws', { settings: () => on, host: host({ daemonConnected: () => false }), accounts: () => [acct('a')] })).toBeNull();
  });

  it('asks for a reading of each member the usage service has none for', async () => {
    const probeUsage = vi.fn();
    await preparePool('ws', { settings: () => on, host: host({ probeUsage }), accounts: () => [acct('a'), acct('b')], binding: () => undefined, dirOk: () => true, signedIn: async () => true });
    expect(probeUsage.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
  });

  it('keeps only signed-in local accounts of the group, by metadata, and names why the rest are out', async () => {
    const log: string[] = [];
    const accounts = [acct('ok'), acct('unc'), acct('gone'), acct('drift'), acct('vault'), acct('out'), acct('other', 'work'), { ...acct('cx'), vendor: 'codex' as const }];
    accounts[1].configDir = '//server/share';
    const pool = await preparePool('ws', {
      settings: () => on,
      host: host({ hookDriftIds: async () => new Set(['drift']) }),
      accounts: () => accounts,
      binding: () => undefined,
      dirOk: (d) => d !== '/acc/gone',
      signedIn: async (d) => d === '/acc/ok' || d === '/acc/drift',
      vaultSignIn: (id) => id === 'vault',
      log: (l) => log.push(l),
    });
    expect(pool?.group).toBe('');
    expect(pool?.members).toEqual([{ id: 'ok', configDir: '/acc/ok' }, { id: POOL_DEFAULT_ACCOUNT, configDir: null }]);
    expect(log.join('\n')).toMatch(/unc \(unc\).*gone \(missing-folder\).*drift \(hook-drift\).*vault \(vault-only\).*out \(signed-out\)/);
  });

  it('never puts an account signed in only inside WSL into a native pane', async () => {
    const log: string[] = [];
    // One registered by its WSL home (a UNC path), one by a Windows folder
    // whose only sign-in lives in the distro (no .credentials.json here).
    const unc = { ...acct('wsl-unc'), configDir: '\\\\wsl.localhost\\Ubuntu\\home\\u\\.claude-work' };
    const win = { ...acct('wsl-win'), configDir: tmp() };
    const pool = await preparePool('ws', {
      settings: () => ({ ...on, includeDefaultLogin: false }),
      host: host({ isUnc: (d) => /^[\\/]{2}/.test(d) }),
      accounts: () => [unc, win],
      binding: () => undefined,
      dirOk: () => true,
      signedIn: (d) => claudeFolderSignedIn(d, 'win32'),
      vaultSignIn: () => false,
      log: (l) => log.push(l),
    });
    expect(pool?.members).toEqual([]);
    expect(log.join('\n')).toMatch(/wsl-unc \(unc\).*wsl-win \(signed-out\)/);
    // A WSL pane may still pick the Windows-folder one, on its home's own evidence (never the UNC one).
    expect(pool?.wslMembers).toEqual([{ id: 'wsl-win', configDir: win.configDir }]);
  });

  it('a caller bound to an account picks only in its group, without the default login', async () => {
    const pool = await preparePool('ws', {
      settings: () => ({ ...on, group: 'personal' }),
      host: host(),
      accounts: () => [acct('w1', 'work'), acct('w2', 'work'), acct('p1', 'personal'), acct('u1')],
      binding: () => 'w1',
      dirOk: () => true,
      signedIn: async () => true,
    });
    expect(pool?.members.map((m) => m.id)).toEqual(['w1', 'w2']);
  });
});

describe('the pick and its booking', () => {
  const pool: PreparedPool = { settings: on, group: '', members: [{ id: 'a', configDir: '/acc/a' }, { id: 'b', configDir: '/acc/b' }, { id: POOL_DEFAULT_ACCOUNT, configDir: null }] };
  const deps = (s: WorkerSlots, mayRun: (taskId: string) => boolean = () => true) => ({ host: host(), slots: s, holdFor: () => null, workerMayRun: mayRun, dirOk: () => true });

  it('spreads N parallel launches evenly over the pool, each booked as it is picked', () => {
    const s = slots();
    for (let i = 0; i < 9; i++) {
      const picked = pickFromPool(pool, deps(s));
      if (picked.kind !== 'pick') throw new Error('no pick');
      s.beginLaunch({ taskId: `t${i}`, origin: 'owner', ownerWorkspaceId: 'ws', accountId: picked.accountId });
    }
    expect(Object.fromEntries(openWorkersByAccount(s, () => true))).toEqual({ a: 3, b: 3, [POOL_DEFAULT_ACCOUNT]: 3 });
  });

  it('does not count released launches or launched ones whose worker is gone', () => {
    const s = slots();
    const g1 = s.beginLaunch({ taskId: 't1', origin: 'owner', ownerWorkspaceId: 'ws', accountId: 'a' }).gen;
    s.released('t1', g1);
    const g2 = s.beginLaunch({ taskId: 't2', origin: 'owner', ownerWorkspaceId: 'ws', accountId: 'a' }).gen;
    s.launched('t2', g2, 'ws-t2', 'pty-2');
    const g3 = s.beginLaunch({ taskId: 't3', origin: 'owner', ownerWorkspaceId: 'ws', accountId: 'a' }).gen;
    s.launched('t3', g3, 'ws-t3', 'pty-3');
    expect(openWorkersByAccount(s, (id) => id !== 't2').get('a')).toBe(1);
    // A launching record left by an earlier run (a crash) starts nothing.
    const dir = tmp();
    const before = slots(dir);
    before.beginLaunch({ taskId: 't9', origin: 'owner', ownerWorkspaceId: 'ws', accountId: 'b' });
    before.settlePendingWriteForTests();
    expect(openWorkersByAccount(slots(dir), () => true).get('b')).toBeUndefined();
  });

  it('counts a launched worker only while the holder set lists it as running', () => {
    const s = slots();
    const g = s.beginLaunch({ taskId: 'done', origin: 'owner', ownerWorkspaceId: 'ws', accountId: 'a' }).gen;
    s.launched('done', g, 'ws-done', 'pty-d');
    s.beginLaunch({ taskId: 'starting', origin: 'owner', ownerWorkspaceId: 'ws', accountId: 'a' });
    // No holder set to read (none installed yet): every launched worker still
    // counts, an unknown never frees its account.
    const [a] = poolCandidates({ ...pool, members: [{ id: 'a', configDir: '/acc/a' }] }, { host: host(), slots: s, holdFor: () => null, dirOk: () => true });
    expect(a.open).toBe(2);
    // A holder set that no longer lists the ended task frees its account.
    expect(openWorkersByAccount(s, (id) => id !== 'done').get('a')).toBe(1);
  });

  it('the reserve stops the fan-out only when it holds every member, naming the first to free up', () => {
    expect(poolAllHeld(pool, (id) => ({ account: id, untilMs: id === 'b' ? 5 : 9 }))).toEqual({ account: 'b', untilMs: 5 });
    expect(poolAllHeld(pool, (id) => (id === 'a' ? null : { account: id, untilMs: 5 }))).toBeNull();
    const held = pickFromPool(pool, { ...deps(slots()), holdFor: (id) => (id === 'b' ? null : { untilMs: 5 }) });
    expect(held).toEqual({ kind: 'pick', accountId: 'b' });
  });
});

describe('poolAccountForCreate', () => {
  const launch = (accountId?: string) => () => ({ gen: 2, state: 'launching', ...(accountId ? { accountId } : {}) });
  const opts = (over: Record<string, unknown> = {}) => ({ fanoutTaskOf: 'ws-owner', fanoutLaunch: { taskId: 't1', gen: 2 }, initialCommand: 'claude "$(cat p)"', ...over });

  it('takes the account from the launch record, never from the renderer', () => {
    expect(poolAccountForCreate(opts(), launch('a'))).toEqual({ kind: 'account', accountId: 'a' });
    expect(poolAccountForCreate(opts({ accountId: 'a' }), launch('a'))).toEqual({ kind: 'account', accountId: 'a' });
    expect(() => poolAccountForCreate(opts({ accountId: 'b' }), launch('a'))).toThrow(/account its launch recorded/);
    // A forged account on a default-login pick is refused too.
    expect(() => poolAccountForCreate(opts({ accountId: 'b' }), launch(POOL_DEFAULT_ACCOUNT))).toThrow(/account its launch recorded/);
    expect(poolAccountForCreate(opts(), launch(POOL_DEFAULT_ACCOUNT))).toEqual({ kind: 'default' });
  });

  it('a create with no pool record runs as before', () => {
    expect(poolAccountForCreate(opts({ accountId: 'x' }), launch())).toEqual({ kind: 'none' });
    expect(poolAccountForCreate({ initialCommand: 'claude', accountId: 'x' }, launch('a'))).toEqual({ kind: 'none' });
    expect(poolAccountForCreate(opts({ fanoutLaunch: { taskId: 't1', gen: 1 } }), launch('a'))).toEqual({ kind: 'none' });
  });

  it('a WSL task pane keeps today\'s behaviour: its account is released, the default login too', () => {
    // Flagged, so the create checks the reserve on the caller's account, as before the pool.
    expect(poolAccountForCreate(opts(), launch('a'), { wsl: true })).toEqual({ kind: 'release', taskId: 't1', gen: 2, wsl: true });
    expect(poolAccountForCreate(opts(), launch(POOL_DEFAULT_ACCOUNT), { wsl: true })).toEqual({ kind: 'release', taskId: 't1', gen: 2, wsl: true });
    expect(poolAccountForCreate(opts({ initialCommand: 'codex' }), launch('a'), { wsl: true })).toEqual({ kind: 'release', taskId: 't1', gen: 2 });
    expect(poolAccountForCreate(opts(), launch('a'), { wsl: false })).toEqual({ kind: 'account', accountId: 'a' });
  });

  it('a task switched to codex or agy carries no account', () => {
    expect(poolAccountForCreate(opts({ initialCommand: 'codex "$(cat p)"' }), launch('a'))).toEqual({ kind: 'release', taskId: 't1', gen: 2 });
    expect(poolAccountForCreate(opts({ initialCommand: 'agy' }), launch('a'))).toEqual({ kind: 'release', taskId: 't1', gen: 2 });
  });

  it('a released account adds nothing to the open-worker counts', () => {
    const s = slots();
    const { gen } = s.beginLaunch({ taskId: 't1', origin: 'owner', ownerWorkspaceId: 'ws', accountId: 'a' });
    const d = poolAccountForCreate(opts({ fanoutLaunch: { taskId: 't1', gen }, initialCommand: 'codex' }), (id) => s.launchOf(id));
    if (d.kind !== 'release') throw new Error('not released');
    expect(s.setLaunchAccount(d.taskId, d.gen, undefined)).toBe(true);
    expect(s.launchOf('t1')).not.toHaveProperty('accountId');
    expect(openWorkersByAccount(s, () => true).size).toBe(0);
  });
});

describe('launch records', () => {
  it('a relaunch in the same pane keeps its account; a new launch without one has none; off writes no key', () => {
    const dir = tmp();
    const s = slots(dir);
    const g1 = s.beginLaunch({ taskId: 't1', origin: 'owner', ownerWorkspaceId: 'ws', accountId: 'a' }).gen;
    s.launched('t1', g1, 'ws-t1', 'pty-1');
    s.beginLaunch({ taskId: 't1', origin: 'owner', ownerWorkspaceId: 'ws', pane: { sessionId: 'pty-1', workspaceId: 'ws-t1' } });
    expect(s.launchOf('t1')?.accountId).toBe('a');
    s.beginLaunch({ taskId: 't2', origin: 'owner', ownerWorkspaceId: 'ws' });
    s.settlePendingWriteForTests();
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'factory', WORKER_SLOTS_FILENAME), 'utf8')) as { tasks: Array<Record<string, unknown>> };
    expect(file.tasks.find((t) => t.taskId === 't2')).not.toHaveProperty('accountId');
    expect(slots(dir).launchOf('t1')?.accountId).toBe('a');
  });
});

describe('poolRelaunchRefusal', () => {
  const base = { host: host(), slots: slots(), holdFor: () => null, workerMayRun: () => true, dirOk: () => true, poolOn: () => true, account: (id: string) => (id === 'a' ? acct('a') : undefined) };
  it('lets a respawn back on its account, and holds it while that account is out, held, gone or missing', () => {
    expect(poolRelaunchRefusal('a', base)).toBeNull();
    const spent = { accountId: 'a', status: 'ok' as const, snapshot: { sessionPct: 100, sessionResetEpochSec: Math.floor(Date.now() / 1000) + 600, fetchedAtMs: Date.now() } as never, fetchedAtMs: Date.now(), lastError: null };
    expect(poolRelaunchRefusal('a', { ...base, host: host({ claudeUsage: () => [spent] }) })).toMatch(/out of quota/);
    expect(poolRelaunchRefusal('a', { ...base, holdFor: () => ({ untilMs: Date.now() + 1000 }) })).toMatch(/usage reserve holds/);
    expect(poolRelaunchRefusal('a', { ...base, dirOk: () => false })).toMatch(/folder .* is missing/);
    expect(poolRelaunchRefusal('gone', base)).toMatch(/no longer registered/);
    expect(poolRelaunchRefusal(POOL_DEFAULT_ACCOUNT, base)).toBeNull();
    // At the per-account limit: held, not counting the task's own last launch.
    const s = slots();
    s.beginLaunch({ taskId: 'other', origin: 'owner', ownerWorkspaceId: 'ws', accountId: 'a' });
    s.beginLaunch({ taskId: 'mine', origin: 'owner', ownerWorkspaceId: 'ws', accountId: 'a' });
    const capped = { ...base, slots: s, settings: () => ({ ...on, maxWorkersPerAccount: 2 }) };
    expect(poolRelaunchRefusal('a', { ...capped, taskId: 'mine' })).toBeNull();
    expect(poolRelaunchRefusal('a', { ...capped, taskId: 'mine', settings: () => ({ ...on, maxWorkersPerAccount: 1 }) })).toMatch(/runs its most workers \(1\)/);
    expect(poolRelaunchRefusal('a', { ...capped, taskId: 'third' })).toMatch(/runs its most workers \(2\)/);
    // The pool turned off: the account's quota and reserve no longer hold it back.
    expect(poolRelaunchRefusal('a', { ...base, poolOn: () => false, holdFor: () => ({ untilMs: Date.now() + 1000 }) })).toBeNull();
    expect(poolRelaunchRefusal('gone', { ...base, poolOn: () => false })).toMatch(/no longer registered/);
  });
});

describe('settings file', () => {
  it('is read like account-rotation.json and written field by field', async () => {
    const dir = tmp();
    expect(loadFanoutAccountPoolSettings(dir)).toEqual(DEFAULT_FANOUT_ACCOUNT_POOL_SETTINGS);
    expect(await setFanoutAccountPoolSettings({ enabled: true, group: 'work', bogus: 1 }, dir)).toEqual({ ...DEFAULT_FANOUT_ACCOUNT_POOL_SETTINGS, enabled: true, group: 'work' });
    resetFanoutAccountPoolForTests();
    expect(loadFanoutAccountPoolSettings(dir).group).toBe('work');
  });
});

describe('claudeFolderSignedIn (presence only)', () => {
  it('a non-empty .credentials.json counts; an empty or missing one does not', async () => {
    const dir = tmp();
    expect(await claudeFolderSignedIn(dir, 'linux')).toBe(false);
    fs.writeFileSync(path.join(dir, '.credentials.json'), '');
    expect(await claudeFolderSignedIn(dir, 'linux')).toBe(false);
    fs.writeFileSync(path.join(dir, '.credentials.json'), 'x');
    expect(await claudeFolderSignedIn(dir, 'win32')).toBe(true);
  });
});

describe('a pool account\'s transcript', () => {
  it('binds the transcript under the account folder, not a decoy under HOME/.claude', () => {
    const home = tmp();
    const account = tmp();
    const id = '0f9d8c7b-6a5e-4d3c-8b2a-1f0e9d8c7b6a';
    const write = (root: string) => {
      const dir = path.join(root, 'projects', '-work');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${id}.jsonl`), '{}\n');
    };
    write(path.join(home, '.claude'));
    write(account);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      // The env withPoolAccount gives the pane, as the daemon keeps it in meta.env.
      const b = commandLineBinding('claude', `claude --resume ${id}`, '/work', { CLAUDE_CONFIG_DIR: account }, { now: 1 });
      expect(b?.transcriptPath).toBe(path.join(account, 'projects', '-work', `${id}.jsonl`));
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('a relaunch typed into a pool task\'s pane', () => {
  /** The pool on, in a scratch wmux dir, with the reserve holding `held`. */
  async function poolOn(held: string[]): Promise<WorkerSlots> {
    vi.spyOn(os, 'homedir').mockReturnValue(tmp());
    setFanoutAccountPoolHost(host());
    await setFanoutAccountPoolSettings({ enabled: true });
    setUsageReserve({ holdFor: (account: string) => (held.includes(account) ? { account, untilMs: Date.now() + 60_000 } : null) } as never);
    const s = slots();
    setWorkerSlotsForTests(s);
    const { gen } = s.beginLaunch({ taskId: 't', origin: 'bot', botId: 'bot-1', ownerWorkspaceId: 'ws-owner', accountId: POOL_DEFAULT_ACCOUNT });
    s.launched('t', gen, 'ws-t', 'pty-t');
    return s;
  }

  it('a codex or agy line takes no account, so it counts on none and is never held', async () => {
    const s = await poolOn([POOL_DEFAULT_ACCOUNT]);
    beginPaneRelaunch('pty-t', { line: 'codex resume', byPerson: false })?.(true);
    expect(s.launchOf('t')).not.toHaveProperty('accountId');
    expect(openWorkersByAccount(s, () => true).size).toBe(0);
  });

  it('a Claude line wmux types on its own is held while its account is; a person\'s is not', async () => {
    const s = await poolOn([POOL_DEFAULT_ACCOUNT]);
    expect(() => beginPaneRelaunch('pty-t', { line: 'claude --resume x', byPerson: false })).toThrow(/usage reserve holds/);
    beginPaneRelaunch('pty-t', { line: 'claude --resume x', byPerson: true })?.(true);
    expect(s.launchOf('t')).toMatchObject({ gen: 2, accountId: POOL_DEFAULT_ACCOUNT });
  });

  it('takes the account the pane\'s live env runs on', async () => {
    const s = await poolOn([]);
    beginPaneRelaunch('pty-t', { line: 'claude', byPerson: true, paneAccount: 'acc-b' })?.(true);
    expect(s.launchOf('t')?.accountId).toBe('acc-b');
    expect(poolAccountOfPaneEnv({ CLAUDE_CONFIG_DIR: '/acc/a' }, () => [acct('a')])).toBe('a');
    expect(poolAccountOfPaneEnv({}, () => [acct('a')])).toBe(POOL_DEFAULT_ACCOUNT);
    expect(poolAccountOfPaneEnv({ CLAUDE_CONFIG_DIR: '/elsewhere' }, () => [acct('a')])).toBeUndefined();
  });
});

describe('a held bot fan-out\'s reserve check with the pool on', () => {
  const spent = (accountId: string) => ({ accountId, status: 'ok' as const, snapshot: { sessionPct: 100, sessionResetEpochSec: Math.floor(Date.now() / 1000) + 600, fetchedAtMs: Date.now() } as never, fetchedAtMs: Date.now(), lastError: null });
  const read = () => preparePool('ws-owner', { settings: () => on, host: host(), accounts: () => [acct('a')], binding: () => undefined, dirOk: () => true, signedIn: async () => true });
  const deps = (held: string[], over: Record<string, unknown> = {}) => ({
    poolOn: () => true, slots: slots(), dirOk: () => true, workerMayRun: () => true, refresh: () => undefined,
    host: host({ claudeUsage: () => [spent('a')] }),
    holdFor: (account: string) => (held.includes(account) ? { account, untilMs: Date.now() + 60_000 } : null),
    ...over,
  });

  it('decides the wake with the pick that held it: one out of quota and one reserve-held stays held', async () => {
    await read();
    // a: out of quota, not held; default: usable but held → the pick says 'held'.
    expect(poolReserveHeldForWorkspace('ws-owner', deps([POOL_DEFAULT_ACCOUNT]))).toBe(true);
    expect(poolReserveHeldForWorkspace('ws-owner', deps([]))).toBe(false);
  });

  it('a pool never read (after a restart) is read in the background and stays held meanwhile', () => {
    const refresh = vi.fn();
    expect(poolReserveHeldForWorkspace('ws-new', deps([], { refresh }))).toBe(true);
    expect(refresh).toHaveBeenCalledWith('ws-new');
  });

  it('falls back to the caller\'s account when the pool is off or the daemon is away', async () => {
    vi.spyOn(os, 'homedir').mockReturnValue(tmp());
    await setFanoutAccountPoolSettings({ enabled: true });
    await read();
    const { poolOn: _p, ...rest } = deps([]);
    expect(poolReserveHeldForWorkspace('ws-owner', { ...rest, host: host({ daemonConnected: () => false }) })).toBeUndefined();
    expect(poolReserveHeldForWorkspace('ws-owner', { ...rest, host: host({ daemonConnected: () => true, claudeUsage: () => [spent('a')] }) })).toBe(false);
    expect(poolReserveHeldForWorkspace('ws-owner', { ...deps([]), poolOn: () => false })).toBeUndefined();
  });
});

describe('a pool task across non-Claude generations', () => {
  it('keeps its pool mark through a codex line, so a later Claude line reads its pane\'s account again', async () => {
    const s = slots();
    setWorkerSlotsForTests(s);
    const { gen } = s.beginLaunch({ taskId: 't', origin: 'owner', ownerWorkspaceId: 'ws', accountId: 'acc-a' });
    s.launched('t', gen, 'ws-t', 'pty-t');
    beginPaneRelaunch('pty-t', { line: 'codex', byPerson: true })?.(true);
    expect(s.launchOf('t')).toMatchObject({ pooled: true });
    expect(s.launchOf('t')).not.toHaveProperty('accountId');
    expect(paneTaskPooled('pty-t', s)).toBe(true);
    const rpc = vi.fn(async () => [{ id: 'pty-t', env: { CLAUDE_CONFIG_DIR: '/nowhere' } }]);
    await poolAccountOfLivePane('pty-t', rpc, s);
    expect(rpc).toHaveBeenCalled();
    beginPaneRelaunch('pty-t', { line: 'claude --resume x', byPerson: true, paneAccount: 'acc-b' })?.(true);
    expect(s.launchOf('t')).toMatchObject({ accountId: 'acc-b', pooled: true });
  });

  it('a task that never ran on the pool is not read, and never becomes the default login', async () => {
    const s = slots();
    setWorkerSlotsForTests(s);
    const { gen } = s.beginLaunch({ taskId: 'p', origin: 'owner', ownerWorkspaceId: 'ws' });
    s.launched('p', gen, 'ws-p', 'pty-p');
    const rpc = vi.fn(async () => []);
    expect(await poolAccountOfLivePane('pty-p', rpc, s)).toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
    beginPaneRelaunch('pty-p', { line: 'claude', byPerson: false })?.(true);
    expect(s.launchOf('p')).not.toHaveProperty('accountId');
    expect(s.launchOf('p')).not.toHaveProperty('pooled');
  });

  it('a WSL pane\'s release unmarks the task', () => {
    const s = slots();
    const { gen } = s.beginLaunch({ taskId: 'w', origin: 'owner', ownerWorkspaceId: 'ws', accountId: 'acc-a' });
    s.setLaunchAccount('w', gen, undefined, { unpool: true });
    expect(s.launchOf('w')).not.toHaveProperty('pooled');
  });
});

describe('a reserve stop at a WSL pane\'s create', () => {
  it('goes through the hold its fan-out registered, once', () => {
    const hold = vi.fn(() => 'usage reserve: held for the reset');
    registerPoolCreateReserveHold('t9', hold);
    expect(poolCreateReserveRefusal('t9', { account: 'default', untilMs: 5 })).toBe('usage reserve: held for the reset');
    expect(hold).toHaveBeenCalledWith({ account: 'default', untilMs: 5 });
    expect(poolCreateReserveRefusal('t9', { account: 'default', untilMs: 5 })).toBeNull();
  });
});

describe('(d) a WSL task pane\'s pick reads its homes there, a native one only the Windows entries', () => {
  const UBUNTU = { distribution: 'Ubuntu', user: 'me' };
  const pool: PreparedPool = {
    settings: on, group: '',
    members: [{ id: 'a', configDir: '/acc/a' }, { id: POOL_DEFAULT_ACCOUNT, configDir: null }],
    // 'b' is signed in only in WSL, so its Windows folder left it out of `members`.
    wslMembers: [{ id: 'a', configDir: '/acc/a' }, { id: 'b', configDir: '/acc/b' }],
  };
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const windows = (pct: number) => ({ accountId: 'a', status: 'ok' as const, snapshot: { sessionPct: pct, sessionResetEpochSec: reset, fetchedAtMs: Date.now() } as never, fetchedAtMs: Date.now(), lastError: null });
  function wslState(t0 = Date.now()) {
    let now = t0;
    const s = new WslAccountState(() => now);
    return { s, at: (ms: number) => { now = ms; } };
  }
  const deps = (sl: WorkerSlots, over: Record<string, unknown> = {}) => ({ slots: sl, holdFor: () => null, workerMayRun: () => true, dirOk: () => true, ...over });

  it('picks by the homes\' own readings, and a WSL reading never reaches a native pick', () => {
    const { s } = wslState();
    // Windows: 'a' is spent. WSL: 'a' is spent there too, 'b' has most left.
    s.noteSample('a', UBUNTU, { session: { pct: 100, resetEpochSec: reset } });
    s.noteSample('b', UBUNTU, { session: { pct: 10, resetEpochSec: reset } });
    const h = host({ claudeUsage: () => [windows(100)] });
    const wsl = pickFromPool(pool, deps(slots(), { host: h, place: UBUNTU, wslState: s }));
    expect(wsl).toEqual({ kind: 'pick', accountId: 'b' });
    // Native: 'b' is no member, 'a' is spent on Windows: the default login.
    expect(pickFromPool(pool, deps(slots(), { host: h, wslState: s }))).toEqual({ kind: 'pick', accountId: POOL_DEFAULT_ACCOUNT });
    // A fresh WSL 'a' at 0% changes nothing for the native pick.
    s.noteSample('a', UBUNTU, { session: { pct: 0, resetEpochSec: reset } });
    expect(poolCandidates(pool, deps(slots(), { host: h, wslState: s })).find((c) => c.id === 'a')?.verdict.usable).toBe(false);
    // Another user of the same distro is another home: nothing known there.
    expect(poolCandidates(pool, deps(slots(), { host: h, place: { distribution: 'Ubuntu', user: 'other' }, wslState: s }))).toEqual([]);
  });

  it('needs sign-in evidence from the home; a stale reading rules a spent home out but ranks no fresh one', () => {
    const t0 = 10_000_000_000;
    const { s, at } = wslState(t0);
    s.noteAuth('a', UBUNTU, true);
    s.noteSample('b', UBUNTU, { session: { pct: 99, resetEpochSec: Math.floor(t0 / 1000) + 3600 } });
    s.noteAuth('c', UBUNTU, false);
    const p = { ...pool, wslMembers: [...pool.wslMembers!, { id: 'c', configDir: '/acc/c' }] };
    at(t0 + 20 * 60_000);
    const byId = Object.fromEntries(poolCandidates(p, deps(slots(), { place: UBUNTU, wslState: s, now: () => t0 + 20 * 60_000 })).map((c) => [c.id, c.verdict]));
    // 'a': signed in, never measured. 'b': spent 20 min ago, before its reset. 'c': signed out.
    expect(byId.a).toEqual({ usable: true, remaining: null, availableAtMs: null });
    expect(byId.b?.usable).toBe(false);
    expect(byId).not.toHaveProperty('c');
    expect(byId).not.toHaveProperty(POOL_DEFAULT_ACCOUNT);
  });

  it('holds a WSL home under its own key, and counts its workers on the account', () => {
    const { s } = wslState();
    s.noteAuth('a', UBUNTU, true);
    const sl = slots();
    sl.beginLaunch({ taskId: 'w1', origin: 'owner', ownerWorkspaceId: 'ws', accountId: 'a', wslPlace: UBUNTU });
    sl.beginLaunch({ taskId: 'n1', origin: 'owner', ownerWorkspaceId: 'ws', accountId: 'a' });
    const key = wslStateKey('a', UBUNTU)!;
    expect(poolUsageKey('a', UBUNTU)).toBe(key);
    // The per-account limit holds across Windows and every distro.
    expect(Object.fromEntries(openWorkersByAccount(sl, () => true))).toEqual({ a: 2 });
    const asked: string[] = [];
    const [c] = poolCandidates({ ...pool, wslMembers: [{ id: 'a', configDir: '/acc/a' }] }, deps(sl, { place: UBUNTU, wslState: s, holdFor: (k: string) => { asked.push(k); return k === key ? { untilMs: 7 } : null; } }));
    expect(c).toMatchObject({ id: 'a', heldUntilMs: 7, open: 2 });
    expect(asked).toEqual([key]);
  });

  it('after a restart a seeded reading is no sign-in: it rules a spent home out but never makes one a candidate', () => {
    const t0 = 10_000_000_000;
    const { s, at } = wslState(t0);
    const resetSec = Math.floor(t0 / 1000) + 3600;
    // Before the restart 'a' failed on its sign-in; only its last reading is in the trail.
    s.seed(wslStateKey('a', UBUNTU)!, { sessionPct: 10, sessionResetEpochSec: resetSec, fetchedAtMs: t0 }, t0);
    s.seed(wslStateKey('b', UBUNTU)!, { sessionPct: 100, sessionResetEpochSec: resetSec, fetchedAtMs: t0 }, t0);
    at(t0 + 60_000);
    const d = deps(slots(), { place: UBUNTU, wslState: s, now: () => t0 + 60_000 });
    expect(poolCandidates(pool, d)).toEqual([]);
    // A live sample in this run is evidence again; a turn that worked too, but a spent home stays out.
    s.noteSample('a', UBUNTU, { session: { pct: 10, resetEpochSec: resetSec } });
    s.noteAuth('b', UBUNTU, true);
    expect(Object.fromEntries(poolCandidates(pool, d).map((c) => [c.id, c.verdict.usable]))).toEqual({ a: true, b: false });
  });

  it('names a held WSL pick by the home whose hold ends first, among that place\'s candidates only', () => {
    const { s } = wslState();
    s.noteAuth('a', UBUNTU, true);
    s.noteAuth('b', UBUNTU, true);
    const ka = wslStateKey('a', UBUNTU)!;
    const kb = wslStateKey('b', UBUNTU)!;
    const p = { ...pool, wslMembers: [...pool.wslMembers!, { id: 'z', configDir: '/acc/z' }, { id: 'x', configDir: '/acc/x' }] }; // 'z': no home there
    // 'x' is spent there and not held: no reserve stop, so it is left out.
    s.noteSample('x', UBUNTU, { session: { pct: 100, resetEpochSec: reset } });
    const holds: Record<string, number> = { [ka]: 9, [kb]: 5 };
    const d = { ...deps(slots()), wslState: s, holdFor: (k: string) => (holds[k] ? { untilMs: holds[k] } : null) };
    expect(poolHeldInPlace(p, UBUNTU, d)).toEqual({ account: kb, untilMs: 5 });
    expect(heldHomeKey(p, UBUNTU, d)).toBe(kb);
    delete holds[ka];
    expect(poolHeldInPlace(p, UBUNTU, d)).toBeNull();
    expect(heldHomeKey(p, UBUNTU, d)).toBe(kb);
    expect(poolHeldInPlace(p, { distribution: 'Debian', user: 'me' }, d)).toBeNull();
    expect(heldHomeKey(p, { distribution: 'Debian', user: 'me' }, d)).toBeNull();
  });

  it('with a WSL default shell, a held bot is rechecked on the homes its task panes start in', async () => {
    const { s } = wslState();
    s.noteAuth('b', UBUNTU, true);
    const kb = wslStateKey('b', UBUNTU)!;
    await preparePool('ws-bot-shell', {
      settings: () => ({ ...on, includeDefaultLogin: false }), host: host(), accounts: () => [acct('a'), acct('b')], binding: () => undefined,
      dirOk: () => true, signedIn: async (d) => d.endsWith('/a'), vaultSignIn: () => false, log: () => undefined,
    });
    const shell = () => ({ wsl: true, distro: 'Ubuntu' });
    const base = { host: host(), slots: slots(), workerMayRun: () => true, dirOk: () => true, poolOn: () => true, refresh: () => undefined, wslState: s, paneShell: shell, defaultPlace: () => UBUNTU };
    const until = Date.now() + 60_000;
    // Windows 'a' held, the Ubuntu home of 'b' free: woken.
    expect(poolReserveHeldForWorkspace('ws-bot-shell', { ...base, holdFor: (k: string) => (k === 'a' ? { untilMs: until } : null) })).toBe(false);
    // The home held: stays held, whatever Windows holds.
    expect(poolReserveHeldForWorkspace('ws-bot-shell', { ...base, holdFor: (k: string) => (k === kb ? { untilMs: until } : null) })).toBe(true);
    // No place known there, or no usable home: the workspace's own account decides.
    expect(poolReserveHeldForWorkspace('ws-bot-shell', { ...base, defaultPlace: () => undefined, holdFor: () => null })).toBeUndefined();
    expect(poolReserveHeldForWorkspace('ws-bot-shell', { ...base, wslState: wslState().s, holdFor: () => null })).toBeUndefined();
  });

  it('a held bot is rechecked on the Windows members its tasks run on, whatever its WSL homes hold', async () => {
    const { s } = wslState();
    s.noteAuth('b', UBUNTU, true);
    await preparePool('ws-bot-wsl', {
      settings: () => ({ ...on, includeDefaultLogin: false }), host: host(), accounts: () => [acct('a')], binding: () => undefined,
      dirOk: () => true, signedIn: async () => true, vaultSignIn: () => false, log: () => undefined,
    });
    const base = { host: host(), slots: slots(), workerMayRun: () => true, dirOk: () => true, poolOn: () => true, refresh: () => undefined, wslState: s };
    // 'a' held on Windows: held, though its home is not.
    expect(poolReserveHeldForWorkspace('ws-bot-wsl', { ...base, holdFor: (k: string) => (k === 'a' ? { untilMs: Date.now() + 60_000 } : null) })).toBe(true);
    // 'a' free on Windows: woken, though a home is held.
    expect(poolReserveHeldForWorkspace('ws-bot-wsl', { ...base, holdFor: (k: string) => (k === 'a' ? null : { untilMs: Date.now() + 60_000 }) })).toBe(false);
  });

  it('a pane keeps a WSL pick only where it was picked for', () => {
    const rec = (wslPlace?: typeof UBUNTU) => () => ({ gen: 2, state: 'launching', accountId: 'a', ...(wslPlace ? { wslPlace } : {}) });
    const opts = { fanoutTaskOf: 'ws-owner', fanoutLaunch: { taskId: 't1', gen: 2 }, initialCommand: 'claude "$(cat p)"' };
    const released = { kind: 'release', taskId: 't1', gen: 2, wsl: true };
    // Kept with its recorded place, which the spawn pins (-d Ubuntu -u me).
    expect(poolAccountForCreate(opts, rec(UBUNTU), { wsl: true, wslPlace: { distribution: 'ubuntu', user: 'me' } })).toEqual({ kind: 'account', accountId: 'a', wslPlace: UBUNTU });
    expect(poolAccountForCreate(opts, rec(UBUNTU), { wsl: true, wslPlace: { distribution: 'Ubuntu', user: 'root' } })).toEqual(released);
    expect(poolAccountForCreate(opts, rec(UBUNTU), { wsl: true, wslPlace: null })).toEqual(released);
    expect(poolAccountForCreate(opts, rec(UBUNTU), { wsl: false })).toEqual(released);
    expect(poolAccountForCreate(opts, rec(), { wsl: true, wslPlace: UBUNTU })).toEqual(released);
  });

  it('a respawn on the same account keeps its home, and is held on that home\'s quota and hold', () => {
    const sl = slots();
    const g = sl.beginLaunch({ taskId: 't1', origin: 'owner', ownerWorkspaceId: 'ws', accountId: 'a', wslPlace: UBUNTU }).gen;
    sl.launched('t1', g, 'ws-t1', 'pty-1');
    const g2 = sl.beginLaunch({ taskId: 't1', origin: 'owner', ownerWorkspaceId: 'ws', accountId: 'a' }).gen;
    expect(sl.launchOf('t1')?.wslPlace).toEqual(UBUNTU);
    sl.launched('t1', g2, 'ws-t1', 'pty-2');
    const { s } = wslState();
    s.noteSample('a', UBUNTU, { session: { pct: 100, resetEpochSec: reset } });
    const base = { host: host({ claudeUsage: () => [windows(0)] }), slots: sl, taskId: 't1', holdFor: () => null, workerMayRun: () => true, dirOk: () => true, poolOn: () => true, account: () => acct('a'), wslState: s };
    expect(poolRelaunchRefusal('a', base)).toMatch(/out of quota/);
    const fine = wslState().s;
    expect(poolRelaunchRefusal('a', { ...base, wslState: fine })).toBeNull();
    expect(poolRelaunchRefusal('a', { ...base, wslState: fine, holdFor: (k: string) => (k === wslStateKey('a', UBUNTU) ? { untilMs: Date.now() + 1000 } : null) })).toMatch(/usage reserve holds/);
    // A home whose last turn failed on its sign-in is not relaunched into.
    fine.noteAuth('a', UBUNTU, false);
    expect(poolRelaunchRefusal('a', { ...base, wslState: fine })).toMatch(/signed out in WSL Ubuntu/);
    // A codex generation in the pane keeps the place with the pool mark, so
    // a Claude line typed there later is checked on the same home.
    sl.beginLaunch({ taskId: 't1', origin: 'owner', ownerWorkspaceId: 'ws', accountId: null, pane: { sessionId: 'pty-2', workspaceId: 'ws-t1' } });
    expect(sl.launchOf('t1')).toMatchObject({ pooled: true, wslPlace: UBUNTU });
    expect(sl.launchOf('t1')).not.toHaveProperty('accountId');
    expect(poolRelaunchRefusal('a', { ...base, wslState: fine })).toMatch(/signed out in WSL Ubuntu/);
    // On another account it is a native launch again.
    sl.beginLaunch({ taskId: 't1', origin: 'owner', ownerWorkspaceId: 'ws', accountId: 'b' });
    expect(sl.launchOf('t1')).not.toHaveProperty('wslPlace');
  });
});

describe('a pool with no account that can run a worker', () => {
  it('a group whose accounts are not signed in on Windows sends its workers to the caller\'s account, told once', async () => {
    const notify = vi.fn();
    const h = host({ notifyCallerFallback: notify });
    setFanoutAccountPoolHost(h);
    // Signed in only inside WSL: no sign-in in their Windows folders.
    const pool = await preparePool('ws-owner', {
      settings: () => ({ ...on, group: 'work' }), host: h, accounts: () => [acct('a', 'work'), acct('b', 'work')],
      binding: () => undefined, dirOk: () => true, signedIn: async () => false, vaultSignIn: () => false, log: () => undefined,
    });
    expect(pool?.members).toEqual([]);
    const picked = pickFromPool(pool!, { host: h, slots: slots(), holdFor: () => null, workerMayRun: () => true, dirOk: () => true });
    expect(picked).toMatchObject({ kind: 'none', reason: 'empty' });
    expect(poolFallsBackToCaller(picked)).toBe(true);
    // Not told while no host can show it, so the first shown notice is not lost.
    notePoolCallerFallback({ host: null, log: () => undefined });
    notePoolCallerFallback({ log: () => undefined });
    notePoolCallerFallback({ log: () => undefined });
    expect(notify).toHaveBeenCalledTimes(1);
    // Every account out of quota still refuses with its reset (the caller's may be one of them),
    // and a limit the owner set still stops it.
    expect(poolFallsBackToCaller({ kind: 'none', reason: 'quota', availableAtMs: 5 })).toBe(false);
    expect(poolFallsBackToCaller({ kind: 'none', reason: 'held', availableAtMs: 5 })).toBe(false);
    expect(poolFallsBackToCaller({ kind: 'none', reason: 'full', availableAtMs: null })).toBe(false);
    // A held bot's recheck leaves it to the workspace's own account.
    expect(poolReserveHeldForWorkspace('ws-owner', { poolOn: () => true, host: h, slots: slots(), holdFor: () => null, workerMayRun: () => true, dirOk: () => true, refresh: () => undefined })).toBeUndefined();
  });
});

describe('a fallback onto the caller\'s account', () => {
  it('is booked on that account and counts toward its worker limit, never as a pool account', () => {
    const s = slots();
    s.beginLaunch({ taskId: 'f1', origin: 'owner', ownerWorkspaceId: 'ws', callerAccount: POOL_DEFAULT_ACCOUNT });
    s.beginLaunch({ taskId: 'f2', origin: 'owner', ownerWorkspaceId: 'ws', accountId: 'a', callerAccount: 'x' });
    expect(s.launchOf('f1')).toMatchObject({ callerAccount: POOL_DEFAULT_ACCOUNT });
    expect(s.launchOf('f1')).not.toHaveProperty('accountId');
    expect(s.launchOf('f2')).not.toHaveProperty('callerAccount');
    expect(Object.fromEntries(openWorkersByAccount(s, () => true))).toEqual({ [POOL_DEFAULT_ACCOUNT]: 1, a: 1 });
    expect(openWorkersOn(POOL_DEFAULT_ACCOUNT, { slots: s, workerMayRun: () => true })).toBe(1);
    // Its pane's create takes no pool account from it.
    const g = s.launchOf('f1')!.gen;
    expect(poolAccountForCreate({ fanoutTaskOf: 'ws', fanoutLaunch: { taskId: 'f1', gen: g }, initialCommand: 'claude' }, (id) => s.launchOf(id))).toEqual({ kind: 'none' });
  });
});
