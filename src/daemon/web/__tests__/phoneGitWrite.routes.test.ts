import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { WebTerminalServer, type WebDeviceResolver, type WebTerminalStartOptions } from '../WebTerminalServer';
import { buildGitEnv } from '../sessionDiff';
import { PhoneGitWriteGate } from '../phoneGitWriteGate';
import { registerPhoneGitWriteAction, type GitWriteExecuteContext } from '../phoneGitWriteRegistry';
import { DeviceStore } from '../DeviceStore';
import { GIT_WRITE_RECEIPT_TTL_MS } from '../../../shared/phoneGitWrite';
import type { DaemonSessionManager } from '../../DaemonSessionManager';

/**
 * The phone git write gate through the real HTTP surface: ceiling, explicit
 * grant, 501 until an action registers, confirm tokens, receipts and the
 * `/api/config` keys. The action itself is a stub; git push and gh run in the
 * action modules.
 */

type Pane = { meta: { id: string; incarnationId: string; env: Record<string, string>; cwd: string; spawnCwd: string; state: string; cols: number; rows: number; lastActivity: string; createdAt: string } };
const pane = (id: string, spawnCwd: string): Pane => ({
  meta: { id, incarnationId: `${id}-inc`, env: {}, cwd: spawnCwd, spawnCwd, state: 'detached', cols: 80, rows: 24, lastActivity: '2026-10-01T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z' },
});
const OID = 'c'.repeat(40);
const REF = 'refs/heads/feat/x';

