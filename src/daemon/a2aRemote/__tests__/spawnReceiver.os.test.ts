// The receiver side of remote spawn on real folders: the cheap checks and
// the answer, the decision's checks (agent, root, containment, symlinks),
// replay and resend, room, the policy store, and what a result may carry.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A2A_REMOTE_MESSAGE_ID_RE, A2A_REMOTE_PROTOCOL, type A2aRemoteEnvelope } from '../../../shared/a2aRemote';
import { SPAWN_PENDING_PER_HOST_DEFAULT, SPAWN_REQUEST_KEEP_MS, SPAWN_REQUESTS_MAX, SPAWN_TARGETS_LINK_ID } from '../../../shared/a2aSpawn';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { acceptInbound, type InboundDeps } from '../inbound';
import { LinkStore } from '../linkStore';
import { linkAlias } from '../outbound';
import { A2aSpawnReceiver, registerSpawnRpc, unpairedHostNamed, type SpawnReceiverDeps } from '../spawnReceiver';
import { SpawnPolicyStore, samePath } from '../spawnPolicyStore';
import { SPAWN_REQUESTS_FILE, SpawnRequestStore } from '../spawnRequestStore';
import { CheckBusy, CheckTimeout, SpawnChecks, realpathNative } from '../spawnChecks';
import { deliberateSleep } from '../../../test-utils/waitFor';
import { shortPathOf } from '../../../test-utils/shortPath';

const HOST = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';
const quiet = (): void => undefined;

let dir: string;
let a2aDir: string;
let repo: string;
let policy: SpawnPolicyStore;
let requests: SpawnRequestStore;
let sent: Array<{ hostId: string; env: A2aRemoteEnvelope }>;
let installed: Set<string>;
let receiver: A2aSpawnReceiver;

