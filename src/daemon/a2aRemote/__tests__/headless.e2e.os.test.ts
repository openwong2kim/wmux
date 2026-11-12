// Two PCs, no app on either: A asks, B runs only the daemon in headless mode
// and starts the agent itself (real git worktree, a fake session port in
// place of the PTY). Real listeners on loopback TLS, as spawn.e2e.os.test.ts.
// Also a start cut between the worktree and the session, then a restart of
// B's stores: nothing of it is left. Hermetic about pane identity: nothing
// here reads WMUX_* from the environment it runs in.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { A2A_FEATURE_SPAWN, type HostId } from '../../../shared/a2aRemote';
import { asSpawnLinkId, spawnFirstMessageId } from '../../../shared/a2aSpawn';
import type { DaemonConfig } from '../../types';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { createSpawnWorktree, gitRunner, removeSpawnWorktree } from '../../../main/a2aRemote/spawnWorktree';
import { A2aRemoteController } from '../controller';
import { A2aRemoteDelivery } from '../delivery';
import { ExposedPaneCache } from '../exposedPanes';
import { ExposureStore } from '../exposureStore';
import { HeadlessMode, headlessFlagPath, headlessReleases } from '../headlessMode';
import { HeadlessStartStore } from '../headlessStartStore';
import { A2aHeadlessStarter, headlessTreeId, worktreeUnchanged, type HeadlessSessionInput, type HeadlessSessionPort } from '../headlessStarter';
import { remoteTaskId } from '../ids';
import { joinRemoteHost } from '../joiner';
import { registerA2aLinkRpc } from '../linkRpc';
import { LinkStore } from '../linkStore';
import { linkAlias } from '../outbound';
import { PeerStore } from '../peerStore';
import { RemoteHostStore } from '../remoteHostStore';
import { createA2aRoutes } from '../routes';
import { A2aServer } from '../server';
import { SpawnLinkStore } from '../spawnLinkStore';
import { SpawnOutgoingStore } from '../spawnOutgoingStore';
import { SpawnPolicyStore } from '../spawnPolicyStore';
import { A2aSpawnReceiver } from '../spawnReceiver';
import { A2aSpawnRequester } from '../spawnRequester';
import { SpawnRequestStore } from '../spawnRequestStore';
import { A2aSpawnStarter } from '../spawnStarter';
import { freePort } from './a2aServerRig';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 90_000 });

const FAST = { connectMs: 5_000, requestMs: 10_000 };
const TIMING = { backoffMinMs: 30, backoffMaxMs: 150, livenessMs: 10_000, connectMs: 5_000, requestMs: 10_000 };
const PROMPT = 'fix the build';
const quiet = (): void => undefined;

interface Pc {
  name: string;
  dir: string;
  hostId: string;
  remoteHosts: RemoteHostStore;
  delivery: A2aRemoteDelivery;
  server: A2aServer;
  policy: SpawnPolicyStore;
  spawn: A2aSpawnReceiver;
  links: LinkStore;
  tasks: A2aTaskService;
  asks: A2aSpawnRequester | null;
  headless: A2aHeadlessStarter | null;
  starts: HeadlessStartStore | null;
  sessions: FakeSessions;
  stop: () => Promise<void>;
}

interface FakeSessions extends HeadlessSessionPort {
  made: HeadlessSessionInput[];
  live: Set<string>;
  /** Hold `create` until released (a start cut between the worktree and the session). */
  hold?: Promise<void>;
}

const pcs: Pc[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const pc of pcs) pc.headless?.stop();
  await Promise.all(pcs.splice(0).map((pc) => Promise.race([pc.stop(), new Promise<void>((r) => setTimeout(r, 15_000))])));
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function fakeSessions(): FakeSessions {
  const s: FakeSessions = {
    made: [],
    live: new Set(),
    resolveAgent: async () => '/opt/fake/bin/claude',
    create: async (input) => {
      if (s.hold) await s.hold;
      s.made.push(input);
      s.live.add(input.sessionId);
      return {};
    },
    alive: (id) => s.live.has(id),
    destroy: async (id) => {
      s.live.delete(id);
      return { ok: true };
    },
    killEarlier: async () => ({ ok: true }),
    stillRunning: async () => [],
  };
  return s;
}

