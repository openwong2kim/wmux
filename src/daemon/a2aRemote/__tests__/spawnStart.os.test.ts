// The receiving PC's start of a remote spawn on real folders: the card (or a
// rule), the expiry of an unanswered card, the claim that checks everything
// again, the caps, the link the start makes (pane shown, prompt queued as its
// first task), what that link means while it lives (no images, follow-ups
// held for their card, redacted text out) and what its end puts back.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A2A_REMOTE_PROTOCOL, type A2aRemoteEnvelope } from '../../../shared/a2aRemote';
import { asSpawnLinkId, spawnFirstMessageId, type A2aSpawnRequestState, type SpawnLinkId } from '../../../shared/a2aSpawn';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { ExposureStore } from '../exposureStore';
import { remoteTaskId } from '../ids';
import { acceptInbound, type InboundDeps } from '../inbound';
import { LinkStore } from '../linkStore';
import { linkAlias, syncRemoteTask } from '../outbound';
import { OutboxStore } from '../outboxStore';
import { SpawnChecks } from '../spawnChecks';
import { SPAWN_LINKS_MAX, SpawnLinkStore } from '../spawnLinkStore';
import { SpawnPolicyStore } from '../spawnPolicyStore';
import { A2aSpawnReceiver, type SpawnReceiverDeps } from '../spawnReceiver';
import { SpawnRequestStore } from '../spawnRequestStore';
import { deliberateSleep } from '../../../test-utils/waitFor';
import { A2aSpawnStarter } from '../spawnStarter';

const HOST = '11111111-1111-4111-8111-111111111111';
const quiet = (): void => undefined;

let dir: string;
let a2aDir: string;
let repo: string;
let policy: SpawnPolicyStore;
let requests: SpawnRequestStore;
let links: LinkStore;
let exposures: ExposureStore;
let tasks: A2aTaskService;
let starter: A2aSpawnStarter;
let sent: Array<{ hostId: string; env: A2aRemoteEnvelope }>;
let changes: Array<{ spawnId: string; state: A2aSpawnRequestState }>;
let ready: boolean;
let clock: number | undefined;
let receiver: A2aSpawnReceiver;