function makeReceiver(over: Partial<SpawnReceiverDeps> = {}): A2aSpawnReceiver {
  return new A2aSpawnReceiver({
    policy,
    requests,
    enqueue: (hostId, env) => void sent.push({ hostId, env }),
    agentInstalled: async (agent) => installed.has(agent),
    refusalCoalesceMs: 0,
    // Each receiver its own gate: a check left hanging by one test holds no slot of another.
    checks: new SpawnChecks(8),
    log: quiet,
    ...over,
  });
}

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-spawn-')));
  a2aDir = path.join(dir, 'a2a');
  repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'apps', 'site'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  policy = new SpawnPolicyStore({ dir: a2aDir, scheduleHarden: quiet });
  requests = new SpawnRequestStore({ dir: a2aDir, scheduleHarden: quiet });
  sent = [];
  installed = new Set(['claude']);
  receiver = makeReceiver();
});
afterEach(() => {
  receiver.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function allowHost(over: Record<string, unknown> = {}): Promise<void> {
  const res = await policy.set({
    v: 1, enabled: true, approval: 'ask', followUps: 'ask', permissionMode: 'auto',
    hosts: { [HOST]: { allowed: true } }, roots: [{ id: 'web', label: 'Web', path: repo }], agents: ['claude', 'codex'], rules: [],
    version: policy.get().version,
    ...over,
  });
  expect(res.ok).toBe(true);
}

function envelope(over: { spawn?: Record<string, unknown>; sentAt?: number; expiresIn?: number } = {}): A2aRemoteEnvelope {
  const spawnId = (over.spawn?.['spawnId'] as string | undefined) ?? `sp-${crypto.randomUUID()}`;
  const sentAt = over.sentAt ?? Date.now();
  return {
    protocol: A2A_REMOTE_PROTOCOL,
    linkId: spawnId,
    linkVersion: 0,
    messageId: 'req',
    kind: 'link',
    link: { state: 'spawn', version: 0 },
    spawn: {
      v: 1, spawnId, agent: 'claude', folder: { root: 'web' }, text: 'fix the build',
      expiresAt: new Date(sentAt + (over.expiresIn ?? 3600_000)).toISOString(), from: { kind: 'pane', workspaceId: 'ws-a', paneId: 'pane-a' },
      ...over.spawn,
    } as A2aRemoteEnvelope['spawn'],
    sentAt: new Date(sentAt).toISOString(),
  };
}

const resultsFor = (env: A2aRemoteEnvelope) => sent.filter((s) => s.env.linkId === env.linkId);

async function decide(env: A2aRemoteEnvelope, hostId = HOST, r = receiver): Promise<string | undefined> {
  const answer = r.applyInbound(env, { hostId });
  expect(answer).toEqual({ ok: true, duplicate: false });
  await r.idle();
  return resultsFor(env)[0]?.env.spawnResult?.code;
}

describe('cheap checks: answered ok, refused with a code', () => {
  it('the feature off and a PC not allowed get the same code, and nothing is kept', async () => {
    expect(await decide(envelope())).toBe('not-allowed');
    await allowHost();
    expect(await decide(envelope(), OTHER)).toBe('not-allowed');
    await allowHost({ enabled: false });
    expect(await decide(envelope())).toBe('not-allowed');
    expect(requests.summaries()).toEqual([]);
  });

  it('B\'s clock: a request sent from the future, or living past 72 h, is refused as expired', async () => {
    await allowHost();
    expect(await decide(envelope({ sentAt: Date.now() + 11 * 60_000 }))).toBe('expired');
    expect(await decide(envelope({ expiresIn: 73 * 3600_000 }))).toBe('expired');
    expect(await decide(envelope({ sentAt: Date.now() - 2 * 3600_000, expiresIn: 3600_000 }))).toBe('expired');
  });

  it('an unreadable body, extra fields, or a linkId that is not the spawnId are bad requests', () => {
    expect(receiver.applyInbound(envelope({ spawn: { env: { PATH: '/tmp' } } }), { hostId: HOST })).toEqual({ ok: false, error: 'bad-request' });
    expect(receiver.applyInbound(envelope({ spawn: { folder: { root: 'web', sub: '../..' } } }), { hostId: HOST })).toEqual({ ok: false, error: 'bad-request' });
    expect(receiver.applyInbound({ ...envelope(), linkId: 'sp-other' }, { hostId: HOST })).toEqual({ ok: false, error: 'bad-request' });
  });

  it('a prompt that is only control characters is unreadable, never stored as an empty prompt', async () => {
    await allowHost();
    expect(receiver.applyInbound(envelope({ spawn: { text: '\u001b[2J\u0007' } }), { hostId: HOST })).toEqual({ ok: false, error: 'bad-request' });
    expect(requests.summaries()).toEqual([]);
  });

  it('every refused request gets its own answer; a resend of the same one is answered once per window', async () => {
    const coalescing = makeReceiver({ refusalCoalesceMs: 60_000 });
    const envs = [envelope(), envelope(), envelope()];
    for (const env of envs) expect(coalescing.applyInbound(env, { hostId: HOST })).toEqual({ ok: true, duplicate: false });
    expect(envs.map((e) => resultsFor(e).map((r) => r.env.spawnResult?.code))).toEqual([['not-allowed'], ['not-allowed'], ['not-allowed']]);
    for (let i = 0; i < 4; i++) expect(coalescing.applyInbound(envs[0], { hostId: HOST })).toEqual({ ok: true, duplicate: false });
    expect(resultsFor(envs[0])).toHaveLength(1);
    expect(coalescing.applyInbound(envs[0], { hostId: OTHER })).toEqual({ ok: true, duplicate: false });
    expect(sent.filter((r) => r.hostId === OTHER)).toHaveLength(1);
  });

  it('a refusal that cannot be queued is answered unavailable, so the asker sends it again', () => {
    const full = makeReceiver({ enqueue: () => { throw new Error('outbox full'); } });
    expect(full.applyInbound(envelope(), { hostId: HOST })).toEqual({ ok: false, error: 'unavailable' });
  });
});

describe('the decision', () => {
  it('an allowed request in this build is refused as not supported, and its text is not kept', async () => {
    await allowHost();
    const env = envelope({ spawn: { folder: { root: 'web', sub: 'apps/site' } } });
    expect(await decide(env)).toBe('not-supported');
    const stored = JSON.parse(fs.readFileSync(requests.filePath, 'utf8')) as { records: unknown[] };
    expect(stored.records).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain('fix the build');
    expect(requests.summaries()[0]).toMatchObject({ hostId: HOST, state: 'decided', code: 'not-supported', rootId: 'web' });
  });

  it('a policy file naming an agent another PC may not start loads without it, and a listing of one is still refused', async () => {
    await allowHost();
    const file = path.join(a2aDir, 'spawn-policy.json');
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).toContain('"codex"');
    fs.writeFileSync(file, raw.replace('"codex"', '"gemini"'));
    // A file written by a build that offered gemini: gemini is dropped, the rest stands.
    policy = new SpawnPolicyStore({ dir: a2aDir, scheduleHarden: quiet });
    expect(policy.get()).toMatchObject({ enabled: true, agents: ['claude'] });
    installed.add('gemini');
    expect(await decide(envelope({ spawn: { agent: 'gemini' } }), HOST, makeReceiver())).toBe('agent-not-allowed');
    // claude passes every check (this receiver has no starter, so it ends not-supported).
    expect(await decide(envelope(), HOST, makeReceiver())).toBe('not-supported');
    // A policy that lists one anyway (from anywhere) is refused on the agent.
    await allowHost();
    const listed = makeReceiver({ policy: { get: () => ({ ...policy.get(), agents: ['claude', 'gemini'] }) } });
    expect(await decide(envelope({ spawn: { agent: 'gemini' } }), HOST, listed)).toBe('agent-not-allowed');
    listed.stop();
  });

  it('an agent B did not list, and one that is not installed', async () => {
    await allowHost({ agents: ['codex'] });
    expect(await decide(envelope())).toBe('agent-not-allowed');
    await allowHost();
    installed.clear();
    expect(await decide(envelope())).toBe('agent-not-installed');
  });

  it('an unknown root, a missing sub, a symlink that leaves the root, and a file', async () => {
    await allowHost();
    expect(await decide(envelope({ spawn: { folder: { root: 'nope' } } }))).toBe('folder-not-allowed');
    expect(await decide(envelope({ spawn: { folder: { root: 'web', sub: 'missing' } } }))).toBe('folder-not-allowed');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(repo, 'escape'), 'dir');
    expect(await decide(envelope({ spawn: { folder: { root: 'web', sub: 'escape' } } }))).toBe('folder-not-allowed');
    fs.writeFileSync(path.join(repo, 'file.txt'), 'x');
    expect(await decide(envelope({ spawn: { folder: { root: 'web', sub: 'file.txt' } } }))).toBe('folder-not-allowed');
  });

  it('a root saved under its 8.3 short name is stored long and still matches a request (Windows)', async () => {
    const short = shortPathOf(repo);
    // Not Windows, or this volume makes no short names: nothing to spell differently.
    if (!short) return;
    await allowHost({ roots: [{ id: 'web', label: 'Web', path: short }] });
    expect(policy.get().roots[0].path).toBe(repo);
    expect(await decide(envelope({ spawn: { folder: { root: 'web', sub: 'apps' } } }))).toBe('not-supported');
  });

  it('a root replaced by a link elsewhere after it was allowed is refused', async () => {
    await allowHost();
    fs.renameSync(repo, path.join(dir, 'repo-old'));
    const elsewhere = path.join(dir, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, repo, 'dir');
    expect(await decide(envelope())).toBe('folder-not-allowed');
  });

  // Windows paths compare without case (path.win32.relative and samePath fold
  // it), as its volumes are case-insensitive: there `Repo` and `repo` are the
  // same folder, and that is right. The exact compare holds everywhere else.
  it.skipIf(process.platform === 'win32')('containment compares realpaths as they are: a sibling differing only by case is outside', async () => {
    await allowHost();
    // A filesystem that resolves `Repo` to a different folder than `repo` (a case-sensitive volume).
    const sibling = repo.replace(/repo$/, 'Repo');
    const caseSensitive = makeReceiver({
      realpath: async (p) => (p.endsWith(`${path.sep}linked`) ? sibling : p),
      isDirectory: async () => true,
    });
    expect(await decide(envelope({ spawn: { folder: { root: 'web', sub: 'linked' } } }), HOST, caseSensitive)).toBe('folder-not-allowed');
  });

  it('a folder resolved differently after the directory check is refused', async () => {
    await allowHost();
    let n = 0;
    const swapping = makeReceiver({
      realpath: async (p) => (p === repo ? repo : (n++ === 0 ? path.join(repo, 'apps') : path.join(dir, 'outside'))),
      isDirectory: async () => true,
    });
    expect(await decide(envelope({ spawn: { folder: { root: 'web', sub: 'apps' } } }), HOST, swapping)).toBe('folder-not-allowed');
  });

  it('a check that never answers ends the request as failed instead of holding its place', async () => {
    await allowHost();
    const stalled = makeReceiver({ agentInstalled: () => new Promise(() => undefined), checks: new SpawnChecks(8, 30) });
    expect(await decide(envelope(), HOST, stalled)).toBe('failed');
    expect(requests.pendingCount(HOST)).toBe(0);
  });

  it('an unexpected error keeps the request pending and tries again', async () => {
    await allowHost();
    let calls = 0;
    const flaky = makeReceiver({
      agentInstalled: async () => { calls += 1; if (calls === 1) throw new Error('PATH probe crashed'); return true; },
      retryMinMs: 20,
    });
    const env = envelope();
    expect(flaky.applyInbound(env, { hostId: HOST })).toEqual({ ok: true, duplicate: false });
    await vi.waitFor(() => expect(resultsFor(env)[0]?.env.spawnResult?.code).toBe('not-supported'), { timeout: 5_000 });
    expect(calls).toBe(2);
    flaky.stop();
  });

  it('the policy is read again when deciding: a PC turned off meanwhile is not allowed', async () => {
    await allowHost();
    let release!: (v: boolean) => void;
    const slow = makeReceiver({ agentInstalled: () => new Promise((r) => { release = r; }) });
    const env = envelope();
    // The decision is already waiting on the agent check when this returns.
    expect(slow.applyInbound(env, { hostId: HOST })).toEqual({ ok: true, duplicate: false });
    await allowHost({ enabled: false });
    release(true);
    await slow.idle();
    expect(resultsFor(env)[0]?.env.spawnResult?.code).toBe('not-allowed');
  });

  it('a PC forgotten while its request was decided gets no answer', async () => {
    await allowHost();
    let release!: (v: boolean) => void;
    const slow = makeReceiver({ agentInstalled: () => new Promise((r) => { release = r; }) });
    const env = envelope();
    slow.applyInbound(env, { hostId: HOST });
    requests.forgetHost(HOST);
    release(true);
    await slow.idle();
    expect(resultsFor(env)).toEqual([]);
  });
});

