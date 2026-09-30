import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { WebTerminalServer, type WebDeviceResolver, type WebTerminalStartOptions } from '../WebTerminalServer';
import { buildGitEnv } from '../sessionDiff';
import { PhoneWorktreeService } from '../phoneWorktree';
import { PHONE_WORKTREE_RECEIPTS_FILE } from '../phoneWorktreeReceipts';
import type { DaemonSessionManager } from '../../DaemonSessionManager';

/**
 * `POST …/git/worktree` and its receipt through the real HTTP surface: the
 * input grant, per-owner receipts, the fail-closed store and `gitWorktrees`.
 */

type Pane = { meta: { id: string; incarnationId: string; env: Record<string, string>; cwd: string; spawnCwd: string; state: string; cols: number; rows: number; lastActivity: string; createdAt: string } };
const pane = (id: string, spawnCwd: string, env: Record<string, string> = {}): Pane => ({
  meta: { id, incarnationId: `${id}-inc`, env, cwd: spawnCwd, spawnCwd, state: 'detached', cols: 80, rows: 24, lastActivity: '2026-09-01T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z' },
});
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

describe('phone worktree routes', { timeout: 60_000 }, () => {
  let root: string;
  let wmuxDir: string;
  let roster: Map<string, { secret: string; allowInput: boolean }>;
  let worktrees: PhoneWorktreeService | undefined;
  let audit: Array<[string, string]>;
  let server: WebTerminalServer;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-phone-wt-routes-')));
    process.env.HOME = root; process.env.USERPROFILE = root;
    wmuxDir = path.join(root, '.wmux-test');
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: buildGitEnv(), encoding: 'utf8' });
    run('init', '-q', '-b', 'main');
    run('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'base');
    const panes = new Map([['s1', pane('s1', repo)], ['marked', pane('marked', repo, { WMUX_BRAIN_PTY: '1' })]]);
    roster = new Map();
    audit = [];
    worktrees = undefined;
    const devices: WebDeviceResolver = {
      async mint() { throw new Error('unused'); },
      async resolve(deviceId, secret) {
        const d = roster.get(deviceId);
        return d && d.secret === secret ? { ok: true, deviceId, allowInput: d.allowInput } : { ok: false, reason: 'unknown' };
      },
    };
    const sessionManager = Object.assign(new EventEmitter(), {
      getSession: (id: string) => panes.get(id),
      listManagedSessions: () => [...panes.values()],
      listLiveSessions: () => [...panes.values()].map((p) => ({ ...p.meta })),
    }) as unknown as DaemonSessionManager;
    server = new WebTerminalServer({
      sessionManager,
      devices,
      phoneWorktrees: () => worktrees ??= new PhoneWorktreeService({ wmuxDir, audit: (d, r) => { audit.push([d, r]); } }),
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
    });
  });
  afterEach(async () => {
    if (server.isRunning) await server.stop();
    process.env.HOME = savedHome.HOME; process.env.USERPROFILE = savedHome.USERPROFILE;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const start = (over: Partial<WebTerminalStartOptions> = {}) =>
    server.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false, ...over });
  const base = () => `http://127.0.0.1:${server.status().port}`;
  const device = (id: string, allowInput: boolean) => { roster.set(id, { secret: 's', allowInput }); return { Authorization: `Bearer ${id}.s` }; };
  const post = (headers: Record<string, string>, body: unknown, session = 's1') =>
    fetch(`${base()}/api/sessions/${session}/git/worktree`, { method: 'POST', headers, body: JSON.stringify(body) });
  const receipt = async (headers: Record<string, string>, requestId: string) =>
    (await fetch(`${base()}/api/sessions/s1/git/worktree/${requestId}`, { headers })).json() as Promise<Record<string, unknown>>;

  it('creates through a paired phone, polls the receipt to created, and replays', async () => {
    await start();
    const phone = device('phone', true);
    expect(await (await fetch(`${base()}/api/config`, { headers: phone })).json()).toMatchObject({ gitWorktrees: true });
    const requestId = randomUUID();
    const res = await post(phone, { slug: 'fix-login', requestId });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ requestId, replayed: false, state: 'pending' });
    await vi.waitFor(async () => expect((await receipt(phone, requestId)).state).toBe('created'), { timeout: 20_000, interval: 100 });
    const created = await receipt(phone, requestId);
    expect(created).toMatchObject({ branch: 'phone/fix-login', leaf: 'phone-fix-login' });
    expect(fs.existsSync(created.cwd as string)).toBe(true);
    const replay = await post(phone, { slug: 'fix-login', requestId });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...created, replayed: true });
    expect((await post(phone, { slug: 'other', requestId })).status).toBe(409);
    // Another owner does not see it, and a different id reads `none`.
    expect(await receipt(device('other', true), requestId)).toEqual({ requestId, state: 'none' });
    const unknownId = randomUUID();
    expect(await receipt(phone, unknownId)).toEqual({ requestId: unknownId, state: 'none' });
    expect(audit).toEqual([['phone', 'created']]);
  });

  it('refuses without the grant, on the brain pane, and on a malformed body or id', async () => {
    await start();
    const readOnly = device('ro', false);
    expect(await (await fetch(`${base()}/api/config`, { headers: readOnly })).json()).not.toHaveProperty('gitWorktrees');
    expect((await post(readOnly, { slug: 'x', requestId: randomUUID() })).status).toBe(403);
    expect((await fetch(`${base()}/api/sessions/s1/git/worktree/${randomUUID()}`, { headers: readOnly })).status).toBe(403);
    const phone = device('phone', true);
    expect((await post(phone, { slug: 'x', requestId: randomUUID() }, 'marked')).status).toBe(404);
    const slug = await post(phone, { slug: 'refs/heads/main', requestId: randomUUID() });
    expect(slug.status).toBe(400);
    expect(await slug.json()).toEqual({ error: 'invalid-slug' });
    const extra = await post(phone, { slug: 'x', requestId: randomUUID(), path: root });
    expect(await extra.json()).toEqual({ error: 'invalid-git-request' });
    expect((await fetch(`${base()}/api/sessions/s1/git/worktree/not-a-uuid`, { headers: phone })).status).toBe(400);
    expect(audit).toEqual([]);
  });

  it('turns the routes off and hides gitWorktrees when the receipt store cannot be read', async () => {
    fs.mkdirSync(wmuxDir, { recursive: true });
    fs.writeFileSync(path.join(wmuxDir, PHONE_WORKTREE_RECEIPTS_FILE), '{truncated');
    const info = await start();
    const operator = { Authorization: `Bearer ${info.token as string}` };
    const config = await (await fetch(`${base()}/api/config`, { headers: operator })).json();
    expect(config).toMatchObject({ gitProjects: true });
    expect(config).not.toHaveProperty('gitWorktrees');
    const res = await post(operator, { slug: 'x', requestId: randomUUID() });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'git-receipts-unavailable' });
    expect((await fetch(`${base()}/api/sessions/s1/git/worktree/${randomUUID()}`, { headers: operator })).status).toBe(503);
  });
});