function makeReceiver(over: Partial<SpawnReceiverDeps> = {}): A2aSpawnReceiver {
  return new A2aSpawnReceiver({
    policy,
    requests,
    enqueue: (hostId, env) => void sent.push({ hostId, env }),
    agentInstalled: async () => true,
    checks: new SpawnChecks(8),
    refusalCoalesceMs: 0,
    appReady: () => ready,
    liveSpawns: (h) => starter.liveCount(h),
    onChange: (_h, spawnId, state) => void changes.push({ spawnId, state }),
    hostName: () => 'HOME-A',
    start: starter,
    abandon: (h, spawnId) => starter.abandon(h, spawnId),
    now: () => clock ?? Date.now(),
    log: quiet,
    ...over,
  });
}

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-spawn-start-')));
  a2aDir = path.join(dir, 'a2a');
  repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'apps', 'site'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  const store = { dir: a2aDir, scheduleHarden: quiet };
  policy = new SpawnPolicyStore(store);
  requests = new SpawnRequestStore(store);
  links = new LinkStore({ ...store, onTransition: (l) => starter?.onLinkTransition(l) });
  exposures = new ExposureStore(store);
  const log = new AppendOnlyLog({ dir: path.join(dir, 'log'), fsync: quiet });
  log.open();
  tasks = new A2aTaskService({ log, origin: { machineId: 'b', daemonEpoch: 1 } });
  starter = new A2aSpawnStarter({
    links, spawnLinks: new SpawnLinkStore(store), exposures, taskService: tasks, policy,
    hostName: () => 'HOME-A', aliasFor: (l) => linkAlias(l, 'HOME-A'), broadcast: quiet, log: quiet,
  });
  sent = [];
  changes = [];
  ready = true;
  clock = undefined;
  receiver = makeReceiver();
});
afterEach(() => {
  receiver.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function allow(over: Record<string, unknown> = {}): Promise<void> {
  const res = await policy.set({
    v: 1, enabled: true, approval: 'ask', followUps: 'ask', permissionMode: 'auto',
    hosts: { [HOST]: { allowed: true } }, roots: [{ id: 'web', label: 'Web', path: repo }], agents: ['claude', 'codex'], rules: [],
    version: policy.get().version,
    ...over,
  });
  expect(res.ok).toBe(true);
}

function request(over: { spawn?: Record<string, unknown>; expiresIn?: number } = {}): A2aRemoteEnvelope {
  const spawnId = `sp-${crypto.randomUUID()}`;
  const now = Date.now();
  return {
    protocol: A2A_REMOTE_PROTOCOL, linkId: spawnId, linkVersion: 0, messageId: 'req', kind: 'link',
    link: { state: 'spawn', version: 0 },
    spawn: {
      v: 1, spawnId, agent: 'claude', folder: { root: 'web', sub: 'apps' }, text: 'fix the build\nthen run the tests',
      expiresAt: new Date(now + (over.expiresIn ?? 3600_000)).toISOString(), from: { kind: 'pane', workspaceId: 'ws-a', paneId: 'pane-a' },
      ...over.spawn,
    } as A2aRemoteEnvelope['spawn'],
    sentAt: new Date(now).toISOString(),
  };
}

const codes = (env: A2aRemoteEnvelope): Array<string | undefined> =>
  sent.filter((s) => s.env.linkId === env.linkId).map((s) => s.env.spawnResult?.code);
const stateOf = (env: A2aRemoteEnvelope): string | undefined => requests.get(HOST, env.linkId)?.state;
/** The link a started request made (its id comes with the `started` answer). */
const linkOf = (env: A2aRemoteEnvelope): SpawnLinkId => asSpawnLinkId(requests.get(HOST, env.linkId)!.linkId)!;

async function arrive(env: A2aRemoteEnvelope, r = receiver): Promise<void> {
  expect(r.applyInbound(env, { hostId: HOST })).toEqual({ ok: true, duplicate: false });
  await r.idle();
}

/** Through the card, the claim and a pane, to a linked agent. */
async function startOne(env: A2aRemoteEnvelope, pane = 'pane-new'): Promise<void> {
  await arrive(env);
  if (stateOf(env) === 'awaiting') expect(await receiver.decideCard(HOST, env.linkId, 'once')).toEqual({ ok: true });
  expect(await receiver.claim(HOST, env.linkId)).toMatchObject({ ok: true });
  expect(await receiver.started(HOST, env.linkId, { workspaceId: `ws-${pane}`, paneId: pane })).toEqual({ ok: true });
}

describe('the card', () => {
  it('an allowed request waits for its card and says so; Allow once, the claim and the start link it and queue the prompt', async () => {
    await allow();
    const env = request();
    await arrive(env);
    expect(stateOf(env)).toBe('awaiting');
    expect(codes(env)).toEqual(['waiting-for-approval']);
    expect(changes).toEqual([{ spawnId: env.linkId, state: 'awaiting' }]);
    expect(receiver.work().awaiting).toEqual([expect.objectContaining({
      hostName: 'HOME-A', agent: 'claude', folder: path.join(repo, 'apps'), permissionMode: 'auto', followUps: 'ask',
      text: 'fix the build\nthen run the tests',
    })]);

    expect(await receiver.decideCard(HOST, env.linkId, 'once')).toEqual({ ok: true });
    expect(receiver.work().approved).toEqual([{ hostId: HOST, spawnId: env.linkId }]);
    expect(await receiver.claim(HOST, env.linkId)).toEqual({
      ok: true,
      claim: { hostId: HOST, hostName: 'HOME-A', spawnId: env.linkId, agent: 'claude', repoPath: repo, sub: 'apps', permissionMode: 'auto' },
    });
    // A second claim of the same start is refused: it is starting already.
    expect(await receiver.claim(HOST, env.linkId)).toMatchObject({ ok: false });

    expect(await receiver.started(HOST, env.linkId, { workspaceId: 'ws-new', paneId: 'pane-new' })).toEqual({ ok: true });
    const linkId = linkOf(env);
    expect(sent.at(-1)!.env.spawnResult).toEqual({
      v: 1, spawnId: env.linkId, code: 'started', endpoint: { kind: 'pane', workspaceId: 'ws-new', paneId: 'pane-new' }, linkVersion: 1, linkId,
    });
    // A fresh id: nothing in the request predicts it.
    expect(linkId).toMatch(/^[0-9a-f-]{36}$/);
    expect(linkId).not.toBe(env.linkId.slice('sp-'.length));
    expect(links.get(linkId)).toMatchObject({
      state: 'active', version: 1, proposer: 'remote', allow: { inbound: true, outbound: false }, spawned: true,
      local: { kind: 'pane', workspaceId: 'ws-new', paneId: 'pane-new' },
      remote: { hostId: HOST, kind: 'pane', workspaceId: 'ws-a', paneId: 'pane-a' },
    });
    expect(exposures.isPaneExposed(HOST, 'ws-new', 'pane-new')).toBe(true);
    const first = tasks.getTask(remoteTaskId(linkId, spawnFirstMessageId(linkId)))!;
    expect(first.history[0].parts).toEqual([{ kind: 'text', text: 'fix the build\nthen run the tests' }]);
    expect(first.metadata.remote).toMatchObject({ linkId, direction: 'inbound', delivered: false });
    expect(first.metadata.remote).not.toHaveProperty('held');
    // Decided: the outcome is kept, the prompt is not.
    expect(requests.get(HOST, env.linkId)).toMatchObject({ state: 'decided', code: 'started' });
    expect(requests.get(HOST, env.linkId)).not.toHaveProperty('request');
  });

  it('Deny ends it declined; a card nobody answers ends expired at the request\'s expiry', async () => {
    await allow();
    const denied = request();
    await arrive(denied);
    expect(await receiver.decideCard(HOST, denied.linkId, 'deny')).toEqual({ ok: true });
    expect(codes(denied)).toEqual(['waiting-for-approval', 'declined']);

    const late = request({ expiresIn: 60_000 });
    await arrive(late);
    clock = Date.now() + 61_000;
    receiver.sweep();
    expect(codes(late)).toEqual(['waiting-for-approval', 'expired']);
    expect(receiver.work().awaiting).toEqual([]);
  });

  it('allow-list: a matching rule skips the card, another asks; Always adds the rule', async () => {
    await allow({ approval: 'allow-list', rules: [{ hostId: HOST, rootId: 'web', agent: 'claude', sub: 'apps' }] });
    const ruled = request();
    await arrive(ruled);
    expect(stateOf(ruled)).toBe('approved');
    expect(codes(ruled)).toEqual([]);
    expect(changes).toEqual([{ spawnId: ruled.linkId, state: 'approved' }]);

    const other = request({ spawn: { agent: 'codex' } });
    await arrive(other);
    expect(stateOf(other)).toBe('awaiting');
    expect(await receiver.decideCard(HOST, other.linkId, 'always')).toEqual({ ok: true });
    expect(policy.get().rules).toContainEqual({ hostId: HOST, rootId: 'web', agent: 'codex', sub: 'apps' });
    expect(stateOf(other)).toBe('approved');
  });

  it('in ask mode a rule does not skip the card', async () => {
    await allow({ rules: [{ hostId: HOST, rootId: 'web', agent: 'claude' }] });
    const env = request();
    await arrive(env);
    expect(stateOf(env)).toBe('awaiting');
  });
});

describe('right before the start', () => {
  it.skipIf(process.platform === 'win32')('a folder swapped for a link outside between the card and the start is refused', async () => {
    await allow();
    const env = request();
    await arrive(env);
    await receiver.decideCard(HOST, env.linkId, 'once');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.rmSync(path.join(repo, 'apps'), { recursive: true });
    fs.symlinkSync(outside, path.join(repo, 'apps'));
    expect(await receiver.claim(HOST, env.linkId)).toMatchObject({ ok: false, code: 'folder-not-allowed' });
    expect(codes(env)).toEqual(['waiting-for-approval', 'folder-not-allowed']);
  });

  it('an approved request for an agent another PC may not start (kept from an older build) is refused at the claim', async () => {
    await allow();
    const env = request();
    await arrive(env);
    await receiver.decideCard(HOST, env.linkId, 'once');
    receiver.stop();
    const file = requests.filePath;
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/"agent":\s*"claude"/g, '"agent": "gemini"'));
    requests = new SpawnRequestStore({ dir: a2aDir, scheduleHarden: quiet });
    expect(requests.get(HOST, env.linkId)?.request?.agent).toBe('gemini');
    receiver = makeReceiver({ policy: { get: () => ({ ...policy.get(), agents: ['claude', 'gemini'] }) } });
    expect(await receiver.claim(HOST, env.linkId)).toMatchObject({ ok: false, code: 'agent-not-allowed' });
  });

  it('a PC turned off after its card was answered is not started', async () => {
    await allow();
    const env = request();
    await arrive(env);
    await receiver.decideCard(HOST, env.linkId, 'once');
    await allow({ enabled: false });
    expect(await receiver.claim(HOST, env.linkId)).toMatchObject({ ok: false, code: 'not-allowed' });
  });

  it('a start main had claimed when the daemon stopped ends failed on recovery, never a second pane', async () => {
    await allow();
    const env = request();
    await arrive(env);
    await receiver.decideCard(HOST, env.linkId, 'once');
    await receiver.claim(HOST, env.linkId);
    makeReceiver().recover();
    expect(codes(env)).toEqual(['waiting-for-approval', 'failed']);
  });

  it('the app not ready: the request waits for it, and ends app-not-ready at its expiry', async () => {
    await allow();
    ready = false;
    const waiting = makeReceiver({ retryMinMs: 20 });
    const env = request({ expiresIn: 400 });
    expect(waiting.applyInbound(env, { hostId: HOST })).toEqual({ ok: true, duplicate: false });
    await waiting.idle();
    expect(stateOf(env)).toBe('pending');
    await vi.waitFor(() => expect(codes(env)).toEqual(['app-not-ready']), { timeout: 5_000 });
    waiting.stop();
  });
});