describe('retries, removal and bounded checks', () => {
  it('an outcome that could not be stored is settled again later, and the decision leaves no slot behind', async () => {
    await allowHost();
    let fails = 1;
    const flakyStore: SpawnReceiverDeps['requests'] = {
      get: (h, id) => requests.get(h, id),
      receive: (h, r) => requests.receive(h, r),
      decide: (h, id, code) => {
        if (fails-- > 0) throw new Error('disk full');
        return requests.decide(h, id, code);
      },
      pending: () => requests.pending(),
      pendingCount: (h) => requests.pendingCount(h),
      markSent: (h, id) => requests.markSent(h, id),
      unsent: () => requests.unsent(),
    };
    const r = makeReceiver({ requests: flakyStore, retryMinMs: 20 });
    const env = envelope();
    expect(r.applyInbound(env, { hostId: HOST })).toEqual({ ok: true, duplicate: false });
    await r.idle();
    expect(resultsFor(env)).toEqual([]);
    expect(requests.get(HOST, env.linkId)?.state).toBe('pending');
    await vi.waitFor(() => expect(resultsFor(env)[0]?.env.spawnResult?.code).toBe('not-supported'), { timeout: 5_000 });
    expect(requests.get(HOST, env.linkId)?.state).toBe('decided');
    r.stop();
  });

  it('a busy check gate keeps the request pending and tries again; stop() ends the retries', async () => {
    await allowHost();
    const gate = new SpawnChecks(1, 60_000);
    let hold!: () => void;
    void gate.run(() => new Promise<void>((res) => { hold = res; }));
    const r = makeReceiver({ checks: gate, retryMinMs: 20 });
    const env = envelope();
    r.applyInbound(env, { hostId: HOST });
    await r.idle();
    expect(requests.get(HOST, env.linkId)?.state).toBe('pending');
    hold();
    await vi.waitFor(() => expect(resultsFor(env)[0]?.env.spawnResult?.code).toBe('not-supported'), { timeout: 5_000 });

    const gate2 = new SpawnChecks(1, 60_000);
    let hold2!: () => void;
    void gate2.run(() => new Promise<void>((res) => { hold2 = res; }));
    const stopped = makeReceiver({ checks: gate2, retryMinMs: 20 });
    const later = envelope();
    stopped.applyInbound(later, { hostId: HOST });
    await stopped.idle();
    stopped.stop();
    hold2();
    await deliberateSleep(150, 'proves a negative: no retry fires after stop(), though the gate is free again');
    expect(resultsFor(later)).toEqual([]);
  });

  it('a removed PC leaves nothing in memory: no retry runs, and its targets start over at v1', async () => {
    await allowHost();
    const gate = new SpawnChecks(1, 60_000);
    let hold!: () => void;
    void gate.run(() => new Promise<void>((res) => { hold = res; }));
    const r = makeReceiver({ checks: gate, retryMinMs: 20 });
    const env = envelope();
    r.applyInbound(env, { hostId: HOST });
    await r.idle();
    // Only the receiver forgets here: its waiting retry must go with it.
    r.forgetHost(HOST);
    hold();
    await deliberateSleep(150, 'proves a negative: the removed PC\'s retry never fires, though the gate is free again');
    expect(resultsFor(env)).toEqual([]);
    expect(requests.get(HOST, env.linkId)?.state).toBe('pending');

    const got: number[] = [];
    const asker = makeReceiver({ onTargets: (_h, t) => got.push(t.version) });
    const targets = (version: number): A2aRemoteEnvelope => ({
      protocol: A2A_REMOTE_PROTOCOL, linkId: SPAWN_TARGETS_LINK_ID, linkVersion: 0, messageId: `st-${version}`, kind: 'link',
      link: { state: 'spawn-targets', version: 0 }, spawnTargets: { v: 1, version, roots: [], agents: [] }, sentAt: new Date().toISOString(),
    });
    asker.applyInbound(targets(5), { hostId: HOST });
    asker.forgetHost(HOST);
    asker.applyInbound(targets(1), { hostId: HOST });
    expect(got).toEqual([5, 1]);
  });

  it('a sub that could leave the root is refused before any disk check', async () => {
    await allowHost();
    const env = envelope();
    // Stored as given (a file from another build): never parsed through the wire.
    requests.receive(HOST, { ...env.spawn!, folder: { root: 'web', sub: '../outside' } } as never);
    const touched: string[] = [];
    const r = makeReceiver({ realpath: async (p) => { touched.push(p); return p; }, isDirectory: async () => true });
    r.recover();
    await r.idle();
    expect(resultsFor(env)[0]?.env.spawnResult?.code).toBe('folder-not-allowed');
    expect(touched).toEqual([]);
  });

  it('a check that times out keeps its slot until it really returns; past the cap a check is refused at once', async () => {
    const gate = new SpawnChecks(2, 20);
    let finish!: () => void;
    await expect(gate.run(() => new Promise<void>((res) => { finish = res; }))).rejects.toBeInstanceOf(CheckTimeout);
    expect(gate.running).toBe(1);
    void gate.run(() => new Promise(() => undefined)).catch(() => undefined);
    await expect(gate.run(async () => 1)).rejects.toBeInstanceOf(CheckBusy);
    finish();
    await vi.waitFor(() => expect(gate.running).toBe(1), { timeout: 5_000 });
    await expect(gate.run(async () => 1)).resolves.toBe(1);
  });

  it('only "not there" errors refuse a folder; others keep the request pending', async () => {
    await allowHost();
    const err = (code: string): Error => Object.assign(new Error(code), { code });
    const missing = makeReceiver({ realpath: async (p) => { if (p !== repo) throw err('ENOENT'); return p; } });
    expect(await decide(envelope({ spawn: { folder: { root: 'web', sub: 'gone' } } }), HOST, missing)).toBe('folder-not-allowed');
    const busy = makeReceiver({ realpath: async (p) => { if (p !== repo) throw err('EMFILE'); return p; }, retryMinMs: 60_000 });
    const env = envelope({ spawn: { folder: { root: 'web', sub: 'apps' } } });
    busy.applyInbound(env, { hostId: HOST });
    await busy.idle();
    expect(resultsFor(env)).toEqual([]);
    expect(requests.get(HOST, env.linkId)?.state).toBe('pending');
    busy.stop();
  });
});

