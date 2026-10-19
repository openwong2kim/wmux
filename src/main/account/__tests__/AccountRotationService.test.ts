import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountRotationService, claudeReading, codexReading, type AccountRotationDeps } from '../AccountRotationService';
import { AccountStore, type Account } from '../accountStore';
import type { AccountUsageEntry } from '../AccountUsageService';
import type { RolloutLimits } from '../../quota/codexRollout';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const RESET_SEC = Math.floor((NOW + 3 * 3600_000) / 1000);

const acct = (id: string, vendor: 'claude' | 'codex', group?: string): Account => ({
  id, name: id, vendor, configDir: `/acc/${id}`, createdAt: 0, ...(group ? { group } : {}),
});

function usage(id: string, sessionPct: number, fetchedAtMs = NOW): AccountUsageEntry {
  return {
    accountId: id,
    status: 'ok',
    snapshot: { sessionPct, sessionResetEpochSec: RESET_SEC, weeklyPct: 10, weeklyResetEpochSec: RESET_SEC + 86400, fetchedAtMs },
    fetchedAtMs,
    lastError: null,
  };
}

function limits(usedPercent: number): RolloutLimits {
  return { capturedAtMs: NOW, limitId: 'codex', primary: { usedPercent, windowMinutes: 300, resetsAtMs: NOW + 3600_000 }, secondary: null };
}