/** The limits that were fixed before the owner could set them: here, set. */
const SET_LIMITS = { livePerPc: 2, liveTotal: 4, startsPerHour: 3, startsPerDay: 10 };

describe('room', () => {
  it('with no limits set, a PC starts as many agents as it asks for', async () => {
    await allow();
    for (let i = 1; i <= 5; i++) await startOne(request(), `n${i}`);
    expect(starter.liveCount(HOST)).toBe(5);
  });

  it('two agents running per PC set: a third is refused rate-limited; three starts an hour set, then rate-limited', async () => {
    await allow({ limits: SET_LIMITS });
    await startOne(request(), 'p1');
    await startOne(request(), 'p2');
    const third = request();
    await arrive(third);
    expect(codes(third)).toEqual(['rate-limited']);

    // Ended links free the running slots, but not the hourly count.
    for (const l of links.list()) links.revoke(l.linkId, 'local');
    await startOne(request(), 'p3');
    links.revoke(linkOf(sent.at(-1)!.env), 'local');
    const fourth = request();
    await arrive(fourth);
    expect(codes(fourth)).toEqual(['rate-limited']);
  });
});

describe('the link a start made', () => {
  function inboundDeps(): InboundDeps {
    return { linkStore: links, taskService: tasks, broadcast: quiet, aliasFor: (l) => linkAlias(l, 'HOME-A'), spawnLinks: starter };
  }
  function task(linkId: string, over: Partial<A2aRemoteEnvelope> = {}): A2aRemoteEnvelope {
    return {
      protocol: A2A_REMOTE_PROTOCOL, linkId, linkVersion: 1, messageId: crypto.randomUUID(), kind: 'task',
      text: 'now also update the docs', sentAt: new Date().toISOString(), ...over,
    };
  }

  it('carries no images; a later task waits for its card in ask mode and not in direct mode', async () => {
    await allow();
    const env = request();
    await startOne(env);
    const linkId = linkOf(env);
    const image = { sha256: 'a'.repeat(64), bytes: 10, mediaType: 'image/png' as const, name: 'x.png' };
    expect(await acceptInbound(task(linkId, { images: [image] }), { hostId: HOST }, inboundDeps())).toMatchObject({ ok: false, error: 'bad-request' });

    const asked = task(linkId);
    expect(await acceptInbound(asked, { hostId: HOST }, inboundDeps())).toMatchObject({ ok: true });
    expect(tasks.getTask(remoteTaskId(linkId, asked.messageId))!.metadata.remote).toMatchObject({ held: 'awaiting-approval' });
    expect(starter.followUpCards()).toEqual([expect.objectContaining({
      taskId: remoteTaskId(linkId, asked.messageId), hostName: 'HOME-A', agent: 'claude', folder: path.join(repo, 'apps'), text: 'now also update the docs',
    })]);
    expect(tasks.listRemotePending().map((t) => t.id)).not.toContain(remoteTaskId(linkId, asked.messageId));

    await allow({ followUps: 'direct' });
    const direct = task(linkId);
    await acceptInbound(direct, { hostId: HOST }, inboundDeps());
    expect(tasks.getTask(remoteTaskId(linkId, direct.messageId))!.metadata.remote).not.toHaveProperty('held');
  });

  it('what leaves on it is redacted: the state message and the evidence', async () => {
    await allow();
    const env = request();
    await startOne(env);
    const linkId = linkOf(env);
    const taskId = remoteTaskId(linkId, spawnFirstMessageId(linkId));
    const key = `ghp_${'a1B2'.repeat(9)}`;
    await tasks.markRemote({ taskId, delivered: true });
    expect((await tasks.transition({ taskId, to: 'working', callerWorkspaceId: 'ws-pane-new' })).ok).toBe(true);
    expect((await tasks.transition({
      taskId, to: 'completed', callerWorkspaceId: 'ws-pane-new',
      evidence: { summary: `pushed with ${key}`, items: [{ kind: 'command', status: 'passed', command: `git push https://x:${key}@example.com`, summary: 'pushed', output: key }] },
      message: { kind: 'message', messageId: 'st-1', role: 'agent', parts: [{ kind: 'text', text: `done, the token was ${key}` }] },
    })).ok).toBe(true);
    const outbox = new OutboxStore({ dir: a2aDir, scheduleHarden: quiet });
    expect(await syncRemoteTask({ linkStore: links, taskService: tasks, outbox, spawnLink: (id) => starter.isSpawnLink(id) }, taskId)).toMatchObject({ ok: true });
    const out = JSON.stringify(outbox.pending(HOST).map((r) => r.envelope));
    expect(out).toContain('completed');
    expect(out).not.toContain(key);
    expect(out).toContain('[redacted]');
  });

  it('when it ends, the pane it showed is hidden again; a pane shown before stays shown', async () => {
    await allow();
    const env = request();
    await startOne(env, 'pane-x');
    links.revoke(linkOf(env), 'local');
    expect(exposures.isPaneExposed(HOST, 'ws-pane-x', 'pane-x')).toBe(false);
    expect(starter.liveCount(HOST)).toBe(0);

    exposures.addPane(HOST, 'ws-pane-y', 'pane-y');
    const shown = request();
    await startOne(shown, 'pane-y');
    links.revoke(linkOf(shown), 'local');
    expect(exposures.isPaneExposed(HOST, 'ws-pane-y', 'pane-y')).toBe(true);
  });
});