describe('replay, resend and room', () => {
  it('every result is its own message: one id per request and outcome', async () => {
    await allowHost();
    const a = envelope();
    const b = envelope();
    await decide(a);
    await decide(b);
    // A resend of the answer is a message of its own too, so nothing on the way takes it for the first.
    expect(receiver.applyInbound(a, { hostId: HOST })).toEqual({ ok: true, duplicate: true });
    const ids = sent.map((s) => s.env.messageId);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(A2A_REMOTE_MESSAGE_ID_RE);
    // `_` is in neither a spawnId nor a code: the id splits back into exactly the two.
    const [tag, spawnId, code] = ids[0].split('_');
    expect([tag, spawnId, code]).toEqual(['res', a.linkId, 'not-supported']);
    expect(ids[2].split('_').slice(0, 3)).toEqual(['res', a.linkId, 'not-supported']);
  });

  it('a resend gets the stored answer again (the first may have been lost); another body under the same id is a conflict', async () => {
    await allowHost();
    const env = envelope();
    await decide(env);
    expect(receiver.applyInbound(env, { hostId: HOST })).toEqual({ ok: true, duplicate: true });
    expect(resultsFor(env).map((s) => s.env.spawnResult?.code)).toEqual(['not-supported', 'not-supported']);
    const other = envelope({ spawn: { spawnId: env.linkId, text: 'something else' } });
    expect(receiver.applyInbound(other, { hostId: HOST })).toEqual({ ok: false, error: 'conflict' });
  });

  it('a PC no longer allowed learns nothing from a resend: not-allowed, answered once per window', async () => {
    await allowHost();
    const coalescing = makeReceiver({ refusalCoalesceMs: 60_000 });
    const env = envelope();
    await decide(env, HOST, coalescing);
    await allowHost({ enabled: false });
    for (let i = 0; i < 5; i++) expect(coalescing.applyInbound(env, { hostId: HOST })).toEqual({ ok: true, duplicate: false });
    expect(resultsFor(env).map((s) => s.env.spawnResult?.code)).toEqual(['not-supported', 'not-allowed']);
  });

  it('a resend of a stored answer is coalesced, and one the outbox will not take is unavailable', async () => {
    await allowHost();
    const r = makeReceiver({ refusalCoalesceMs: 60_000 });
    const env = envelope();
    await decide(env, HOST, r);
    for (let i = 0; i < 3; i++) expect(r.applyInbound(env, { hostId: HOST })).toEqual({ ok: true, duplicate: true });
    expect(resultsFor(env)).toHaveLength(1);
    const later = makeReceiver({ enqueue: () => { throw new Error('outbox full'); } });
    expect(later.applyInbound(env, { hostId: HOST })).toEqual({ ok: false, error: 'unavailable' });
  });

  it('a pending request nobody is deciding (after a restart) is decided on its resend; one decided but never sent goes out on recover', async () => {
    await allowHost();
    const env = envelope();
    // Stored pending by a receiver that stopped before deciding.
    requests.receive(HOST, { ...env.spawn! });
    const fresh = makeReceiver();
    expect(fresh.applyInbound(env, { hostId: HOST })).toEqual({ ok: true, duplicate: true });
    await fresh.idle();
    expect(resultsFor(env)[0]?.env.spawnResult?.code).toBe('not-supported');

    const lost = envelope();
    requests.receive(HOST, { ...lost.spawn! });
    requests.decide(HOST, lost.linkId, 'agent-not-allowed');
    expect(requests.unsent().map((r) => r.spawnId)).toContain(lost.linkId);
    makeReceiver().recover();
    expect(resultsFor(lost)[0]?.env.spawnResult?.code).toBe('agent-not-allowed');
    expect(requests.unsent().map((r) => r.spawnId)).not.toContain(lost.linkId);
  });

  it('pending per PC set to 3: the next one is refused as rate-limited', async () => {
    await allowHost({ limits: { pendingPerPc: 3 } });
    const hang = makeReceiver({ agentInstalled: () => new Promise(() => undefined), checks: new SpawnChecks(8, 60_000) });
    for (let i = 0; i < 3; i++) expect(hang.applyInbound(envelope(), { hostId: HOST })).toEqual({ ok: true, duplicate: false });
    const fourth = envelope();
    expect(hang.applyInbound(fourth, { hostId: HOST })).toEqual({ ok: true, duplicate: false });
    expect(resultsFor(fourth)[0]?.env.spawnResult?.code).toBe('rate-limited');
  });

  it(`with no pending limit set, ${SPAWN_PENDING_PER_HOST_DEFAULT} per PC; another PC still gets in`, async () => {
    await allowHost({ hosts: { [HOST]: { allowed: true }, [OTHER]: { allowed: true } } });
    const hang = makeReceiver({ agentInstalled: () => new Promise(() => undefined), checks: new SpawnChecks(8, 60_000) });
    for (let i = 0; i < SPAWN_PENDING_PER_HOST_DEFAULT; i++) expect(hang.applyInbound(envelope(), { hostId: HOST })).toEqual({ ok: true, duplicate: false });
    const over = envelope();
    hang.applyInbound(over, { hostId: HOST });
    expect(resultsFor(over)[0]?.env.spawnResult?.code).toBe('rate-limited');
    const other = envelope();
    hang.applyInbound(other, { hostId: OTHER });
    expect(resultsFor(other)).toEqual([]);
  });

  it('a prompt longer than this PC accepts is refused not-allowed, and nothing is kept', async () => {
    await allowHost({ limits: { maxPromptKiB: 1 } });
    const long = envelope({ spawn: { text: 'x'.repeat(1025) } });
    expect(await decide(long)).toBe('not-allowed');
    expect(requests.get(HOST, long.linkId)).toBeUndefined();
    const fits = envelope({ spawn: { text: 'x'.repeat(1024) } });
    receiver.applyInbound(fits, { hostId: HOST });
    expect(requests.get(HOST, fits.linkId)).toBeDefined();
  });

  it('a request that asks to wait longer than this PC allows ends sooner here; the request is kept as sent', async () => {
    await allowHost({ limits: { maxWaitHours: 1 } });
    const env = envelope({ expiresIn: 5 * 3600_000 });
    const before = Date.now();
    receiver.applyInbound(env, { hostId: HOST });
    const rec = requests.get(HOST, env.linkId)!;
    expect(Date.parse(rec.expiresAt) - before).toBeLessThanOrEqual(3600_000 + 1000);
    expect(rec.request?.expiresAt).toBe(env.spawn?.expiresAt);
    // A resend of the same request is the same request (no conflict).
    expect(receiver.applyInbound(env, { hostId: HOST })).toMatchObject({ ok: true, duplicate: true });
    // A shorter ask than the limit is untouched.
    const short = envelope({ expiresIn: 1800_000 });
    receiver.applyInbound(short, { hostId: HOST });
    expect(requests.get(HOST, short.linkId)?.expiresAt).toBe(short.spawn?.expiresAt);
  });

  it('every result carries a code and the spawnId only: no path, errno or message', async () => {
    await allowHost();
    installed.clear();
    await decide(envelope({ spawn: { folder: { root: 'web', sub: 'missing' } } }));
    await decide(envelope(), OTHER);
    for (const { env } of sent) {
      expect(Object.keys(env.spawnResult ?? {}).sort()).toEqual(['code', 'spawnId', 'v']);
      expect(JSON.stringify(env)).not.toContain(dir);
      expect(JSON.stringify(env)).not.toMatch(/ENOENT|EACCES|Error/);
    }
  });
});

