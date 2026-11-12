// The receiver's decision in headless mode (no app, the box's owner opted
// in): a rule approves, anything else is refused at once, `manual` is never
// started, and the app is not waited for. With headless mode off a host
// without the app keeps waiting for it, and nothing is approved or started.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A2A_REMOTE_PROTOCOL, type A2aRemoteEnvelope, type HostId } from '../../../shared/a2aRemote';
import type { A2aSpawnRequestState } from '../../../shared/a2aSpawn';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { ExposureStore } from '../exposureStore';
import { HeadlessStartStore } from '../headlessStartStore';
import { A2aHeadlessStarter } from '../headlessStarter';
import { LinkStore } from '../linkStore';
import { linkAlias } from '../outbound';
import { SpawnChecks } from '../spawnChecks';
import { SpawnLinkStore } from '../spawnLinkStore';
import { SpawnPolicyStore } from '../spawnPolicyStore';
import { A2aSpawnReceiver } from '../spawnReceiver';
import { SpawnRequestStore } from '../spawnRequestStore';
import { A2aSpawnStarter } from '../spawnStarter';

const HOST = '11111111-1111-4111-8111-111111111111' as HostId;
const quiet = (): void => undefined;

let dir: string;
let repo: string;
let policy: SpawnPolicyStore;
let requests: SpawnRequestStore;
let sent: string[];
let changes: Array<{ spawnId: string; state: A2aSpawnRequestState }>;
let headless: boolean;
let receiver: A2aSpawnReceiver;
let starter: A2aHeadlessStarter;
let made: string[];

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-spawn-headless-')));
  repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const store = { dir: path.join(dir, 'a2a'), scheduleHarden: quiet };
  policy = new SpawnPolicyStore(store);
  requests = new SpawnRequestStore(store);
  const links = new LinkStore(store);
  const log = new AppendOnlyLog({ dir: path.join(dir, 'log'), fsync: quiet });
  log.open();
  const tasks = new A2aTaskService({ log, origin: { machineId: 'b', daemonEpoch: 1 } });
  const spawnStarter = new A2aSpawnStarter({
    links, spawnLinks: new SpawnLinkStore(store), exposures: new ExposureStore(store), taskService: tasks, policy,
    hostName: () => 'HOME-A', aliasFor: (l) => linkAlias(l, 'HOME-A'), broadcast: quiet, log: quiet,
  });
  sent = [];
  changes = [];
  made = [];
  headless = true;
  receiver = new A2aSpawnReceiver({
    policy,
    requests,
    enqueue: (_h, env) => void sent.push(env.spawnResult?.code ?? ''),
    agentInstalled: async () => true,
    checks: new SpawnChecks(8),
    refusalCoalesceMs: 0,
    // No app on this host: it never catches up.
    appReady: () => false,
    headless: () => headless,
    onChange: (h, spawnId, state) => {
      changes.push({ spawnId, state });
      if (state === 'approved') void starter.start(h, spawnId);
    },
    start: spawnStarter,
    abandon: (h, s) => spawnStarter.abandon(h, s),
    retryMinMs: 60_000,
    log: quiet,
  });
  // Every pane and worktree call is recorded: none may happen in these cases.
  starter = new A2aHeadlessStarter({
    mode: { active: () => headless },
    receiver,
    requests,
    links,
    activationOwed: () => false,
    starts: new HeadlessStartStore(store),
    sessions: () => ({
      resolveAgent: async () => '/opt/fake/claude',
      create: async (input) => void made.push(`session:${input.sessionId}`),
      alive: () => false,
      destroy: async () => undefined,
    }),
    worktrees: {
      create: async (input) => {
        made.push(`worktree:${input.spawnId}`);
        return { ok: false, code: 'failed', detail: 'not in this test' };
      },
      remove: async () => undefined,
    },
    paneGone: async () => undefined,
    abandon: () => undefined,
    runId: 'run-1',
    log: quiet,
  });
});
afterEach(() => {
  receiver.stop();
  starter.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function allow(over: Record<string, unknown> = {}): Promise<void> {
  const res = await policy.set({
    v: 1, enabled: true, approval: 'allow-list', followUps: 'direct', permissionMode: 'auto',
    hosts: { [HOST]: { allowed: true } }, roots: [{ id: 'web', label: 'Web', path: repo }], agents: ['claude'], rules: [],
    version: policy.get().version,
    ...over,
  });
  expect(res.ok).toBe(true);
}

async function ask(agent: 'claude' | 'codex' = 'claude'): Promise<string> {
  const spawnId = `sp-${crypto.randomUUID()}`;
  const now = Date.now();
  const env: A2aRemoteEnvelope = {
    protocol: A2A_REMOTE_PROTOCOL, linkId: spawnId, linkVersion: 0, messageId: 'req', kind: 'link',
    link: { state: 'spawn', version: 0 },
    spawn: {
      v: 1, spawnId, agent, folder: { root: 'web' }, text: 'fix the build',
      expiresAt: new Date(now + 3600_000).toISOString(), from: { kind: 'pane', workspaceId: 'ws-a', paneId: 'pane-a' },
    },
    sentAt: new Date(now).toISOString(),
  };
  expect(await receiver.applyInbound(env, { hostId: HOST })).toMatchObject({ ok: true });
  await receiver.idle();
  return spawnId;
}

const RULE = { hostId: HOST, rootId: 'web', agent: 'claude' as const };

describe('spawn receiver in headless mode', () => {
  it('a request no rule matches is refused at once (`not-allowed`), never left awaiting a card', async () => {
    await allow();
    const spawnId = await ask();
    expect(requests.get(HOST, spawnId)).toMatchObject({ state: 'decided', code: 'not-allowed' });
    expect(sent).toEqual(['not-allowed']);
    expect(changes.some((c) => c.state === 'awaiting' || c.state === 'approved')).toBe(false);
    expect(made).toEqual([]);
  });

  it('with the ask approval a request is refused too: headless mode has no cards', async () => {
    await allow({ approval: 'ask', rules: [RULE] });
    const spawnId = await ask();
    expect(requests.get(HOST, spawnId)).toMatchObject({ state: 'decided', code: 'not-allowed' });
    expect(made).toEqual([]);
  });

  it('the manual permission mode is never started (`not-supported`)', async () => {
    await allow({ rules: [RULE], permissionMode: 'manual' });
    const spawnId = await ask();
    expect(requests.get(HOST, spawnId)).toMatchObject({ state: 'decided', code: 'not-supported' });
    expect(made).toEqual([]);
  });

  it('an agent other than Claude Code is not started (`not-supported`)', async () => {
    await allow({ agents: ['claude', 'codex'], rules: [{ ...RULE, agent: 'codex' }] });
    const spawnId = await ask('codex');
    expect(requests.get(HOST, spawnId)).toMatchObject({ state: 'decided', code: 'not-supported' });
    expect(made).toEqual([]);
  });

  it('a rule approves it without waiting for an app, and the daemon goes to start it', async () => {
    await allow({ rules: [RULE] });
    const spawnId = await ask();
    expect(changes).toContainEqual({ spawnId, state: 'approved' });
    // The starter claimed it and tried the worktree (refused by this test's port, so answered `failed`).
    await vi.waitFor(() => expect(requests.get(HOST, spawnId)).toMatchObject({ state: 'decided', code: 'failed' }), { timeout: 5_000 });
    expect(made).toEqual([`worktree:${spawnId}`]);
  });

  it('headless mode off: a host without the app keeps waiting for it, and nothing is approved or created', async () => {
    headless = false;
    await allow({ rules: [RULE] });
    const spawnId = await ask();
    expect(requests.get(HOST, spawnId)?.state).toBe('pending');
    expect(changes).toEqual([]);
    expect(made).toEqual([]);
  });
});