describe('the start handshake: reserved, stored, then made reachable', () => {
  async function claimed(): Promise<A2aRemoteEnvelope> {
    await allow();
    const env = request();
    await arrive(env);
    await receiver.decideCard(HOST, env.linkId, 'once');
    expect(await receiver.claim(HOST, env.linkId)).toMatchObject({ ok: true });
    return env;
  }
  const nothingMade = (pane: string): void => {
    expect(links.list()).toEqual([]);
    expect(exposures.isPaneExposed(HOST, `ws-${pane}`, pane)).toBe(false);
    expect(tasks.listRemotePending()).toEqual([]);
    expect(starter.liveCount()).toBe(0);
  };

  it('the started answer not stored: nothing was made reachable, and nothing is left', async () => {
    const env = await claimed();
    vi.spyOn(requests, 'decide').mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(await receiver.started(HOST, env.linkId, { workspaceId: 'ws-x', paneId: 'x' })).toMatchObject({ ok: false });
    nothingMade('x');
    expect(codes(env).at(-1)).toBe('failed');
  });

  it('main gave up while the start was being linked: it refuses itself before storing anything', async () => {
    const env = await claimed();
    const giveUp = makeReceiver({
      start: {
        ...starter,
        prepare: (rec, req, end) => {
          const id = starter.prepare(rec, req, end);
          // main's failed() arrives while this start is in flight
          expect(giveUp.failed(HOST, env.linkId, 'failed')).toEqual({ ok: true });
          return id;
        },
        commit: (id) => starter.commit(id),
        discard: (id) => starter.discard(id),
        activate: (id) => starter.activate(id),
        isActive: (id) => starter.isActive(id),
      },
    });
    expect(await giveUp.started(HOST, env.linkId, { workspaceId: 'ws-z', paneId: 'z' })).toEqual({ ok: false, error: 'the start was abandoned' });
    nothingMade('z');
    expect(codes(env).at(-1)).toBe('failed');
  });

  it('stored, but making it reachable failed: no answer yet; the sweep finishes it, then answers', async () => {
    const env = await claimed();
    vi.spyOn(tasks, 'createTask').mockResolvedValueOnce({ ok: false, error: 'ledger busy' } as never);
    expect(await receiver.started(HOST, env.linkId, { workspaceId: 'ws-w', paneId: 'w' })).toEqual({ ok: true });
    expect(stateOf(env)).toBe('decided');
    expect(codes(env)).not.toContain('started');
    // A resend meanwhile is not told `started` before the agent is reachable.
    expect(receiver.applyInbound(env, { hostId: HOST })).toEqual({ ok: false, error: 'unavailable' });
    receiver.sweep();
    await vi.waitFor(() => expect(codes(env).at(-1)).toBe('started'), { timeout: 5_000 });
    const linkId = linkOf(env);
    expect(links.get(linkId)?.state).toBe('active');
    expect(tasks.getTask(remoteTaskId(linkId, spawnFirstMessageId(linkId)))).toBeDefined();
  });

  it('a daemon that stopped after storing the start, before making it reachable, finishes it on recovery', async () => {
    const env = await claimed();
    const rec = requests.get(HOST, env.linkId)!;
    const linkId = starter.prepare(rec, rec.request!, { workspaceId: 'ws-v', paneId: 'v' });
    requests.decide(HOST, env.linkId, 'started', { endpoint: { kind: 'pane', workspaceId: 'ws-v', paneId: 'v' }, linkVersion: 1, linkId });
    starter.commit(linkId);
    expect(links.get(linkId)).toBeUndefined();
    const after = makeReceiver();
    after.recover();
    await vi.waitFor(() => expect(codes(env).at(-1)).toBe('started'), { timeout: 5_000 });
    expect(links.get(linkId)?.state).toBe('active');
    expect(exposures.isPaneExposed(HOST, 'ws-v', 'v')).toBe(true);
    after.stop();
  });

  it('a daemon that stopped after reserving, before storing, ends the start failed and drops the reservation', async () => {
    const env = await claimed();
    const rec = requests.get(HOST, env.linkId)!;
    starter.prepare(rec, rec.request!, { workspaceId: 'ws-u', paneId: 'u' });
    makeReceiver().recover();
    expect(codes(env).at(-1)).toBe('failed');
    nothingMade('u');
    expect(new SpawnLinkStore({ dir: a2aDir, scheduleHarden: quiet }).list()).toEqual([]);
  });

  it('a link that will not end is kept as ending and retried until it does', async () => {
    await allow();
    const env = request();
    await startOne(env, 'e');
    const linkId = linkOf(env);
    vi.spyOn(links, 'revoke').mockImplementationOnce(() => { throw new Error('links.json not writable'); });
    starter.abandon(HOST, env.linkId);
    expect(links.get(linkId)?.state).toBe('active');
    expect(new SpawnLinkStore({ dir: a2aDir, scheduleHarden: quiet }).get(linkId)).toMatchObject({ ending: true });
    starter.reconcile();
    expect(links.get(linkId)?.state).toBe('revoked');
    expect(exposures.isPaneExposed(HOST, 'ws-e', 'e')).toBe(false);
  });

  it('the root must still be the folder the claim checked', async () => {
    const env = await claimed();
    const other = path.join(dir, 'other');
    fs.mkdirSync(path.join(other, 'apps'), { recursive: true });
    execFileSync('git', ['init', '-q', other]);
    await allow({ roots: [{ id: 'web', label: 'Web', path: other }] });
    expect(await receiver.started(HOST, env.linkId, { workspaceId: 'ws-t', paneId: 't' })).toEqual({ ok: false, error: 'folder-not-allowed' });
    nothingMade('t');
  });

  it('a start main never reports back on ends failed after its deadline, freeing its slot', async () => {
    const env = await claimed();
    clock = Date.now() + 9 * 60_000;
    receiver.sweep();
    expect(stateOf(env)).toBe('starting');
    clock = Date.now() + 11 * 60_000;
    receiver.sweep();
    expect(codes(env).at(-1)).toBe('failed');
    expect(requests.startingCount(HOST)).toBe(0);
  });

  it('a claim whose checks could not run now goes back to approved, and the next one starts it', async () => {
    await allow();
    let calls = 0;
    const r = makeReceiver({ agentInstalled: async () => { calls += 1; if (calls === 2) throw new Error('PATH probe crashed'); return true; } });
    const env = request();
    await arrive(env, r);
    await r.decideCard(HOST, env.linkId, 'once');
    expect(await r.claim(HOST, env.linkId)).toMatchObject({ ok: false });
    expect(stateOf(env)).toBe('approved');
    expect(await r.claim(HOST, env.linkId)).toMatchObject({ ok: true });
  });

  it('a start counts once: while reserved it is starting, once stored it is running', async () => {
    const env = await claimed();
    const rec = requests.get(HOST, env.linkId)!;
    const linkId = starter.prepare(rec, rec.request!, { workspaceId: 'ws-s', paneId: 's' });
    expect([starter.liveCount(HOST), requests.startingCount(HOST)]).toEqual([0, 1]);
    requests.decide(HOST, env.linkId, 'started', { endpoint: { kind: 'pane', workspaceId: 'ws-s', paneId: 's' }, linkVersion: 1, linkId });
    starter.commit(linkId);
    expect([starter.liveCount(HOST), requests.startingCount(HOST)]).toEqual([1, 0]);
  });
});

