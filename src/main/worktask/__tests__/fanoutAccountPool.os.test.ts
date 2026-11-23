// The fan-out account pool (desktop): eligibility, the spread of parallel
// launches, and what a task pane's create takes from its launch record.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WORKER_SLOTS_FILENAME, WorkerSlots, beginPaneRelaunch, setWorkerSlotsForTests } from '../../factory/workerSlots';
import { setUsageReserve } from '../../usage/usageReserve';
import {
  claudeFolderSignedIn,
  loadFanoutAccountPoolSettings,
  openWorkersByAccount,
  pickFromPool,
  poolCandidates,
  poolAccountForCreate,
  poolAllHeld,
  poolAccountOfPaneEnv,
  poolReserveHeldForWorkspace,
  setFanoutAccountPoolHost,
  poolRelaunchRefusal,
  preparePool,
  resetFanoutAccountPoolForTests,
  setFanoutAccountPoolSettings,
  type FanoutAccountPoolHost,
  type PreparedPool,
} from '../fanoutAccountPool';
import { DEFAULT_FANOUT_ACCOUNT_POOL_SETTINGS, POOL_DEFAULT_ACCOUNT, type FanoutAccountPoolSettings } from '../../../shared/fanoutAccountPool';
import type { Account } from '../../account/accountStore';
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
  it('stays held while every member of the workspace\'s last pool is, and falls back when there is none', async () => {
    await preparePool('ws-owner', { settings: () => on, host: host(), accounts: () => [acct('a')], binding: () => undefined, dirOk: () => true, signedIn: async () => true });
    const holdFor = (held: string[]) => (account: string) => (held.includes(account) ? { account, untilMs: 5 } : null);
    expect(poolReserveHeldForWorkspace('ws-owner', { poolOn: () => true, holdFor: holdFor(['a', POOL_DEFAULT_ACCOUNT]) })).toBe(true);
    expect(poolReserveHeldForWorkspace('ws-owner', { poolOn: () => true, holdFor: holdFor(['a']) })).toBe(false);
    expect(poolReserveHeldForWorkspace('ws-other', { poolOn: () => true, holdFor: holdFor(['a']) })).toBeUndefined();
    expect(poolReserveHeldForWorkspace('ws-owner', { poolOn: () => false })).toBeUndefined();
  });
});
