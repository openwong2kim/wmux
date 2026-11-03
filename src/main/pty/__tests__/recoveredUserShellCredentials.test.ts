// #3049 — main's half of a restored user shell's credentials: which sessions
// main grants them to, what it records (ids, never values), and how it starts
// the shells the daemon holds for it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  UserShellRecord,
  credentialEnvFor,
  promoteRecoveredSession,
  startHeldUserShells,
  type ListedSession,
  type PromoteAnswer,
} from '../userShellRecord';
import { HELD_START_CONCURRENCY } from '../../../shared/userShellHolds';

// Placeholder values only; no real secret is ever used in a test.
const MAIN_ENV = { PATH: '/main/bin', GH_TOKEN: 'main-placeholder', WMUX_PUSH_RELAY_SECRET: 'relay-placeholder' };
const ENTRY = { cmd: '/bin/zsh', incarnationId: 'inc-1' };
const USER_SHELL: ListedSession = { id: 'daemon-shell', cmd: '/bin/zsh', incarnationId: 'inc-1', state: 'suspended', startPending: true };

describe('credentialEnvFor — the grant matrix', () => {
  it('grants a recorded user shell whose cmd and incarnation match: main\'s credentials, never the relay secret', () => {
    expect(credentialEnvFor(USER_SHELL, ENTRY, MAIN_ENV)).toEqual({ GH_TOKEN: 'main-placeholder' });
  });

  it('grants nothing to a session main never recorded as a user shell (a fan-out or bot worker, a plain agent)', () => {
    expect(credentialEnvFor(USER_SHELL, undefined, MAIN_ENV)).toBeUndefined();
  });

  it('grants nothing when the daemon lists another cmd or incarnation for the id', () => {
    expect(credentialEnvFor({ ...USER_SHELL, cmd: '/bin/bash' }, ENTRY, MAIN_ENV)).toBeUndefined();
    expect(credentialEnvFor({ ...USER_SHELL, incarnationId: 'inc-2' }, ENTRY, MAIN_ENV)).toBeUndefined();
    expect(credentialEnvFor({ ...USER_SHELL, incarnationId: undefined }, ENTRY, MAIN_ENV)).toBeUndefined();
  });

  it('the daemon\'s data can only take a grant away: a listed exec or supervision gates it', () => {
    expect(credentialEnvFor({ ...USER_SHELL, exec: { command: 'claude' } }, ENTRY, MAIN_ENV)).toBeUndefined();
    expect(credentialEnvFor({ ...USER_SHELL, supervision: { restart: 'always' } }, ENTRY, MAIN_ENV)).toBeUndefined();
  });
});