describe('AccountRotationService', () => {
  let dataDir: string;
  let usageEntries: AccountUsageEntry[];
  let refreshNow: ReturnType<typeof vi.fn<(accountId: string) => Promise<void>>>;
  let clock: number;
  let codex: Record<string, RolloutLimits | null>;
  let bindings: Record<string, string>;

  const make = (accounts: Account[], extra: AccountRotationDeps = {}) => new AccountRotationService({
    dataDir,
    now: () => clock,
    accounts: () => accounts,
    getBinding: (ws, vendor) => bindings[`${ws}:${vendor}`],
    claudeUsage: { getAll: () => usageEntries, refreshForLaunch: refreshNow },
    readCodexLimits: async (dir) => codex[dir] ?? null,
    dirExists: () => true,
    ...extra,
  });

  beforeEach(() => {
    clock = NOW;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-rotation-'));
    usageEntries = [];
    refreshNow = vi.fn<(accountId: string) => Promise<void>>(async () => undefined);
    codex = {};
    bindings = {};
  });
  afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

  it('does nothing — no reading, no network — while off', async () => {
    const s = make([acct('a', 'claude'), acct('b', 'claude')]);
    bindings['ws:claude'] = 'a';
    usageEntries = [usage('a', 100)];
    expect(await s.prepareLaunch('claude', 'ws')).toEqual({ kind: 'keep' });
    expect(refreshNow).not.toHaveBeenCalled();
  });

  it('cachedVerdict judges from the reading on hand, never refreshing', async () => {
    const stale = NOW - 60 * 60 * 1000;
    const s = make([acct('a', 'claude')]);
    usageEntries = [usage('a', 100, stale)];
    expect((await s.cachedVerdict('a'))?.usable).toBe(false);
    expect(await s.cachedVerdict('gone')).toBeNull();
    expect(refreshNow).not.toHaveBeenCalled();
  });

  it('switches a Claude pane to the account with quota and records it', async () => {
    const s = make([acct('a', 'claude'), acct('b', 'claude'), acct('c', 'claude')]);
    await s.setEnabled('claude', true);
    bindings['ws:claude'] = 'a';
    usageEntries = [usage('a', 99), usage('b', 50), usage('c', 20)];
    const d = await s.prepareLaunch('claude', 'ws');
    expect(d).toEqual({ kind: 'switch', accountId: 'c', env: { CLAUDE_CONFIG_DIR: '/acc/c' } });
    expect(s.launchedAccounts('ws', 'claude')).toEqual(['c']);
    expect(refreshNow).not.toHaveBeenCalled(); // readings were fresh
  });

  it('refreshes a stale Claude reading before deciding', async () => {
    const s = make([acct('a', 'claude'), acct('b', 'claude')]);
    await s.setEnabled('claude', true);
    bindings['ws:claude'] = 'a';
    usageEntries = [usage('a', 10, NOW - 60 * 60_000), usage('b', 10)];
    expect(await s.prepareLaunch('claude', 'ws')).toEqual({ kind: 'keep' });
    expect(refreshNow).toHaveBeenCalledWith('a');
  });

  it('counts a reading as stale by its last successful probe, not the last attempt', async () => {
    const s = make([acct('a', 'claude'), acct('b', 'claude')]);
    await s.setEnabled('claude', true);
    bindings['ws:claude'] = 'a';
    usageEntries = [{ ...usage('a', 10, NOW - 60 * 60_000), fetchedAtMs: NOW }, usage('b', 10)];
    await s.prepareLaunch('claude', 'ws');
    expect(refreshNow).toHaveBeenCalledWith('a');
  });

  it('reads only the bound account while it has quota', async () => {
    const s = make([acct('a', 'claude'), acct('b', 'claude')]);
    await s.setEnabled('claude', true);
    bindings['ws:claude'] = 'a';
    usageEntries = [usage('a', 10), usage('b', 10, NOW - 60 * 60_000)];
    expect(await s.prepareLaunch('claude', 'ws')).toEqual({ kind: 'keep' });
    expect(refreshNow).not.toHaveBeenCalled();

    const read = vi.fn(async (dir: string) => codex[dir] ?? null);
    const c = make([acct('x', 'codex'), acct('y', 'codex')], { readCodexLimits: read });
    await c.setEnabled('codex', true);
    bindings['ws:codex'] = 'x';
    codex[path.join('/acc/x', 'sessions')] = limits(20);
    expect(await c.prepareLaunch('codex', 'ws')).toEqual({ kind: 'keep' });
    expect(read.mock.calls).toEqual([[path.join('/acc/x', 'sessions')]]);
  });

  it('spends one 3 s budget on the whole decision', async () => {
    const s = make([acct('a', 'claude'), acct('b', 'claude')]);
    await s.setEnabled('claude', true);
    bindings['ws:claude'] = 'a';
    usageEntries = [usage('a', 100, NOW - 60 * 60_000), usage('b', 10, NOW - 60 * 60_000)];
    refreshNow.mockImplementation(async () => { clock += 3000; });
    expect(await s.prepareLaunch('claude', 'ws')).toMatchObject({ kind: 'switch', accountId: 'b' });
    expect(refreshNow.mock.calls).toEqual([['a']]);
  });

  it('stops when the switch goes off while the bound account is read', async () => {
    const s = make([acct('a', 'claude'), acct('b', 'claude')]);
    await s.setEnabled('claude', true);
    bindings['ws:claude'] = 'a';
    usageEntries = [usage('a', 100, NOW - 60 * 60_000), usage('b', 10, NOW - 60 * 60_000)];
    refreshNow.mockImplementation(async () => { await s.setEnabled('claude', false); });
    expect(await s.prepareLaunch('claude', 'ws')).toEqual({ kind: 'keep' });
    expect(refreshNow.mock.calls).toEqual([['a']]);
  });

  it('holds a Codex launch when every account is out', async () => {
    const s = make([acct('x', 'codex'), acct('y', 'codex')]);
    await s.setEnabled('codex', true);
    bindings['ws:codex'] = 'x';
    codex[path.join('/acc/x', 'sessions')] = limits(100);
    codex[path.join('/acc/y', 'sessions')] = limits(99);
    expect(await s.prepareLaunch('codex', 'ws')).toEqual({ kind: 'hold', availableAtMs: NOW + 3600_000 });
  });

  it('rotates only inside the bound account\'s group', async () => {
    const s = make([acct('w1', 'claude', 'work'), acct('p1', 'claude', 'personal'), acct('w2', 'claude', 'work'), acct('u1', 'claude')]);
    await s.setEnabled('claude', true);
    bindings['ws:claude'] = 'w1';
    usageEntries = [usage('w1', 99), usage('p1', 5), usage('w2', 60), usage('u1', 5)];
    expect(await s.prepareLaunch('claude', 'ws')).toEqual({ kind: 'switch', accountId: 'w2', env: { CLAUDE_CONFIG_DIR: '/acc/w2' } });
    // Ungrouped accounts are one pool of their own, never a fallback for a group.
    bindings['ws2:claude'] = 'u1';
    usageEntries = [usage('w1', 5), usage('p1', 5), usage('w2', 5), usage('u1', 99)];
    expect(await s.prepareLaunch('claude', 'ws2')).toMatchObject({ kind: 'hold', grouped: true });
  });

  it('still holds inside the group after an older build rewrote accounts.json', async () => {
    const store = new AccountStore(dataDir);
    fs.mkdirSync(path.join(dataDir, 'w'));
    fs.mkdirSync(path.join(dataDir, 'p'));
    const w = await store.addAccount({ name: 'w', vendor: 'claude', configDir: path.join(dataDir, 'w') });
    const p = await store.addAccount({ name: 'p', vendor: 'claude', configDir: path.join(dataDir, 'p') });
    await store.setAccountGroup(w.id, 'Work');
    await store.setAccountGroup(p.id, 'Personal');
    const file = path.join(dataDir, 'accounts.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { accounts: Record<string, unknown>[] };
    raw.accounts = raw.accounts.map(({ id, name, vendor, configDir, createdAt }) => ({ id, name, vendor, configDir, createdAt }));
    fs.writeFileSync(file, JSON.stringify(raw));
    const fresh = new AccountStore(dataDir);
    const s = make([], { accounts: () => fresh.listAccounts() });
    await s.setEnabled('claude', true);
    bindings['ws:claude'] = w.id;
    usageEntries = [usage(w.id, 99), usage(p.id, 5)];
    expect(await s.prepareLaunch('claude', 'ws')).toMatchObject({ kind: 'hold', grouped: true });
  });

  it('drops an account moved to another group while the quota reads ran', async () => {
    const accounts = [acct('w1', 'claude', 'work'), acct('w2', 'claude', 'work')];
    const s = make(accounts);
    await s.setEnabled('claude', true);
    bindings['ws:claude'] = 'w1';
    usageEntries = [usage('w1', 99, NOW - 60 * 60_000), usage('w2', 10)];
    // The store hands out new records after a write, as setAccountGroup does.
    refreshNow.mockImplementation(async () => { accounts[1] = acct('w2', 'claude', 'personal'); });
    // w2 had quota but is personal now: the work group (w1 alone) is out.
    expect(await s.prepareLaunch('claude', 'ws')).toEqual({ kind: 'hold', availableAtMs: RESET_SEC * 1000, grouped: true });
  });

  it('holds when the whole group is out instead of crossing into another group', async () => {
    const s = make([acct('w1', 'claude', 'work'), acct('w2', 'claude', 'work'), acct('p1', 'claude', 'personal')]);
    await s.setEnabled('claude', true);
    bindings['ws:claude'] = 'w1';
    usageEntries = [usage('w1', 100), usage('w2', 99), usage('p1', 0)];
    expect(await s.prepareLaunch('claude', 'ws')).toEqual({ kind: 'hold', availableAtMs: RESET_SEC * 1000, grouped: true });
  });

  it('does not switch inside the old group when the workspace is rebound during the reads', async () => {
    const s = make([acct('w1', 'claude', 'work'), acct('w2', 'claude', 'work'), acct('p1', 'claude', 'personal')]);
    await s.setEnabled('claude', true);
    bindings['ws:claude'] = 'w1';
    usageEntries = [usage('w1', 99, NOW - 60 * 60_000), usage('w2', 10), usage('p1', 10)];
    refreshNow.mockImplementation(async () => { bindings['ws:claude'] = 'p1'; });
    expect(await s.prepareLaunch('claude', 'ws')).toEqual({ kind: 'keep' });
  });

  it('switches a Codex pane via CODEX_HOME', async () => {
    const s = make([acct('x', 'codex'), acct('y', 'codex')]);
    await s.setEnabled('codex', true);
    bindings['ws:codex'] = 'x';
    codex[path.join('/acc/x', 'sessions')] = limits(100);
    codex[path.join('/acc/y', 'sessions')] = limits(30);
    expect(await s.prepareLaunch('codex', 'ws')).toEqual({ kind: 'switch', accountId: 'y', env: { CODEX_HOME: '/acc/y' } });
  });

  it('never switches to an account whose last probe failed, and does not hold for it', async () => {
    const s = make([acct('a', 'claude'), acct('b', 'claude')]);
    await s.setEnabled('claude', true);
    bindings['ws:claude'] = 'a';
    usageEntries = [usage('a', 100), { ...usage('b', 5), status: 'unauthorized' }];
    expect(await s.prepareLaunch('claude', 'ws')).toEqual({ kind: 'keep' });
  });

  it('never switches to a Codex account with no readable limits', async () => {
    const s = make([acct('x', 'codex'), acct('y', 'codex'), acct('z', 'codex')]);
    await s.setEnabled('codex', true);
    bindings['ws:codex'] = 'x';
    codex[path.join('/acc/x', 'sessions')] = limits(100);
    codex[path.join('/acc/z', 'sessions')] = limits(90);
    expect(await s.prepareLaunch('codex', 'ws')).toMatchObject({ kind: 'switch', accountId: 'z' });
    codex[path.join('/acc/z', 'sessions')] = limits(100);
    expect(await s.prepareLaunch('codex', 'ws')).toEqual({ kind: 'keep' });
  });

  it('remembers every rotated account in a workspace until switched off or unregistered', async () => {
    let accounts = [acct('a', 'claude'), acct('b', 'claude'), acct('c', 'claude')];
    const s = make([], { accounts: () => accounts });
    await s.setEnabled('claude', true);
    bindings['ws:claude'] = 'a';
    usageEntries = [usage('a', 100), usage('b', 10), usage('c', 50)];
    await s.prepareLaunch('claude', 'ws'); // → b
    usageEntries = [usage('a', 100), usage('b', 100), usage('c', 50)];
    await s.prepareLaunch('claude', 'ws'); // → c, b's pane still runs
    usageEntries = [usage('a', 10), usage('b', 100), usage('c', 50)];
    await s.prepareLaunch('claude', 'ws'); // keep on a
    expect(s.launchedAccounts('ws', 'claude').sort()).toEqual(['b', 'c']);

    accounts = accounts.filter((a) => a.id !== 'b');
    expect(s.launchedAccounts('ws', 'claude')).toEqual(['c']);
    await s.setEnabled('claude', false);
    expect(s.launchedAccounts('ws', 'claude')).toEqual([]);
  });

  it('leaves an unbound workspace on its default login', async () => {
    const s = make([acct('a', 'claude')]);
    await s.setEnabled('claude', true);
    usageEntries = [usage('a', 100)];
    expect(await s.prepareLaunch('claude', 'ws')).toEqual({ kind: 'keep' });
  });

  it('keeps both switches when they are toggled at the same time', async () => {
    const s = make([]);
    await Promise.all([s.setEnabled('claude', true), s.setEnabled('codex', true)]);
    expect(s.getSettings()).toEqual({ claude: true, codex: true });
    expect(make([]).getSettings()).toEqual({ claude: true, codex: true });
  });

  it('persists the per-vendor switch', async () => {
    await make([]).setEnabled('codex', true);
    expect(make([]).getSettings()).toEqual({ claude: false, codex: true });
  });

  it('rows never refresh', async () => {
    const s = make([acct('a', 'claude')]);
    await s.setEnabled('claude', true);
    usageEntries = [usage('a', 40, NOW - 60 * 60_000)];
    const rows = await s.rows('claude');
    expect(rows[0].verdict.remaining).toBeCloseTo(0.6);
    expect(refreshNow).not.toHaveBeenCalled();
  });

  it('rows read nothing for a vendor whose switch is off', async () => {
    const read = vi.fn(async () => limits(10));
    const s = make([acct('x', 'codex')], { readCodexLimits: read });
    expect(await s.rows('codex')).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('readings', () => {
  it('maps Claude percent used and reset seconds', () => {
    const r = claudeReading(usage('a', 25));
    expect(r?.windows[0]).toEqual({ remaining: 0.75, resetAtMs: RESET_SEC * 1000 });
  });

  it('maps Codex windows and skips missing ones', () => {
    expect(codexReading(limits(40))?.windows).toEqual([{ remaining: 0.6, resetAtMs: NOW + 3600_000 }]);
    expect(codexReading(null)).toBeNull();
  });
});