describe('SpawnRequestStore', () => {
  const req = (expiresIn = 3600_000) => ({ ...envelope({ expiresIn }).spawn! });

  it('a write that fails leaves nothing behind: no ghost record holding a slot', () => {
    const failing = new SpawnRequestStore({ dir: a2aDir, scheduleHarden: quiet, write: () => { throw new Error('disk full'); } });
    expect(() => failing.receive(HOST, req())).toThrow(/disk full/);
    expect(failing.pendingCount(HOST)).toBe(0);
    expect(failing.summaries()).toEqual([]);
  });

  const HOUR = 3600_000;
  const DAY = 24 * HOUR;
  /** A request taken, approved, started and its answer sent. */
  const startedOne = (store: SpawnRequestStore, r: ReturnType<typeof req>, hostId = HOST): void => {
    store.receive(hostId, r);
    store.advance(hostId, r.spawnId, ['pending'], 'approved');
    store.decide(hostId, r.spawnId, 'started', { endpoint: { kind: 'pane', workspaceId: 'ws-b', paneId: 'pane-b' }, linkVersion: 1, linkId: `lk-${r.spawnId}` });
    store.markSent(hostId, r.spawnId);
  };

  it('150 ended starts from one PC in a day: the 151st is still taken', () => {
    const store = new SpawnRequestStore({ dir: a2aDir, scheduleHarden: quiet, write: () => undefined });
    for (let i = 0; i < 150; i++) startedOne(store, req());
    expect(store.receive(HOST, req()).kind).toBe('new');
    expect(store.startsSince(Date.now() - DAY, HOST)).toBe(150);
  });

  it('a decided record stays while its request could be resent, and a resend is answered from it; a full store makes room with ones that cannot', () => {
    let now = Date.now();
    const store = new SpawnRequestStore({ dir: a2aDir, scheduleHarden: quiet, write: () => undefined, now: () => now });
    const long = req(72 * HOUR);
    store.receive(HOST, long);
    store.decide(HOST, long.spawnId, 'not-supported');
    store.markSent(HOST, long.spawnId);
    for (let i = 1; i < SPAWN_REQUESTS_MAX / 2; i++) startedOne(store, req());
    for (let i = 0; i < SPAWN_REQUESTS_MAX / 2; i++) startedOne(store, req(), OTHER);
    // Every record can still be resent: no room.
    expect(store.receive(THIRD, req())).toEqual({ kind: 'full' });
    // The 1 h requests expired; the oldest record (the 72 h one) still can be resent and stays.
    now += 2 * HOUR;
    expect(store.receive(THIRD, req()).kind).toBe('new');
    expect(store.receive(HOST, long).kind).toBe('duplicate');
    // Past the day it is kept after its decision, but inside its request's expiry: still answered from its record.
    now += SPAWN_REQUEST_KEEP_MS;
    store.prune();
    expect(store.receive(HOST, long)).toEqual({ kind: 'duplicate', rec: expect.objectContaining({ state: 'decided', code: 'not-supported' }) });
    now += 72 * HOUR;
    store.prune();
    expect(store.get(HOST, long.spawnId)).toBeUndefined();
  });

  it('one PC holds at most half the store in decided requests that could still be resent: past that it waits, another PC does not; expiry frees it', () => {
    let now = Date.now();
    const store = new SpawnRequestStore({ dir: a2aDir, scheduleHarden: quiet, write: () => undefined, now: () => now });
    for (let i = 0; i < SPAWN_REQUESTS_MAX / 2; i++) startedOne(store, req());
    expect(store.receive(HOST, req())).toEqual({ kind: 'full' });
    expect(store.receive(OTHER, req()).kind).toBe('new');
    now += 2 * HOUR;
    expect(store.receive(HOST, req()).kind).toBe('new');
  });

  it('records that make room leave their start times while an hour or day limit is set: starts per day are not undercounted, also after a restart', () => {
    let now = Date.now();
    let written: unknown;
    const store = new SpawnRequestStore({ dir: a2aDir, scheduleHarden: quiet, write: (_p, d) => { written = d; }, now: () => now });
    // Two batches an expiry apart, so one PC holds the whole store within the day.
    for (let i = 0; i < SPAWN_REQUESTS_MAX / 2; i++) startedOne(store, req());
    now += 2 * HOUR;
    for (let i = 0; i < SPAWN_REQUESTS_MAX / 2; i++) startedOne(store, req());
    expect(store.receive(OTHER, req(), undefined, true).kind).toBe('new');
    expect(store.receive(OTHER, req(), undefined, true).kind).toBe('new');
    expect(store.startsSince(now - DAY, HOST)).toBe(SPAWN_REQUESTS_MAX);
    expect(store.approvedSince(now - DAY, HOST)).toBe(SPAWN_REQUESTS_MAX);
    expect(store.approvedSince(now - DAY)).toBe(SPAWN_REQUESTS_MAX);
    // With no such limit set, nothing is kept for them.
    expect(store.receive(OTHER, req()).kind).toBe('new');
    expect(store.startsSince(now - DAY, HOST)).toBe(SPAWN_REQUESTS_MAX - 1);

    // The store's own writes were kept in memory: its folder is made here for the one file read back.
    fs.mkdirSync(a2aDir, { recursive: true });
    fs.writeFileSync(path.join(a2aDir, SPAWN_REQUESTS_FILE), JSON.stringify(written), { mode: 0o600 });
    const reloaded = new SpawnRequestStore({ dir: a2aDir, scheduleHarden: quiet, write: () => undefined, now: () => now });
    expect(reloaded.startsSince(now - DAY, HOST)).toBe(SPAWN_REQUESTS_MAX - 1);
    // A day on, the start times are gone with the day.
    now += DAY + HOUR;
    reloaded.prune();
    expect(reloaded.startsSince(now - DAY, HOST)).toBe(0);
  });
});

