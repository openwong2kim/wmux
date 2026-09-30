import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { WebTerminalServer, type WebDeviceResolver, type WebTerminalStartOptions } from '../WebTerminalServer';
import { buildGitEnv, createGitRunner, type GitRunner } from '../sessionDiff';
import type { DaemonSessionManager } from '../../DaemonSessionManager';

/**
 * Phone Git v1 reads through the real HTTP surface: the input grant, the pane
 * rule (never the brain pane), the discovery keys and the shared Git budget.
 */

type Pane = { meta: { id: string; incarnationId: string; env: Record<string, string>; cwd: string; spawnCwd: string; state: string; cols: number; rows: number; lastActivity: string; createdAt: string } };
const pane = (id: string, spawnCwd: string, env: Record<string, string> = {}, lastActivity = '2026-09-01T00:00:00.000Z'): Pane => ({
  meta: { id, incarnationId: `${id}-inc`, env, cwd: spawnCwd, spawnCwd, state: 'detached', cols: 80, rows: 24, lastActivity, createdAt: lastActivity },
});

const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let root: string;
const init = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true });
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: buildGitEnv(), encoding: 'utf8' });
  run('init', '-q', '-b', 'main');
  run('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'base');
};

describe('phone Git read routes', { timeout: 30_000 }, () => {
  let panes: Map<string, Pane>;
  let roster: Map<string, { secret: string; allowInput: boolean }>;
  let gitRunner: GitRunner;
  let server: WebTerminalServer;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-phone-git-routes-')));
    process.env.HOME = root; process.env.USERPROFILE = root;
    init(path.join(root, 'app'));
    init(path.join(root, 'brain-repo'));
    fs.mkdirSync(path.join(root, 'plain'));
  });
  afterAll(() => {
    process.env.HOME = savedHome.HOME; process.env.USERPROFILE = savedHome.USERPROFILE;
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    panes = new Map([
      ['s1', pane('s1', path.join(root, 'app'))],
      ['plain', pane('plain', path.join(root, 'plain'))],
      ['marked', pane('marked', path.join(root, 'brain-repo'), { WMUX_BRAIN_PTY: '1' }, '2026-09-09T00:00:00.000Z')],
    ]);
    roster = new Map();
    const real = createGitRunner();
    gitRunner = real;
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
      git: (args, cwd) => gitRunner(args, cwd),
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
    });
  });
  afterEach(async () => {
    if (server.isRunning) await server.stop();
  });

  const start = (over: Partial<WebTerminalStartOptions> = {}) =>
    server.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false, ...over });
  const base = () => `http://127.0.0.1:${server.status().port}`;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const device = (id: string, allowInput: boolean) => { roster.set(id, { secret: 's', allowInput }); return bearer(`${id}.s`); };
  const config = async (headers: Record<string, string>) => (await fetch(`${base()}/api/config`, { headers })).json() as Promise<Record<string, unknown>>;

  it('advertises and serves the reads only with the input grant', async () => {
    const info = await start({ allowInput: false });
    const operator = bearer(info.token as string);
    expect(await config(operator)).not.toHaveProperty('gitProjects');
    expect(await config(operator)).not.toHaveProperty('gitChecks');
    expect((await fetch(`${base()}/api/git/projects`, { headers: operator })).status).toBe(403);
    expect((await fetch(`${base()}/api/sessions/s1/git/branches`, { headers: operator })).status).toBe(403);
    await server.stop();
    const rw = await start();
    expect(await config(bearer(rw.token as string))).toMatchObject({ gitProjects: true, gitChecks: true });
    const readOnlyPhone = device('ro', false);
    expect(await config(readOnlyPhone)).not.toHaveProperty('gitProjects');
    expect((await fetch(`${base()}/api/git/projects`, { headers: readOnlyPhone })).status).toBe(403);
    expect((await fetch(`${base()}/api/git/projects`)).status).toBe(401);
  });

  it('lists projects without the brain pane, and 404s/409s per pane', async () => {
    await start();
    const phone = device('phone', true);
    const res = await fetch(`${base()}/api/git/projects`, { headers: phone });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json() as { projects: Array<{ name: string; sessionId: string }>; truncated: boolean };
    expect(body.projects.map((p) => [p.name, p.sessionId])).toEqual([['app', 's1']]);
    expect(body.truncated).toBe(false);
    expect((await fetch(`${base()}/api/sessions/marked/git/branches`, { headers: phone })).status).toBe(404);
    expect((await fetch(`${base()}/api/sessions/missing/git/checks`, { headers: phone })).status).toBe(404);
    const plain = await fetch(`${base()}/api/sessions/plain/git/branches`, { headers: phone });
    expect(plain.status).toBe(409);
    expect(await plain.json()).toEqual({ error: 'not-a-git-repo' });
    const branches = await (await fetch(`${base()}/api/sessions/s1/git/branches`, { headers: phone })).json();
    expect(branches).toMatchObject({ current: { branch: 'main', detached: false }, branches: [{ name: 'main', worktree: { main: true, sessionIds: ['s1'] } }] });
  });

  it('keeps the brain pane out of the operator project list too', async () => {
    const info = await start();
    const body = await (await fetch(`${base()}/api/git/projects`, { headers: bearer(info.token as string) })).json() as { projects: Array<{ name: string }> };
    expect(body.projects.map((p) => p.name)).toEqual(['app']);
  });

  it('shares the four-slot Git budget', async () => {
    const info = await start();
    const headers = bearer(info.token as string);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = vi.fn();
    const real = gitRunner;
    gitRunner = async (args, cwd) => { entered(); await gate; return real(args, cwd); };
    // `/checks` reads origin and branch uncached, so each held request is its own git call.
    const held = [0, 1, 2, 3].map(() => fetch(`${base()}/api/sessions/s1/git/checks`, { headers }));
    await vi.waitFor(() => expect(entered.mock.calls.length).toBeGreaterThanOrEqual(8));
    const refused = await fetch(`${base()}/api/git/projects`, { headers });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: 'git-busy' });
    release();
    for (const r of await Promise.all(held)) expect(r.status).toBe(200);
  });
});