describe('UserShellRecord', () => {
  let dir: string;
  let recordFile: string;
  let holdsFile: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-usr-'));
    recordFile = path.join(dir, 'userData', 'user-shell-record.json');
    holdsFile = path.join(dir, 'wmux', 'user-shell-holds.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes ids with cmd and incarnation to the record, and the ids alone to the hold list', () => {
    const record = new UserShellRecord(recordFile, holdsFile);
    record.set('daemon-a', ENTRY);
    record.set('daemon-b', { cmd: '/bin/bash', incarnationId: 'inc-b' });
    expect(JSON.parse(fs.readFileSync(recordFile, 'utf8'))).toEqual({
      version: 1,
      panes: { 'daemon-a': ENTRY, 'daemon-b': { cmd: '/bin/bash', incarnationId: 'inc-b' } },
    });
    expect(JSON.parse(fs.readFileSync(holdsFile, 'utf8'))).toEqual({ version: 1, ids: ['daemon-a', 'daemon-b'] });
    // A fresh process reads the same record back.
    expect(new UserShellRecord(recordFile, holdsFile).get('daemon-a')).toEqual(ENTRY);
  });

  it('removes and prunes ids from both files', () => {
    const record = new UserShellRecord(recordFile, holdsFile);
    record.set('daemon-a', ENTRY);
    record.set('daemon-b', ENTRY);
    record.set('daemon-c', ENTRY);
    record.remove('daemon-a');
    record.prune(new Set(['daemon-b']));
    expect(record.ids()).toEqual(['daemon-b']);
    expect(JSON.parse(fs.readFileSync(holdsFile, 'utf8')).ids).toEqual(['daemon-b']);
  });

  it('an unreadable record grants nothing', () => {
    fs.mkdirSync(path.dirname(recordFile), { recursive: true });
    fs.writeFileSync(recordFile, '{ not json');
    expect(new UserShellRecord(recordFile, holdsFile).ids()).toEqual([]);
  });

  it('a failed write is a warning, never a throw into pane creation', () => {
    fs.writeFileSync(path.join(dir, 'blocker'), '');
    const warn = vi.fn();
    const record = new UserShellRecord(path.join(dir, 'blocker', 'record.json'), holdsFile, warn);
    expect(() => record.set('daemon-a', ENTRY)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('promoteRecoveredSession', () => {
  let dir: string;
  let record: UserShellRecord;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-usr-'));
    record = new UserShellRecord(path.join(dir, 'record.json'), path.join(dir, 'holds.json'));
    record.set(USER_SHELL.id, ENTRY);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function client(answer: PromoteAnswer, listing: ListedSession[] = [USER_SHELL]) {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    return {
      calls,
      rpc: vi.fn(async (method: string, params?: Record<string, unknown>, _opts?: { timeoutMs?: number }) => {
        calls.push({ method, params });
        return method === 'daemon.listSessions' ? listing : answer;
      }),
    };
  }

  it('sends a granted shell\'s credentials, and says nothing when the daemon applied them', async () => {
    const c = client({ ok: true, alreadyActive: false, credentialsApplied: true });
    const log = vi.fn();
    await promoteRecoveredSession(c, record, USER_SHELL, { liveEnv: MAIN_ENV, log });
    expect(c.calls[0]).toEqual({ method: 'daemon.promoteSession', params: { id: USER_SHELL.id, credentialEnv: { GH_TOKEN: 'main-placeholder' } } });
    expect(log).not.toHaveBeenCalled();
  });

  it('logs once when the shell was started without them (the daemon\'s fallback got there first)', async () => {
    const log = vi.fn();
    await promoteRecoveredSession(client({ ok: true, alreadyActive: false, joined: true }), record, USER_SHELL, { liveEnv: MAIN_ENV, log });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe(`[env] pane ${USER_SHELL.id} restored without credentials (the daemon started it before the app did)`);
  });

  it('a later answer for a shell main already started with them is not logged', async () => {
    const log = vi.fn();
    await promoteRecoveredSession(client({ ok: true, alreadyActive: false, credentialsApplied: true }), record, USER_SHELL, { liveEnv: MAIN_ENV, log });
    await promoteRecoveredSession(client({ ok: true, alreadyActive: true }), record, USER_SHELL, { liveEnv: MAIN_ENV, log });
    expect(log).not.toHaveBeenCalled();
  });

  it('a join-only call and an unrecorded session carry no credentials', async () => {
    const joinOnly = client({ ok: false, notInFlight: true });
    await promoteRecoveredSession(joinOnly, record, USER_SHELL, { joinOnly: true, liveEnv: MAIN_ENV });
    expect(joinOnly.calls[0].params).toEqual({ id: USER_SHELL.id, joinOnly: true });
    const worker = client({ ok: true });
    await promoteRecoveredSession(worker, record, { ...USER_SHELL, id: 'daemon-worker' }, { liveEnv: MAIN_ENV });
    expect(worker.calls[0].params).toEqual({ id: 'daemon-worker' });
  });

  it('given only an id (pty:promote), reads the daemon\'s listing for the grant and keeps the fresh flag', async () => {
    const c = client({ ok: true, credentialsApplied: true });
    await promoteRecoveredSession(c, record, USER_SHELL.id, { fresh: true, timeoutMs: 1234, liveEnv: MAIN_ENV });
    expect(c.calls.map((x) => x.method)).toEqual(['daemon.listSessions', 'daemon.promoteSession']);
    expect(c.calls[1].params).toEqual({ id: USER_SHELL.id, fresh: true, credentialEnv: { GH_TOKEN: 'main-placeholder' } });
    expect(c.rpc.mock.calls[1][2]).toEqual({ timeoutMs: 1234 });
  });
});

describe('startHeldUserShells (main connects to the daemon)', () => {
  let dir: string;
  let record: UserShellRecord;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-usr-'));
    record = new UserShellRecord(path.join(dir, 'record.json'), path.join(dir, 'holds.json'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('prunes ids the daemon lost and starts only the held shells, credentials only where granted', async () => {
    record.set('daemon-held', ENTRY);
    record.set('daemon-gone', ENTRY);
    record.set('daemon-dead', ENTRY);
    // An edited sessions.json: an agent with its exec removed, listed as held.
    const listing: ListedSession[] = [
      { id: 'daemon-held', cmd: '/bin/zsh', incarnationId: 'inc-1', state: 'suspended', startPending: true },
      { id: 'daemon-agent', cmd: '/bin/zsh', incarnationId: 'inc-x', state: 'suspended', startPending: true },
      { id: 'daemon-live', cmd: '/bin/zsh', incarnationId: 'inc-l', state: 'detached' },
      { id: 'daemon-dead', cmd: '/bin/zsh', incarnationId: 'inc-1', state: 'dead' },
    ];
    const promotes: Array<Record<string, unknown> | undefined> = [];
    const c = {
      rpc: vi.fn(async (method: string, params?: Record<string, unknown>) => {
        if (method === 'daemon.listSessions') return listing;
        promotes.push(params);
        return { ok: true, alreadyActive: false, ...(params?.credentialEnv ? { credentialsApplied: true } : {}) };
      }),
    };
    expect(await startHeldUserShells(c, record, { liveEnv: MAIN_ENV })).toBe(2);
    expect(record.ids()).toEqual(['daemon-held']);
    expect(promotes).toEqual([
      { id: 'daemon-held', credentialEnv: { GH_TOKEN: 'main-placeholder' } },
      { id: 'daemon-agent' },
    ]);
  });

  it('rewrites a deleted or emptied hold list from the record on every connect', async () => {
    const holdsFile = path.join(dir, 'holds.json');
    record.set('daemon-held', ENTRY);
    const c = { rpc: vi.fn(async () => [{ id: 'daemon-held', cmd: '/bin/zsh', incarnationId: 'inc-1', state: 'detached' }]) };

    fs.writeFileSync(holdsFile, JSON.stringify({ version: 1, ids: [] }));
    await startHeldUserShells(c, record, { liveEnv: MAIN_ENV });
    expect(JSON.parse(fs.readFileSync(holdsFile, 'utf8'))).toEqual({ version: 1, ids: ['daemon-held'] });

    fs.unlinkSync(holdsFile);
    await startHeldUserShells(c, record, { liveEnv: MAIN_ENV });
    expect(JSON.parse(fs.readFileSync(holdsFile, 'utf8'))).toEqual({ version: 1, ids: ['daemon-held'] });
  });

  it(`starts at most ${HELD_START_CONCURRENCY} at once`, async () => {
    const listing: ListedSession[] = Array.from({ length: 14 }, (_, i) => ({ id: `daemon-${i}`, cmd: '/bin/zsh', state: 'suspended', startPending: true }));
    let running = 0;
    let peak = 0;
    const c = {
      rpc: vi.fn(async (method: string) => {
        if (method === 'daemon.listSessions') return listing;
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 0));
        running--;
        return { ok: true };
      }),
    };
    expect(await startHeldUserShells(c, record, { liveEnv: MAIN_ENV })).toBe(14);
    expect(peak).toBe(HELD_START_CONCURRENCY);
  });
});