describe('as the asker: answers and targets', () => {
  it('an answer nobody here asked for, or one already answered, is not handed on; targets only when newer', async () => {
    const got: unknown[] = [];
    const outstanding = new Set<string>();
    let takes = false;
    const asker = makeReceiver({
      isOutstanding: (_h, id) => outstanding.has(id),
      onResult: async (_h, r) => {
        got.push(r);
        return takes;
      },
      onTargets: (_h, t) => got.push(t),
    });
    const spawnId = `sp-${crypto.randomUUID()}`;
    const result = (code: string): A2aRemoteEnvelope => ({
      protocol: A2A_REMOTE_PROTOCOL, linkId: spawnId, linkVersion: 0, messageId: `res-${spawnId}-${code}`, kind: 'link',
      link: { state: 'spawn-result', version: 0 }, spawnResult: { v: 1, spawnId, code: code as 'not-supported' }, sentAt: new Date().toISOString(),
    });
    expect(await asker.applyInbound(result('not-supported'), { hostId: HOST })).toEqual({ ok: true, duplicate: false });
    expect(got).toEqual([]);
    outstanding.add(spawnId);
    // Not taken yet (the asking side could not write it): refused so it comes again, and not counted as answered.
    expect(await asker.applyInbound(result('not-supported'), { hostId: HOST })).toEqual({ ok: false, error: 'unavailable' });
    takes = true;
    expect(await asker.applyInbound(result('not-supported'), { hostId: HOST })).toEqual({ ok: true, duplicate: false });
    await asker.applyInbound(result('not-supported'), { hostId: HOST });
    expect(got).toHaveLength(2);

    const targets = (version: number): A2aRemoteEnvelope => ({
      protocol: A2A_REMOTE_PROTOCOL, linkId: SPAWN_TARGETS_LINK_ID, linkVersion: 0, messageId: `st-${version}`, kind: 'link',
      link: { state: 'spawn-targets', version: 0 }, spawnTargets: { v: 1, version, roots: [], agents: [] }, sentAt: new Date().toISOString(),
    });
    asker.applyInbound(targets(2), { hostId: HOST });
    asker.applyInbound(targets(1), { hostId: HOST });
    asker.applyInbound(targets(2), { hostId: HOST });
    expect(got).toHaveLength(3);
  });
});

describe('as the PC asked: telling other PCs what they may ask for', () => {
  const targetsSent = () => sent.filter((x) => x.env.link?.state === 'spawn-targets').map((x) => ({ hostId: x.hostId, targets: x.env.spawnTargets }));

  it('a save tells each PC allowed now its targets, and one no longer allowed empty lists; others hear nothing', async () => {
    const handlers = new Map<string, (p: Record<string, unknown>) => Promise<unknown>>();
    registerSpawnRpc((m, h) => void handlers.set(m, h), { policy, requests, onSaved: (previous) => receiver.sendTargets(previous) });
    const save = async (over: Record<string, unknown>) => handlers.get('a2a.remote.spawnPolicy.set')!({
      policy: {
        v: 1, enabled: true, approval: 'ask', followUps: 'ask', permissionMode: 'auto', hosts: {}, roots: [{ id: 'web', label: 'Web', path: repo }],
        agents: ['claude'], rules: [], version: policy.get().version, ...over,
      },
    });
    expect(await save({ hosts: { [HOST]: { allowed: true } } })).toMatchObject({ ok: true });
    expect(targetsSent()).toEqual([{ hostId: HOST, targets: { v: 1, version: policy.get().version, roots: [{ id: 'web', label: 'Web' }], agents: ['claude'] } }]);
    sent.length = 0;
    expect(await save({ hosts: { [HOST]: { allowed: false } } })).toMatchObject({ ok: true });
    expect(targetsSent()).toEqual([{ hostId: HOST, targets: { v: 1, version: policy.get().version, roots: [], agents: [] } }]);
    sent.length = 0;
    expect(await save({ enabled: false })).toMatchObject({ ok: true });
    expect(targetsSent()).toEqual([]);
  });

  it('asked with an agent, the policy read says whether a request for that agent would find it here', async () => {
    const handlers = new Map<string, (p: Record<string, unknown>) => Promise<unknown>>();
    registerSpawnRpc((m, h) => void handlers.set(m, h), { policy, requests, agentInstalled: async (agent) => installed.has(agent) });
    const get = (params: Record<string, unknown>) => handlers.get('a2a.remote.spawnPolicy.get')!(params);
    installed = new Set(['claude']);
    expect(await get({ agent: 'claude' })).toMatchObject({ policy: policy.get(), agentInstalled: true });
    installed = new Set();
    expect(await get({ agent: 'claude' })).toMatchObject({ agentInstalled: false });
    // Without an agent, or with one that cannot be started from another PC: the policy only.
    expect(await get({})).toEqual({ policy: policy.get() });
    expect(await get({ agent: 'not-an-agent' })).toEqual({ policy: policy.get() });
  });

  it('on start, each allowed PC gets its targets unless they are still queued for it', async () => {
    await allowHost();
    let queued = true;
    const r = makeReceiver({ targetsQueued: () => queued });
    r.sendTargets();
    expect(targetsSent()).toEqual([]);
    queued = false;
    r.sendTargets();
    expect(targetsSent()).toHaveLength(1);
  });
});