describe('caps on every path', () => {
  it('a card answered when the PC is out of room is refused rate-limited', async () => {
    await allow({ limits: SET_LIMITS });
    await startOne(request(), 'q1');
    await startOne(request(), 'q2');
    // Room was there when this card opened (ended links), not when it is answered.
    const late = request();
    for (const l of links.list()) links.revoke(l.linkId, 'local');
    await arrive(late);
    expect(stateOf(late)).toBe('awaiting');
    await startOne(request(), 'q3');
    expect(await receiver.decideCard(HOST, late.linkId, 'once')).toEqual({ ok: false, error: 'rate-limited' });
    expect(codes(late).at(-1)).toBe('rate-limited');
  });

  it('claims run one at a time: the second waits until the first has checked and counted itself', async () => {
    await allow({ approval: 'allow-list', rules: [{ hostId: HOST, rootId: 'web', agent: 'claude', sub: 'apps' }] });
    let release!: () => void;
    const held = new Promise<boolean>((r) => { release = () => r(true); });
    let claiming = false;
    let checks = 0;
    // Only the claims' agent checks are counted, and the first one is held.
    const serial = makeReceiver({ agentInstalled: () => (!claiming ? Promise.resolve(true) : ++checks === 1 ? held : Promise.resolve(true)) });
    const a = request();
    const b = request();
    await arrive(a, serial);
    await arrive(b, serial);
    expect([stateOf(a), stateOf(b)]).toEqual(['approved', 'approved']);
    claiming = true;
    const both = Promise.all([serial.claim(HOST, a.linkId), serial.claim(HOST, b.linkId)]);
    await vi.waitFor(() => expect(checks).toBe(1), { timeout: 5_000 });
    await deliberateSleep(50, 'proves a negative: the second claim has not started its checks while the first holds them');
    expect(checks).toBe(1);
    release();
    const [ra, rb] = await both;
    expect([ra.ok, rb.ok]).toEqual([true, true]);
    serial.stop();
  });

  it('a claim counts the other starts in flight: no third agent while two start', async () => {
    await allow({ approval: 'allow-list', rules: [{ hostId: HOST, rootId: 'web', agent: 'claude', sub: 'apps' }], limits: SET_LIMITS });
    let live = 0;
    const r = makeReceiver({ liveSpawns: () => live });
    const a = request();
    const b = request();
    await arrive(a, r);
    await arrive(b, r);
    // Another agent started meanwhile (one the caps did not see when these were approved).
    live = 1;
    expect(await r.claim(HOST, a.linkId)).toMatchObject({ ok: false, code: 'rate-limited' });
  });
});