describe('phone git write routes', { timeout: 60_000 }, () => {
  let root: string;
  let wmuxDir: string;
  let roster: Map<string, { secret: string; allowInput: boolean; explicit: boolean }>;
  let now: number;
  let ghLogins: Map<string, string>;
  let server: WebTerminalServer;
  let unregister: Array<() => void>;
  let gate: PhoneGitWriteGate | undefined;
  const savedGhToken = process.env.GH_TOKEN;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-git-write-routes-')));
    wmuxDir = path.join(root, '.wmux-test');
    fs.mkdirSync(wmuxDir);
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: buildGitEnv(), encoding: 'utf8' });
    run('init', '-q', '-b', 'main');
    run('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'base');
    const panes = new Map([['s1', pane('s1', repo)], ['s2', pane('s2', repo)]]);
    roster = new Map();
    now = 1_000_000;
    ghLogins = new Map([['octo', 'gho_octo']]);
    unregister = [];
    gate = undefined;
    process.env.GH_TOKEN = 'inherited-other-account';
    const devices: WebDeviceResolver = {
      async mint() { throw new Error('unused'); },
      async resolve(deviceId, secret) {
        const d = roster.get(deviceId);
        return d && d.secret === secret ? { ok: true, deviceId, allowInput: d.allowInput } : { ok: false, reason: 'unknown' };
      },
      hasExplicitInputGrant: (deviceId) => roster.get(deviceId)?.explicit === true,
    };
    const sessionManager = Object.assign(new EventEmitter(), {
      getSession: (id: string) => panes.get(id),
      listManagedSessions: () => [...panes.values()],
      listLiveSessions: () => [...panes.values()].map((p) => ({ ...p.meta })),
    }) as unknown as DaemonSessionManager;
    server = new WebTerminalServer({
      sessionManager,
      devices,
      phoneGitWrite: () => gate ??= new PhoneGitWriteGate({
        wmuxDir,
        now: () => now,
        ghToken: async (args) => {
          const token = ghLogins.get(args[args.length - 1]);
          return token ? { ok: true, stdout: `${token}\n` } : { ok: false, ran: true };
        },
      }),
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
    });
  });
  afterEach(async () => {
    for (const u of unregister) u();
    if (server.isRunning) await server.stop();
    if (savedGhToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = savedGhToken;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const start = (over: Partial<WebTerminalStartOptions> = {}) =>
    server.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false, allowGitWrite: true, gitWriteLogin: 'octo', ...over });
  const base = () => `http://127.0.0.1:${server.status().port}`;
  const device = (id: string, allowInput = true, explicit = true) => {
    roster.set(id, { secret: 's', allowInput, explicit });
    return { Authorization: `Bearer ${id}.s` };
  };
  const call = (headers: Record<string, string>, method: string, p: string, body?: unknown) =>
    fetch(`${base()}/api/sessions/${p}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const config = async (headers: Record<string, string>) =>
    (await fetch(`${base()}/api/config`, { headers })).json() as Promise<Record<string, unknown>>;

  /** A push action that records what it was given and settles `done`. */
  const stubPush = () => {
    const runs: GitWriteExecuteContext[] = [];
    unregister.push(registerPhoneGitWriteAction('push', {
      preview: async (ctx) => ({ ok: true, facts: { branch: 'feat/x', ref: REF, head: OID, ghToken: ctx.ghEnv.GH_TOKEN }, pins: { head: OID, ref: REF, targetRef: REF, remoteTip: null } }),
      execute: async (ctx) => {
        runs.push(ctx);
        ctx.markInFlight();
        ctx.settle({ state: 'done', fields: { pushed: OID, target: REF } });
      },
    }));
    return runs;
  };
  const preview = async (headers: Record<string, string>) => {
    const res = await call(headers, 'POST', 's1/git/push/preview', {});
    expect(res.status).toBe(200);
    return res.json() as Promise<Record<string, unknown>>;
  };

  it('refuses with the ceiling off and advertises nothing', async () => {
    stubPush();
    await start({ allowGitWrite: false });
    const phone = device('phone');
    const cfg = await config(phone);
    for (const key of ['gitPush', 'gitPrCreate', 'gitPrMerge']) expect(cfg).not.toHaveProperty(key);
    const res = await call(phone, 'POST', 's1/git/push/preview', {});
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'git-write-disabled' });
  });

  it('refuses a device whose input grant predates grants, even with the ceiling on', async () => {
    stubPush();
    await start();
    const legacy = device('legacy', true, false);
    expect(await config(legacy)).not.toHaveProperty('gitPush');
    const res = await call(legacy, 'POST', 's1/git/push/preview', {});
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/^read-only: /);
    expect((await call(device('ro', false, false), 'POST', 's1/git/push/preview', {})).status).toBe(403);
  });

  it('answers 501 and omits the config keys until an action registers', async () => {
    await start();
    const phone = device('phone');
    const cfg = await config(phone);
    for (const key of ['gitPush', 'gitPrCreate', 'gitPrMerge']) expect(cfg).not.toHaveProperty(key);
    expect((await call(phone, 'POST', 's1/git/push/preview', {})).status).toBe(501);
    expect((await call(phone, 'POST', 's1/git/pr', { requestId: randomUUID(), title: 't', body: '' })).status).toBe(501);
    expect((await call(phone, 'POST', 's1/git/pr/12/merge/preview', {})).status).toBe(501);
    // The PR list GET is the existing route, untouched.
    expect((await call(phone, 'GET', 's1/git/pr')).status).not.toBe(501);
    stubPush();
    expect(await config(phone)).toMatchObject({ gitPush: true });
    expect(await config(phone)).not.toHaveProperty('gitPrMerge');
  });

  it('runs one push per token, replays a resend after the token was spent, and refuses a reused requestId', async () => {
    const runs = stubPush();
    await start();
    const phone = device('phone');
    const facts = await preview(phone);
    expect(facts).toMatchObject({ identity: { login: 'octo' }, ghToken: 'gho_octo' });
    const body = { requestId: randomUUID(), confirmToken: facts.confirmToken, expectedHead: OID, expectedRef: REF };
    const first = await call(phone, 'POST', 's1/git/push', body);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ requestId: body.requestId, replayed: false, state: 'pending' });
    await vi.waitFor(async () => expect(await (await call(phone, 'GET', `s1/git/push/${body.requestId}`)).json()).toMatchObject({ state: 'done' }));
    // Lost response: same body, spent token → the stored receipt, nothing runs twice.
    const resend = await call(phone, 'POST', 's1/git/push', body);
    expect(resend.status).toBe(200);
    expect(await resend.json()).toEqual({ requestId: body.requestId, replayed: true, state: 'done', pushed: OID, target: REF });
    expect(runs).toHaveLength(1);
    // The inherited GH_TOKEN never reaches the action.
    expect(runs[0].ghEnv.GH_TOKEN).toBe('gho_octo');
    const reused = await call(phone, 'POST', 's1/git/push', { ...body, expectedRef: 'refs/heads/other' });
    expect(reused.status).toBe(409);
    expect(await reused.json()).toEqual({ error: 'request-id-reused' });
    // A spent token under a new requestId is a new intent: preview again.
    const again = await call(phone, 'POST', 's1/git/push', { ...body, requestId: randomUUID() });
    expect(again.status).toBe(428);
    expect(runs).toHaveLength(1);
  });

  it('refuses a token from another session or a moved head, and a login without a token', async () => {
    const runs = stubPush();
    await start();
    const phone = device('phone');
    const t1 = (await preview(phone)).confirmToken;
    expect((await call(phone, 'POST', 's2/git/push', { requestId: randomUUID(), confirmToken: t1, expectedHead: OID, expectedRef: REF })).status).toBe(428);
    const t2 = (await preview(phone)).confirmToken;
    const stale = await call(phone, 'POST', 's1/git/push', { requestId: randomUUID(), confirmToken: t2, expectedHead: 'd'.repeat(40), expectedRef: REF });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'stale', head: OID });
    const t3 = (await preview(phone)).confirmToken;
    ghLogins.clear();
    const revoked = await call(phone, 'POST', 's1/git/push', { requestId: randomUUID(), confirmToken: t3, expectedHead: OID, expectedRef: REF });
    expect(revoked.status).toBe(409);
    expect(await revoked.json()).toEqual({ error: 'identity-changed' });
    const missing = await call(phone, 'POST', 's1/git/push/preview', {});
    expect(missing.status).toBe(424);
    expect(await missing.json()).toEqual({ error: 'gh-auth-missing', login: 'octo' });
    expect(runs).toHaveLength(0);
  });

  it('binds a merge receipt to its PR number', async () => {
    unregister.push(registerPhoneGitWriteAction('pr.merge', {
      preview: async (ctx) => ({ ok: true, facts: { number: ctx.number, headRefOid: OID }, pins: { number: ctx.number ?? null, headRefOid: OID } }),
      execute: async (ctx) => { ctx.markInFlight(); ctx.settle({ state: 'done', fields: { mergeCommitOid: OID } }); },
    }));
    await start();
    const phone = device('phone');
    expect(await config(phone)).toMatchObject({ gitPrMerge: { methods: ['squash'] } });
    const facts = await (await call(phone, 'POST', 's1/git/pr/1980/merge/preview', {})).json() as Record<string, unknown>;
    const body = { requestId: randomUUID(), confirmToken: facts.confirmToken, expectHead: OID, method: 'squash', subject: 'T (#1980)', body: '' };
    // A token minted for PR 1980 does not merge PR 1981.
    expect((await call(phone, 'POST', 's1/git/pr/1981/merge', body)).status).toBe(409);
    const t2 = (await (await call(phone, 'POST', 's1/git/pr/1980/merge/preview', {})).json() as Record<string, unknown>).confirmToken;
    const second = { ...body, requestId: randomUUID(), confirmToken: t2 };
    expect((await call(phone, 'POST', 's1/git/pr/1980/merge', second)).status).toBe(202);
    await vi.waitFor(async () => expect(await (await call(phone, 'GET', `s1/git/pr/1980/merge/${second.requestId}`)).json()).toMatchObject({ state: 'done', mergeCommitOid: OID }));
    expect((await call(phone, 'GET', `s1/git/pr/999/merge/${second.requestId}`)).status).toBe(404);
  });

  it('keeps receipts across a restart for 72 hours, then answers receipt-expired', async () => {
    const runs = stubPush();
    await start();
    const phone = device('phone');
    const facts = await preview(phone);
    const body = { requestId: randomUUID(), confirmToken: facts.confirmToken, expectedHead: OID, expectedRef: REF };
    expect((await call(phone, 'POST', 's1/git/push', body)).status).toBe(202);
    await vi.waitFor(async () => expect(await (await call(phone, 'GET', `s1/git/push/${body.requestId}`)).json()).toMatchObject({ state: 'done' }));
    await new Promise((r) => setImmediate(r));
    // A new daemon: tokens are gone, the receipt is not.
    gate = undefined;
    expect(await (await call(phone, 'POST', 's1/git/push', body)).json()).toMatchObject({ replayed: true, state: 'done' });
    // Another device does not see it.
    expect((await call(device('other'), 'GET', `s1/git/push/${body.requestId}`)).status).toBe(404);
    now += GIT_WRITE_RECEIPT_TTL_MS;
    const expired = await call(phone, 'GET', `s1/git/push/${body.requestId}`);
    expect(expired.status).toBe(404);
    expect(await expired.json()).toEqual({ error: 'receipt-expired' });
    expect(runs).toHaveLength(1);
  });
});

describe('DeviceStore explicit input grant', () => {
  it('passes a chosen grant and refuses a grandfathered or revoked one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-git-write-devices-'));
    try {
      const store = new DeviceStore({ wmuxDir: dir });
      const granted = await store.mint({ name: 'phone', allowInput: true });
      const viewer = await store.mint({ name: 'viewer', allowInput: false });
      const legacy = await store.mint({ name: 'legacy', allowInput: true });
      const file = path.join(dir, 'devices.json');
      const state = JSON.parse(fs.readFileSync(file, 'utf8')) as { devices: Array<Record<string, unknown>> };
      for (const d of state.devices) if (d.deviceId === legacy.deviceId) delete d.allowInput;
      fs.writeFileSync(file, JSON.stringify(state));
      const reloaded = new DeviceStore({ wmuxDir: dir });
      expect(reloaded.hasExplicitInputGrant(granted.deviceId)).toBe(true);
      expect(reloaded.hasExplicitInputGrant(viewer.deviceId)).toBe(false);
      // The input path still grandfathers it; the git write path does not.
      expect(reloaded.list().find((d) => d.deviceId === legacy.deviceId)?.allowInput).toBe(true);
      expect(reloaded.hasExplicitInputGrant(legacy.deviceId)).toBe(false);
      expect(reloaded.revoke(granted.deviceId, 'desktop').ok).toBe(true);
      expect(reloaded.hasExplicitInputGrant(granted.deviceId)).toBe(false);
      expect(reloaded.hasExplicitInputGrant('nope')).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