describe('a policy saved from outside the app', () => {
  type Handler = (p: Record<string, unknown>, ctx?: { clientId: string }) => Promise<unknown>;
  const THIRD = '33333333-3333-4333-8333-333333333333';
  function register(paired: Set<string>): Map<string, Handler> {
    const handlers = new Map<string, Handler>();
    registerSpawnRpc((m, h) => void handlers.set(m, h), {
      policy, requests,
      outsideApp: { isApp: (clientId) => clientId === 'app', isPaired: (hostId) => paired.has(hostId) },
    });
    return handlers;
  }
  const body = (over: Record<string, unknown>) => ({
    policy: {
      v: 1, enabled: true, approval: 'allow-list', followUps: 'ask', permissionMode: 'auto', hosts: {}, roots: [{ id: 'web', label: 'Web', path: repo }],
      agents: ['claude'], rules: [], version: policy.get().version, ...over,
    },
  });

  it('may not name or allow a PC that is not paired, in hosts or in a rule; the app may', async () => {
    const save = register(new Set([HOST])).get('a2a.remote.spawnPolicy.set')!;
    expect(await save(body({ hosts: { [OTHER]: { allowed: true } } }), { clientId: 'cli' })).toEqual({ ok: false, error: `${OTHER} is not paired with this PC` });
    expect(await save(body({ hosts: { [OTHER]: { allowed: false } } }), { clientId: 'cli' })).toMatchObject({ ok: false });
    expect(await save(body({ rules: [{ hostId: OTHER, rootId: 'web', agent: 'claude' }] }), { clientId: 'cli' })).toMatchObject({ ok: false });
    expect(policy.get().hosts).toEqual({});
    // A paired PC saves from outside the app; the app's own connection saves anything, as before.
    expect(await save(body({ hosts: { [HOST]: { allowed: true } }, rules: [{ hostId: HOST, rootId: 'web', agent: 'claude' }] }), { clientId: 'cli' })).toMatchObject({ ok: true });
    expect(await save(body({ hosts: { [HOST]: { allowed: true }, [OTHER]: { allowed: true } } }), { clientId: 'app' })).toMatchObject({ ok: true });
  });

  it('writes back what the saved policy already holds for a PC no longer paired, and nothing more for it', async () => {
    await allowHost({ hosts: { [HOST]: { allowed: true }, [OTHER]: { allowed: true } }, rules: [{ hostId: OTHER, rootId: 'web', agent: 'claude' }] });
    const save = register(new Set([HOST])).get('a2a.remote.spawnPolicy.set')!;
    const held = { [HOST]: { allowed: true }, [OTHER]: { allowed: true } };
    const heldRule = { hostId: OTHER, rootId: 'web', agent: 'claude' };
    // Read and written back (here with a new rule for the paired PC): saves.
    expect(await save(body({ hosts: held, rules: [heldRule, { hostId: HOST, rootId: 'web', agent: 'claude' }] }), { clientId: 'cli' })).toMatchObject({ ok: true });
    // A new rule for the unpaired PC, or a third unpaired PC: refused.
    expect(await save(body({ hosts: held, rules: [heldRule, { hostId: OTHER, rootId: 'web', agent: 'claude', sub: 'apps' }] }), { clientId: 'cli' })).toMatchObject({ ok: false, error: `${OTHER} is not paired with this PC` });
    expect(await save(body({ hosts: { ...held, [THIRD]: { allowed: false } }, rules: [heldRule] }), { clientId: 'cli' })).toMatchObject({ ok: false, error: `${THIRD} is not paired with this PC` });
    // Dropping the unpaired PC is always fine.
    expect(await save(body({ hosts: { [HOST]: { allowed: true } }, rules: [] }), { clientId: 'cli' })).toMatchObject({ ok: true });
  });

  it('passes what is not shaped like a policy on to the store, which refuses it', async () => {
    const save = register(new Set()).get('a2a.remote.spawnPolicy.set')!;
    for (const raw of [undefined, 'x', [], { hosts: [], rules: 'x' }]) {
      expect(unpairedHostNamed(raw, policy.get(), () => false)).toBeNull();
      expect(await save({ policy: raw }, { clientId: 'cli' })).toMatchObject({ ok: false });
    }
  });
});

describe('through acceptInbound', () => {
  it('is answered before any link check; an older build without it refuses the unknown link without failing', async () => {
    const log = new AppendOnlyLog({ dir: path.join(dir, 'log'), fsync: () => undefined });
    log.open();
    const deps: InboundDeps = {
      linkStore: new LinkStore({ dir: path.join(dir, 'links'), scheduleHarden: quiet }),
      taskService: new A2aTaskService({ log, origin: { machineId: 'm', daemonEpoch: 1 } }),
      broadcast: quiet,
      aliasFor: (l) => linkAlias(l, 'pc'),
    };
    expect(await acceptInbound(envelope(), { hostId: HOST }, { ...deps, spawn: receiver })).toEqual({ ok: true, duplicate: false });
    const older = await acceptInbound(envelope(), { hostId: HOST }, deps);
    expect(older.ok).toBe(false);
    log.close();
  });
});