describe('Always allow', () => {
  it('covers exactly the folder its card showed: another folder of the same root asks again', async () => {
    await allow({ approval: 'allow-list' });
    const first = request();
    await arrive(first);
    expect(await receiver.decideCard(HOST, first.linkId, 'always')).toEqual({ ok: true });
    expect(policy.get().rules).toEqual([{ hostId: HOST, rootId: 'web', agent: 'claude', sub: 'apps' }]);

    // Approved ones count as about to run: end each here, so room is not what is tested.
    expect(receiver.failed(HOST, first.linkId, 'failed')).toEqual({ ok: true });
    const same = request();
    await arrive(same);
    expect(stateOf(same)).toBe('approved');
    receiver.failed(HOST, same.linkId, 'failed');
    const deeper = request({ spawn: { folder: { root: 'web', sub: 'apps/site' } } });
    await arrive(deeper);
    expect(stateOf(deeper)).toBe('awaiting');
    const rootItself = request({ spawn: { folder: { root: 'web' } } });
    await arrive(rootItself);
    expect(stateOf(rootItself)).toBe('awaiting');
  });
});

describe('the spawn-links record', () => {
  it('at its cap a new start is refused; no live record is dropped to make room', () => {
    const store = new SpawnLinkStore({ dir: a2aDir, scheduleHarden: quiet, write: () => undefined });
    const row = (i: number) => ({
      v: 1 as const, linkId: crypto.randomUUID(), hostId: HOST, spawnId: `sp-${crypto.randomUUID()}`, workspaceId: `ws-${i}`, paneId: `p-${i}`,
      agent: 'claude' as const, rootId: 'web', folder: repo, remote: { workspaceId: 'ws-a', paneId: 'pane-a' },
      addedExposure: false, addedWorkspace: false, startedAt: new Date().toISOString(), phase: 'active' as const,
    });
    const firstRow = row(0);
    store.add(firstRow);
    for (let i = 1; i < SPAWN_LINKS_MAX; i++) store.add(row(i));
    expect(() => store.add(row(SPAWN_LINKS_MAX))).toThrow(/recorded already/);
    expect(store.has(firstRow.linkId)).toBe(true);
  });

  it('the link record itself marks it, so redaction needs no other lookup', async () => {
    await allow();
    const env = request();
    await startOne(env);
    const linkId = linkOf(env);
    const taskId = remoteTaskId(linkId, spawnFirstMessageId(linkId));
    const key = `ghp_${'a1B2'.repeat(9)}`;
    await tasks.markRemote({ taskId, delivered: true });
    await tasks.transition({ taskId, to: 'working', callerWorkspaceId: 'ws-pane-new' });
    await tasks.transition({
      taskId, to: 'completed', callerWorkspaceId: 'ws-pane-new',
      evidence: { summary: 'done', items: [{ kind: 'artifact', status: 'verified', summary: 'file', location: `/tmp/${key}` }], files: [`notes-${key}.md`] },
    });
    const outbox = new OutboxStore({ dir: a2aDir, scheduleHarden: quiet });
    // No `spawnLink` here: the link's own mark is enough.
    expect(await syncRemoteTask({ linkStore: links, taskService: tasks, outbox }, taskId)).toMatchObject({ ok: true });
    const out = JSON.stringify(outbox.pending(HOST).map((r) => r.envelope));
    expect(out).not.toContain(key);
    expect(out).toContain('[redacted]');
  });
});