/** A git repository with one commit, and a git config of its own (nothing of the user's). */
function makeRepo(dir: string): { repo: string; gitEnv: Record<string, string> } {
  const repo = path.join(dir, 'repo');
  const globalConfig = path.join(dir, 'global.gitconfig');
  fs.writeFileSync(globalConfig, '');
  const gitEnv = { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' };
  const g = (...args: string[]): void => void execFileSync('git', args, { cwd: dir, env: { ...process.env, ...gitEnv } });
  fs.mkdirSync(repo);
  g('init', '-q', '-b', 'main', repo);
  g('-C', repo, 'config', 'user.name', 't');
  g('-C', repo, 'config', 'user.email', 't@example.invalid');
  fs.writeFileSync(path.join(repo, 'README.md'), 'r\n');
  g('-C', repo, 'add', '.');
  g('-C', repo, 'commit', '-qm', 'init');
  return { repo, gitEnv };
}

interface HeadlessParts {
  starter: A2aHeadlessStarter;
  starts: HeadlessStartStore;
  spawnStarter: A2aSpawnStarter;
}

/** B's headless side over `a2aDir`: the start record store, the starter and its ports. */
function headlessParts(opts: {
  a2aDir: string; dir: string; gitEnv: Record<string, string>; mode: HeadlessMode; sessions: FakeSessions; runId: string;
  receiver: () => A2aSpawnReceiver; requests: SpawnRequestStore; links: LinkStore; spawnStarter: A2aSpawnStarter; spawnLinks: SpawnLinkStore;
  paneGone?: (workspaceId: string, paneId: string) => Promise<void>;
}): HeadlessParts {
  const store = { dir: opts.a2aDir, scheduleHarden: quiet };
  const starts = new HeadlessStartStore(store);
  const wtOpts = { worktreesRoot: path.join(opts.dir, 'worktrees'), noHooksDir: path.join(opts.dir, 'no-hooks'), env: opts.gitEnv };
  const starter = new A2aHeadlessStarter({
    mode: opts.mode,
    receiver: {
      claim: (h, s) => opts.receiver().claim(h, s),
      started: (h, s, end) => opts.receiver().started(h, s, end),
      failed: (h, s, code) => opts.receiver().failed(h, s, code),
    },
    requests: opts.requests,
    links: opts.links,
    activationOwed: (linkId) => opts.spawnLinks.get(linkId)?.phase === 'committed',
    starts,
    sessions: () => opts.sessions,
    worktrees: {
      create: (input) => createSpawnWorktree(input, wtOpts),
      remove: (input) => removeSpawnWorktree(input, wtOpts),
      exists: (p) => fs.existsSync(p),
      // `dir` is a realpath already, as createSpawnWorktree resolves its root.
      pathFor: (spawnId) => path.join(wtOpts.worktreesRoot, `remote-${spawnId}`),
      baseOf: async (wt) => {
        const out = await gitRunner(wt, wtOpts)(['rev-parse', 'HEAD']);
        return out.code === 0 ? out.stdout.trim() : null;
      },
      pristine: (wt, base, branch) => worktreeUnchanged(gitRunner(wt, wtOpts), base, branch),
    },
    releases: headlessReleases(opts.a2aDir),
    paneGone: opts.paneGone ?? (async () => undefined),
    abandon: (h, s) => opts.spawnStarter.abandon(h, s),
    runId: opts.runId,
    log: quiet,
  });
  return { starter, starts, spawnStarter: opts.spawnStarter };
}

async function makePc(name: string, opts: { headless?: boolean; asking?: boolean } = {}): Promise<Pc> {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-headless-e2e-')));
  dirs.push(dir);
  const a2aDir = path.join(dir, 'a2a');
  const port = await freePort();
  const store = { dir: a2aDir, scheduleHarden: quiet };
  const log = new AppendOnlyLog({ dir: path.join(dir, 'log'), fsync: () => undefined });
  log.open();
  const tasks = new A2aTaskService({ log, origin: { machineId: name, daemonEpoch: 1 } });
  tasks.restoreFromLog();
  let delivery: A2aRemoteDelivery | null = null;
  let spawnStarter: A2aSpawnStarter | null = null;
  let headless: A2aHeadlessStarter | null = null;
  const links = new LinkStore({
    ...store,
    onTransition: (l) => { delivery?.onLinkTransition(l); spawnStarter?.onLinkTransition(l); headless?.onLinkTransition(l); },
  });
  const exposures = new ExposureStore(store);
  const panes = new ExposedPaneCache();
  const peers = new PeerStore(store);
  const remoteHosts = new RemoteHostStore({ dir: a2aDir });
  const policy = new SpawnPolicyStore(store);
  const requests = new SpawnRequestStore(store);
  const sessions = fakeSessions();
  const spawnLinks = new SpawnLinkStore(store);
  fs.mkdirSync(a2aDir, { recursive: true });
  if (opts.headless) {
    fs.writeFileSync(headlessFlagPath(a2aDir), 'on\n');
    spawnStarter = new A2aSpawnStarter({
      links, spawnLinks, exposures, taskService: tasks, policy,
      hostName: () => 'PC-A', aliasFor: (l) => linkAlias(l, 'PC-A'), broadcast: quiet, log: quiet,
    });
  }
  const mode = new HeadlessMode({ a2aDir, appHostAtBoot: false });
  const asks = opts.asking
    ? new A2aSpawnRequester({
      store: new SpawnOutgoingStore(store),
      links,
      taskService: tasks,
      enqueue: (h, env) => void delivery!.outbox.enqueue(h, env),
      hosts: () => delivery!.status().map((h) => ({ hostId: h.hostId, name: h.name, online: h.state === 'connected' })),
      features: (h) => delivery!.peerFeatures(h),
      aliasFor: (l) => linkAlias(l, 'PC'),
      broadcast: quiet,
      log: quiet,
    })
    : null;
  const started = spawnStarter;
  const spawn = new A2aSpawnReceiver({
    policy,
    requests,
    enqueue: (h, env) => void delivery!.outbox.enqueue(h, env),
    agentInstalled: async () => true,
    // No app here: it never catches up. Headless mode does not wait for it.
    appReady: () => false,
    headless: () => mode.active(),
    onChange: (h, spawnId, state) => {
      if (state === 'approved') void headless?.start(h as HostId, spawnId);
    },
    ...(asks ? {
      isOutstanding: (h, id) => asks.isOutstanding(h, id),
      onResult: (from, result) => asks.onResult(from, result),
      onTargets: (from, t) => asks.onTargets(from, t),
    } : {}),
    ...(started ? { start: started, abandon: (h, id) => started.abandon(h, id), liveSpawns: (h) => started.liveCount(h) } : {}),
    log: quiet,
  });
  const routes = createA2aRoutes({ exposures, panes, links, broadcast: quiet, log: quiet });
  const config = { a2aRemote: { enabled: true, port } } as unknown as DaemonConfig;
  const server = new A2aServer({
    controller: new A2aRemoteController({ config, persist: quiet }),
    identityDir: a2aDir,
    peers,
    onPeerRevoked: (hostId) => delivery?.onPeerRevoked(hostId),
    routes,
    hostname: () => name,
    ipv4s: () => ['127.0.0.1'],
    bindHost: '127.0.0.1',
    log: quiet,
  });
  await server.whenIdle();
  const handlers = new Map<string, (p: Record<string, unknown>) => Promise<unknown>>();
  const onRpc = (m: string, h: (p: Record<string, unknown>) => Promise<unknown>): void => void handlers.set(m, h);
  registerA2aLinkRpc(onRpc, {
    links, exposures, panes, remoteHosts, broadcast: quiet, log: quiet, timeouts: FAST,
    notifyLinkChange: (...args) => delivery?.notifyLinkChange(...args),
  });
  delivery = new A2aRemoteDelivery({
    dir: a2aDir,
    links,
    taskService: tasks,
    peers,
    remoteHosts,
    broadcast: quiet,
    refreshLink: (linkId) => handlers.get('a2a.remote.links.refresh')!({ linkId }),
    spawn,
    ...(started ? { spawnLinks: started } : {}),
    ...(asks ? { spawnAsks: asks } : {}),
    features: [A2A_FEATURE_SPAWN],
    log: quiet,
    timing: TIMING,
    heartbeatMs: 200,
    syncMs: 50,
  });
  delivery.registerRoutes(routes);
  delivery.registerRpc(onRpc);
  delivery.start();
  let starts: HeadlessStartStore | null = null;
  if (opts.headless && spawnStarter) {
    const { gitEnv } = makeRepo(dir);
    const parts = headlessParts({
      a2aDir, dir, gitEnv, mode, sessions, runId: 'run-1', receiver: () => spawn, requests, links, spawnStarter, spawnLinks,
      paneGone: async (workspaceId, paneId) => void (await handlers.get('a2a.remote.local.paneGone')!({ workspaceId, paneId, reason: 'pane-closed' })),
    });
    headless = parts.starter;
    starts = parts.starts;
  }
  const pc: Pc = {
    name, dir, hostId: server.ensureIdentity().hostId, remoteHosts, delivery, server, policy, spawn, links, tasks, asks, headless, starts, sessions,
    stop: async () => {
      await delivery!.stop();
      server.dispose();
      await server.whenIdle();
      log.close();
    },
  };
  pcs.push(pc);
  return pc;
}

async function pair(joiner: Pc, server: Pc): Promise<void> {
  const res = await joinRemoteHost(server.server.beginPairing().invite, {
    self: () => joiner.server.ensureIdentity(),
    selfName: joiner.name,
    remoteHosts: joiner.remoteHosts,
    timeouts: FAST,
  });
  expect(res.ok).toBe(true);
  joiner.delivery.syncSessions();
}

async function until(cond: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** B (the box) allows A, claude and its repository as root `web`, approval by allow list only. */
async function allow(b: Pc, aHostId: string, rules: Array<{ hostId: string; rootId: string; agent: 'claude' }>): Promise<void> {
  const set = await b.policy.set({
    v: 1, enabled: true, approval: 'allow-list', followUps: 'direct', permissionMode: 'auto',
    hosts: { [aHostId]: { allowed: true } }, roots: [{ id: 'web', label: 'Web', path: path.join(b.dir, 'repo') }], agents: ['claude'], rules, version: 0,
  });
  expect(set.ok).toBe(true);
}

async function ask(a: Pc, b: Pc): Promise<string> {
  b.spawn.sendTargets({ ...b.policy.get(), hosts: {} });
  await until(() => a.asks!.list().places.some((p) => p.hostId === b.hostId && p.supported && p.targets !== undefined));
  const asked = a.asks!.ask({
    pc: b.hostId, agent: 'claude', folder: { root: 'web' }, text: PROMPT,
    from: { kind: 'pane', workspaceId: 'ws-a', paneId: 'pane-a' }, callerKey: 'pane-a',
  });
  expect(asked).toMatchObject({ ok: true });
  return asked.ok ? asked.spawn.spawnId : '';
}

describe('headless remote spawn, two PCs and no app', () => {
  it('a request no rule matches is refused at once, and nothing is created', async () => {
    const a = await makePc('PC-A', { asking: true });
    const b = await makePc('PC-B', { headless: true });
    await pair(a, b);
    await allow(b, a.hostId, []);
    const spawnId = await ask(a, b);
    await until(() => a.asks!.list(spawnId).requests[0]?.state === 'refused', 10_000);
    expect(a.asks!.list(spawnId).requests[0]).toMatchObject({ code: 'not-allowed' });
    expect(b.sessions.made).toEqual([]);
    expect(b.starts!.list()).toEqual([]);
    expect(fs.existsSync(path.join(b.dir, 'worktrees'))).toBe(false);
  });

  it('a request a rule matches is started by the daemon: worktree, session, `started` with that session, and the prompt only as the first task', async () => {
    const a = await makePc('PC-A', { asking: true });
    const b = await makePc('PC-B', { headless: true });
    await pair(a, b);
    await allow(b, a.hostId, [{ hostId: a.hostId, rootId: 'web', agent: 'claude' }]);
    const spawnId = await ask(a, b);
    await until(() => a.asks!.list(spawnId).requests[0]?.state === 'started');

    const rec = b.starts!.get(a.hostId, spawnId)!;
    expect(rec).toMatchObject({ phase: 'started', lineage: `remote-spawn:${a.hostId}` });
    expect(fs.existsSync(path.join(b.dir, 'worktrees', `remote-${headlessTreeId(a.hostId, spawnId)}`))).toBe(true);
    expect(b.sessions.made).toHaveLength(1);
    expect(b.sessions.made[0]).toMatchObject({ sessionId: rec.sessionId, workspaceId: rec.workspaceId, agentBin: '/opt/fake/bin/claude' });
    expect(JSON.stringify(b.sessions.made[0])).not.toContain(PROMPT);

    const linkId = asSpawnLinkId(a.asks!.list(spawnId).requests[0].linkId)!;
    expect(a.links.get(linkId)).toMatchObject({ state: 'active', remote: { hostId: b.hostId, kind: 'pane', workspaceId: rec.workspaceId, paneId: rec.sessionId } });
    const task = b.tasks.getTask(remoteTaskId(linkId, spawnFirstMessageId(linkId)));
    expect(task?.metadata.to).toMatchObject({ workspaceId: rec.workspaceId, paneId: rec.sessionId });
    expect(task?.history[0].parts).toEqual([{ kind: 'text', text: PROMPT }]);

    // The agent wrote something: its worktree is kept when it ends.
    fs.writeFileSync(path.join(b.dir, 'worktrees', `remote-${headlessTreeId(a.hostId, spawnId)}`, 'notes.txt'), 'work\n');
    // The agent's session ends: its link breaks on both PCs and nothing counts as live.
    b.sessions.live.delete(rec.sessionId);
    b.headless!.onSessionGone(rec.sessionId);
    await b.headless!.reconcile();
    expect(b.links.get(linkId)?.state).toBe('broken');
    await until(() => a.links.get(linkId)?.state === 'broken');
    expect(b.starts!.get(a.hostId, spawnId)?.phase).toBe('ended');
    // The worktree (the agent's work) is kept.
    expect(fs.existsSync(path.join(b.dir, 'worktrees', `remote-${headlessTreeId(a.hostId, spawnId)}`))).toBe(true);
  });

  it('removing the asking PC ends its agent here', async () => {
    const a = await makePc('PC-A', { asking: true });
    const b = await makePc('PC-B', { headless: true });
    await pair(a, b);
    await allow(b, a.hostId, [{ hostId: a.hostId, rootId: 'web', agent: 'claude' }]);
    const spawnId = await ask(a, b);
    await until(() => a.asks!.list(spawnId).requests[0]?.state === 'started');
    const rec = b.starts!.get(a.hostId, spawnId)!;
    expect(b.sessions.live.has(rec.sessionId)).toBe(true);
    // The unpair cascade: the PC's links end and its requests are forgotten.
    b.links.forgetHost(a.hostId as HostId);
    await b.headless!.reconcile();
    expect(b.sessions.live.has(rec.sessionId)).toBe(false);
    // Its worktree was left unchanged (no commit, clean): removed with its branch, and nothing is left to list.
    expect(b.starts!.get(a.hostId, spawnId)).toBeUndefined();
    expect(fs.existsSync(path.join(b.dir, 'worktrees', `remote-${headlessTreeId(a.hostId, spawnId)}`))).toBe(false);
  });

  it('a worktree holding only ignored files the agent wrote is kept', async () => {
    const a = await makePc('PC-A', { asking: true });
    const b = await makePc('PC-B', { headless: true });
    await pair(a, b);
    await allow(b, a.hostId, [{ hostId: a.hostId, rootId: 'web', agent: 'claude' }]);
    const spawnId = await ask(a, b);
    await until(() => a.asks!.list(spawnId).requests[0]?.state === 'started');
    const wt = path.join(b.dir, 'worktrees', `remote-${headlessTreeId(a.hostId, spawnId)}`);
    // No commit, nothing git status lists by default: the agent's output is all ignored.
    fs.appendFileSync(path.join(b.dir, 'repo', '.git', 'info', 'exclude'), 'out/\n');
    fs.mkdirSync(path.join(wt, 'out'));
    fs.writeFileSync(path.join(wt, 'out', 'report.md'), 'the agent\'s work\n');
    b.links.forgetHost(a.hostId as HostId);
    await b.headless!.reconcile();
    expect(b.starts!.get(a.hostId, spawnId)?.phase).toBe('ended');
    expect(fs.readFileSync(path.join(wt, 'out', 'report.md'), 'utf8')).toBe('the agent\'s work\n');
  });

  it('a commit left on its branch is kept, even with the worktree back on the base commit', async () => {
    const a = await makePc('PC-A', { asking: true });
    const b = await makePc('PC-B', { headless: true });
    await pair(a, b);
    await allow(b, a.hostId, [{ hostId: a.hostId, rootId: 'web', agent: 'claude' }]);
    const spawnId = await ask(a, b);
    await until(() => a.asks!.list(spawnId).requests[0]?.state === 'started');
    const wt = path.join(b.dir, 'worktrees', `remote-${headlessTreeId(a.hostId, spawnId)}`);
    const git = (...args: string[]): string => execFileSync('git', ['-C', wt, ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(b.dir, 'global.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8',
    }).trim();
    const base = git('rev-parse', 'HEAD');
    // The agent commits, then checks the base out again (detached): HEAD and status look untouched.
    fs.writeFileSync(path.join(wt, 'work.txt'), 'work\n');
    git('add', '.');
    git('commit', '-qm', 'work');
    const work = git('rev-parse', 'HEAD');
    git('checkout', '-q', '--detach', base);
    b.links.forgetHost(a.hostId as HostId);
    await b.headless!.reconcile();
    expect(b.starts!.get(a.hostId, spawnId)?.phase).toBe('ended');
    expect(git('rev-parse', `refs/heads/wmux/remote/${headlessTreeId(a.hostId, spawnId)}`)).toBe(work);
    expect(fs.existsSync(wt)).toBe(true);
  });

  /**
   * B's daemon "dies" with the worktree made and no session; `cut` changes what
   * it left on disk. Then a new daemon run over the same files reconciles:
   * nothing of the start is left, its branch and git's worktree entry included.
   */
  async function cutThenRestart(cut: (b: Pc, hostId: string, spawnId: string, wt: string) => void = () => undefined): Promise<void> {
    const a = await makePc('PC-A', { asking: true });
    const b = await makePc('PC-B', { headless: true });
    await pair(a, b);
    await allow(b, a.hostId, [{ hostId: a.hostId, rootId: 'web', agent: 'claude' }]);
    // The session never comes: the daemon "dies" with the worktree made.
    b.sessions.hold = new Promise<void>(() => undefined);
    const spawnId = await ask(a, b);
    const wt = path.join(b.dir, 'worktrees', `remote-${headlessTreeId(a.hostId, spawnId)}`);
    await until(() => fs.existsSync(wt) && b.starts!.get(a.hostId, spawnId)?.worktreePath !== undefined);
    b.headless!.stop();
    cut(b, a.hostId, spawnId, wt);

    // A new daemon run over the same files: its stores, receiver and starter.
    const a2aDir = path.join(b.dir, 'a2a');
    const store = { dir: a2aDir, scheduleHarden: quiet };
    const requests = new SpawnRequestStore(store);
    const links = new LinkStore(store);
    const policy = new SpawnPolicyStore(store);
    const log = new AppendOnlyLog({ dir: path.join(b.dir, 'log2'), fsync: () => undefined });
    log.open();
    const tasks = new A2aTaskService({ log, origin: { machineId: 'b2', daemonEpoch: 2 } });
    const spawnLinks = new SpawnLinkStore(store);
    const spawnStarter = new A2aSpawnStarter({
      links, spawnLinks, exposures: new ExposureStore(store), taskService: tasks, policy,
      hostName: () => 'PC-A', aliasFor: (l) => linkAlias(l, 'PC-A'), broadcast: quiet, log: quiet,
    });
    const answers: string[] = [];
    const receiver = new A2aSpawnReceiver({
      policy, requests, enqueue: (_h, env) => void answers.push(env.spawnResult?.code ?? ''), log: quiet,
      start: spawnStarter, abandon: (h, s) => spawnStarter.abandon(h, s), headless: () => true,
    });
    const sessions = fakeSessions();
    const gitEnv = { GIT_CONFIG_GLOBAL: path.join(b.dir, 'global.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
    const mode = new HeadlessMode({ a2aDir, appHostAtBoot: false });
    const parts = headlessParts({ a2aDir, dir: b.dir, gitEnv, mode, sessions, runId: 'run-2', receiver: () => receiver, requests, links, spawnStarter, spawnLinks });
    receiver.recover();
    await parts.starter.reconcile();
    receiver.stop();
    log.close();

    expect(fs.existsSync(wt)).toBe(false);
    expect(parts.starts.list()).toEqual([]);
    expect(requests.get(a.hostId as HostId, spawnId)).toMatchObject({ state: 'decided', code: 'failed' });
    expect(answers).toContain('failed');
    expect(spawnStarter.liveCount()).toBe(0);
    expect(sessions.made).toEqual([]);
    const git = (...args: string[]): string => execFileSync('git', ['-C', path.join(b.dir, 'repo'), ...args], { env: { ...process.env, ...gitEnv }, encoding: 'utf8' });
    expect(git('worktree', 'list', '--porcelain')).not.toContain(`remote-${spawnId}`);
    expect(git('branch', '--list', `wmux/remote/${spawnId}`).trim()).toBe('');
  }

  it('a start cut between the worktree and the session leaves nothing after a restart', async () => {
    await cutThenRestart();
  });

  it('a start cut inside `git worktree add` (path not recorded yet, worktree still locked) leaves nothing after a restart', async () => {
    await cutThenRestart((b, hostId, spawnId, wt) => {
      // Only the path it was about to use is on record, and git still holds
      // the worktree locked, as a `git worktree add` killed mid-checkout leaves it.
      b.starts!.update(hostId, spawnId, { worktreePath: undefined, cwd: undefined, baseCommit: undefined });
      expect(b.starts!.get(hostId, spawnId)?.worktreeIntended).toBe(wt);
      execFileSync('git', ['-C', path.join(b.dir, 'repo'), 'worktree', 'lock', '--reason', 'initializing', wt], {
        env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(b.dir, 'global.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' },
      });
    });
  });
});