describe('SpawnPolicyStore', () => {
  it('stores each root as its realpath, and refuses a folder that is not a repository\'s top level', async () => {
    const link = path.join(dir, 'repo-link');
    fs.symlinkSync(repo, link, 'dir');
    await allowHost({ roots: [{ id: 'web', label: 'Web', path: link }] });
    expect(policy.get().roots[0].path).toBe(repo);
    for (const p of [path.join(repo, 'apps'), path.join(dir, 'missing'), 'relative/path']) {
      const res = await policy.set({ ...policy.get(), roots: [{ id: 'x', label: 'X', path: p }] });
      expect(res.ok).toBe(false);
    }
    expect(policy.get().roots[0].path).toBe(repo);
  });

  it('a save made from an older read is a conflict, and a PC removed during a save stays removed', async () => {
    await allowHost();
    const read = policy.get();
    await allowHost({ agents: ['claude'] });
    expect(await policy.set({ ...read, agents: ['codex'] })).toMatchObject({ ok: false, conflict: true });

    // The save waits on the folder checks; the PC is removed meanwhile.
    let releaseTop!: () => void;
    const slow = new SpawnPolicyStore({
      dir: a2aDir, scheduleHarden: quiet,
      repoToplevel: (d) => new Promise((r) => { releaseTop = () => r(d); }),
    });
    const pending = slow.set({ ...slow.get(), followUps: 'direct' });
    await vi.waitFor(() => expect(releaseTop).toBeTypeOf('function'), { timeout: 5_000 });
    expect(slow.forgetHost(HOST)).toBe(true);
    releaseTop();
    expect(await pending).toMatchObject({ ok: false, conflict: true });
    expect(slow.get().hosts[HOST]).toBeUndefined();
  });

  it('a folder that does not answer fails its save in time, and the next save still runs', async () => {
    let hang = true;
    // Every check here times out at 30 ms, so the git call is a seam: a real
    // one takes longer than that to start on a loaded Windows runner.
    const slow = new SpawnPolicyStore({
      dir: a2aDir, scheduleHarden: quiet, checks: new SpawnChecks(8, 30),
      realpath: (p) => (hang ? new Promise(() => undefined) : realpathNative(p)),
      repoToplevel: async (d) => d,
    });
    const base = { ...slow.get(), roots: [{ id: 'web', label: 'Web', path: repo }] };
    expect(await slow.set(base)).toEqual({ ok: false, error: 'Web: the folder did not answer in time' });
    hang = false;
    // The hung check still holds its slot; the next save has room and goes through.
    const next = await slow.set(base);
    expect(next.ok ? 'saved' : next.error).toBe('saved');
  });

  it('a save has one time budget from the call, so one the app gave up on has saved nothing', async () => {
    // The clock and every timer here are the test's: a folder takes exactly
    // 40 ms and the budget is exactly 100 ms, however loaded the machine is
    // (no git runs: the top-level check answers at once).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const slowRoot = (): Promise<string> => new Promise((r) => setTimeout(() => r(repo), 40));
      const slow = new SpawnPolicyStore({
        dir: a2aDir, scheduleHarden: quiet, checks: new SpawnChecks(8, 5_000), setBudgetMs: 100,
        realpath: slowRoot, repoToplevel: async (dir) => dir, now: () => Date.now(),
      });
      // Each folder answers within its own timeout, but together they take longer than the save may.
      const roots = ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id.toUpperCase(), path: repo }));
      const over = slow.set({ ...slow.get(), roots });
      await vi.advanceTimersByTimeAsync(100);
      expect(await over).toEqual({ ok: false, error: 'the folders did not answer in time; nothing was saved' });
      expect(slow.get().version).toBe(0);
      expect(fs.existsSync(slow.filePath)).toBe(false);
      // A save queued behind a slow one counts its wait too: one folder (40 ms)
      // fits in the budget alone, but not in what is left of it after the wait.
      // (A save with nothing to check could still land in that remainder.)
      await vi.advanceTimersByTimeAsync(200);
      const first = slow.set({ ...slow.get(), roots });
      const second = slow.set({ ...slow.get(), roots: roots.slice(0, 1) });
      // Long enough for the queued one to finish its folder, had it a budget of its own.
      await vi.advanceTimersByTimeAsync(200);
      expect(await first).toMatchObject({ ok: false });
      expect(await second).toMatchObject({ ok: false });
      expect(slow.get().version).toBe(0);
      await vi.advanceTimersByTimeAsync(200);
      const alone = slow.set({ ...slow.get(), roots: roots.slice(0, 1) });
      await vi.advanceTimersByTimeAsync(40);
      expect(await alone).toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('on start, PCs no longer paired are dropped from the policy and the requests', async () => {
    await allowHost();
    requests.receive(HOST, { ...envelope().spawn! });
    expect(policy.retainHosts((h) => h !== HOST)).toBe(true);
    expect(policy.get().hosts).toEqual({});
    expect(requests.retainHosts((h) => h !== HOST)).toBe(1);
    expect(new SpawnRequestStore({ dir: a2aDir, scheduleHarden: quiet }).summaries()).toEqual([]);
    expect(policy.retainHosts(() => true)).toBe(false);
  });

  it('a removed PC is no longer allowed even when the file cannot be written', async () => {
    await allowHost();
    const lines: string[] = [];
    const broken = new SpawnPolicyStore({ dir: a2aDir, scheduleHarden: quiet, write: () => { throw new Error('read-only'); }, log: (_l, m) => lines.push(m) });
    expect(broken.get().hosts[HOST]).toEqual({ allowed: true });
    expect(broken.forgetHost(HOST)).toBe(true);
    expect(broken.get().hosts[HOST]).toBeUndefined();
    expect(lines.join('\n')).toMatch(/not saved/);
  });

  it('a rule for a folder that is no longer listed is dropped, so a folder added later cannot inherit it', async () => {
    await allowHost({ rules: [{ hostId: HOST, rootId: 'web', agent: 'claude' }] });
    expect(policy.get().rules).toHaveLength(1);
    await allowHost({ roots: [], rules: policy.get().rules });
    expect(policy.get().rules).toEqual([]);
  });

  it('versions every save itself, keeps it across a restart, and a removed PC is forgotten', async () => {
    await allowHost();
    await allowHost();
    expect(policy.get().version).toBe(2);
    const again = new SpawnPolicyStore({ dir: a2aDir, scheduleHarden: quiet });
    expect(again.get().hosts[HOST]).toEqual({ allowed: true });
    expect(again.forgetHost(HOST)).toBe(true);
    expect(again.get().hosts[HOST]).toBeUndefined();
  });

  it('the RPCs read and set it; the requests list has no prompt', async () => {
    const handlers = new Map<string, (p: Record<string, unknown>) => Promise<unknown>>();
    registerSpawnRpc((m, h) => void handlers.set(m, h), { policy, requests });
    expect(await handlers.get('a2a.remote.spawnPolicy.get')!({})).toMatchObject({ policy: { enabled: false } });
    expect(await handlers.get('a2a.remote.spawnPolicy.set')!({ policy: { v: 1 } })).toMatchObject({ ok: false });
    await allowHost();
    await decide(envelope());
    expect(JSON.stringify(await handlers.get('a2a.remote.spawnRequests.list')!({}))).not.toContain('fix the build');
  });

  it('samePath folds case only on Windows', () => {
    expect(samePath('C:\\Repo', 'c:\\repo', 'win32')).toBe(true);
    expect(samePath('/Users/a/Repo', '/Users/a/repo', 'darwin')).toBe(false);
    expect(samePath('/home/a/Repo', '/home/a/repo', 'linux')).toBe(false);
    expect(samePath('/home/a/repo', '/home/a/repo/', 'linux')).toBe(true);
  });
});
