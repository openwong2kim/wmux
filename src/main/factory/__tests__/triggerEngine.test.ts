import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TriggerEngine,
  botSeesFact,
  createTriggerModule,
  filterMatches,
  matchingTrigger,
  resolvePorts,
  setFactoryTriggerPorts,
  wakePriority,
  type FactLogApi,
  type FactoryTrustApi,
  type WakeSinkApi,
  isRoutineFact,
} from '../triggerEngine';
import { LEGACY_VERIFIER_TRIGGERS, ROLE_DEFAULT_TRIGGERS, defaultTriggers } from '../roleDefaults';
import { registeredFactoryModules } from '../factoryHost';
import type { BotProfile, BotRole } from '../../../shared/bot';
import type { Fact, FactKind } from '../../../shared/facts';
import type { WakeItem } from '../../../shared/wake';

const KEY = 'github.com/acme/app';
let seq = 0;

function fact(kind: FactKind, extra: Partial<Fact> = {}): Fact {
  seq++;
  return { id: `f${seq}`, seq, kind, at: 1, dedupeKey: `k${seq}`, payload: {}, ...extra };
}

// A verifier here is one its owner set to wake on PR events (the old
// default); the role's default is none (it verifies on request).
function bot(id: string, role: BotRole, extra: Partial<BotProfile> = {}): BotProfile {
  const triggers = role === 'verifier' ? LEGACY_VERIFIER_TRIGGERS.map((t) => ({ ...t })) : defaultTriggers(role);
  return {
    version: 1, id, workspaceId: 'ws-1', role, name: role, engine: { kind: 'claude-sdk' }, triggers,
    budget: { maxTurnsPerHour: 1, maxTurnsPerDay: 1, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 1, turnTimeoutMs: 1 },
    repo: { repoKey: KEY, repoPath: '/repo' }, enabled: true, createdAt: 0, updatedAt: 0, ...extra,
  };
}

const trust: FactoryTrustApi = { trustedAuthors: () => ['Alice'], ownerLogin: () => 'owner' };

function harness(bots: BotProfile[], t: FactoryTrustApi | undefined = trust) {
  const subs: Array<(f: Fact) => void> = [];
  const factLog: FactLogApi = {
    append: () => null,
    subscribe: (fn) => { subs.push(fn); return () => { subs.splice(subs.indexOf(fn), 1); }; },
    readSince: () => ({ facts: [], cursor: null }),
  };
  const enqueued: Parameters<WakeSinkApi['enqueue']>[0][] = [];
  const wakes: WakeSinkApi = {
    enqueue: (input) => {
      enqueued.push(input);
      return { id: `w${enqueued.length}`, ...input, enqueuedAt: 0, attempts: 0, state: 'queued' } as WakeItem;
    },
  };
  const engine = new TriggerEngine({ factLog, wakes, bots: { listEnabled: () => bots.filter((b) => b.enabled), get: () => null }, trust: t }, () => undefined);
  return { engine, enqueued, emit: (f: Fact) => subs.forEach((s) => s(f)), subs };
}

describe('roleDefaults', () => {
  it('match design §5', () => {
    expect(ROLE_DEFAULT_TRIGGERS.lead.map((t) => t.kind)).toEqual(['task.done', 'task.failed', 'task.input_required', 'merge.refused']);
    expect(ROLE_DEFAULT_TRIGGERS.triage).toEqual([
      { kind: 'issue.opened', filter: { authorTrusted: true } },
      { kind: 'issue.labelled', filter: { labelsAny: ['bug', 'triage'], authorTrusted: true } },
    ]);
    // The verifier verifies only on request: no PR event wakes it.
    expect(ROLE_DEFAULT_TRIGGERS.verifier).toEqual([]);
    expect(ROLE_DEFAULT_TRIGGERS.maintainer).toEqual([{ kind: 'merge.done', batch: { windowMs: 3_600_000, max: 20 } }]);
    expect(ROLE_DEFAULT_TRIGGERS.moa.map((t) => t.kind)).toEqual(['schedule.fired', 'bot.budget_exhausted']);
  });

  it('defaultTriggers returns a copy the caller may edit', () => {
    const t = defaultTriggers('triage');
    t[1].filter!.labelsAny!.push('x');
    expect(ROLE_DEFAULT_TRIGGERS.triage[1].filter!.labelsAny).toEqual(['bug', 'triage']);
  });
});

describe('trigger matching', () => {
  it('authorTrusted: trusted list ∪ owner, case-insensitive; unknown author or no trust source never matches', () => {
    const v = bot('bot-00000001', 'verifier');
    const pr = (author?: string) => fact('pr.opened', { repoKey: KEY, ref: { pr: 1, headSha: 'h' }, payload: author ? { author } : {} });
    expect(matchingTrigger(v, pr('alice'), trust)?.kind).toBe('pr.opened');
    expect(matchingTrigger(v, pr('OWNER'), trust)?.kind).toBe('pr.opened');
    expect(matchingTrigger(v, pr('mallory'), trust)).toBeNull();
    expect(matchingTrigger(v, pr(), trust)).toBeNull();
    expect(matchingTrigger(v, pr('alice'), undefined)).toBeNull();
    const throwing: FactoryTrustApi = { trustedAuthors: () => { throw new Error('x'); }, ownerLogin: () => null };
    expect(matchingTrigger(v, pr('alice'), throwing)).toBeNull();
    // ci.failed of an untrusted PR does not wake the verifier either.
    expect(matchingTrigger(v, fact('ci.failed', { repoKey: KEY, payload: { author: 'mallory' } }), trust)).toBeNull();
  });

  it('botIdNot: a bot never triggers on its own verdict (explicit id, or self)', () => {
    const v = bot('bot-00000001', 'verifier', { triggers: [{ kind: 'verdict.recorded', filter: { botIdNot: 'self' } }] });
    const verdict = (botId: string) => fact('verdict.recorded', { repoKey: KEY, ref: { pr: 1, headSha: 'h', botId } });
    expect(matchingTrigger(v, verdict('bot-00000001'), trust)).toBeNull();
    expect(matchingTrigger(v, verdict('bot-00000002'), trust)?.kind).toBe('verdict.recorded');
    expect(filterMatches({ botIdNot: 'bot-00000002' }, verdict('bot-00000002'), v, trust)).toBe(false);
    // A fact the bot itself produced never wakes it, filter or not.
    const self = fact('task.done', { workspaceId: 'ws-1', actor: { kind: 'bot', id: 'bot-00000003' } });
    expect(matchingTrigger(bot('bot-00000003', 'lead'), self, trust)).toBeNull();
  });

  it('triage starts on its own only for a trusted author\'s issue', () => {
    const t = bot('bot-00000001', 'triage');
    const opened = (author?: string) => fact('issue.opened', { repoKey: KEY, ref: { issue: 1 }, payload: author ? { author, labels: [] } : { labels: [] } });
    expect(matchingTrigger(t, opened('alice'), trust)?.kind).toBe('issue.opened');
    expect(matchingTrigger(t, opened('owner'), trust)?.kind).toBe('issue.opened');
    expect(matchingTrigger(t, opened('mallory'), trust)).toBeNull();
    expect(matchingTrigger(t, opened(), trust)).toBeNull();
    expect(matchingTrigger(t, opened('alice'), undefined)).toBeNull();
    const labelled = (author: string) => fact('issue.labelled', { repoKey: KEY, ref: { issue: 1, label: 'bug' }, payload: { author, labels: ['bug'] } });
    expect(matchingTrigger(t, labelled('alice'), trust)?.kind).toBe('issue.labelled');
    expect(matchingTrigger(t, labelled('mallory'), trust)).toBeNull();
  });

  it('an untrusted author\'s issue wakes no bot but stays a fact', () => {
    const h = harness([bot('bot-00000001', 'triage')]);
    h.engine.start();
    h.emit(fact('issue.opened', { repoKey: KEY, ref: { issue: 5 }, payload: { author: 'mallory', labels: [] } }));
    expect(h.enqueued).toEqual([]);
    h.emit(fact('issue.opened', { repoKey: KEY, ref: { issue: 6 }, payload: { author: 'alice', labels: [] } }));
    expect(h.enqueued.map((w) => w.botId)).toEqual(['bot-00000001']);
  });

  it('labelsAny tests the added label first, else the fact labels', () => {
    const t = bot('bot-00000001', 'triage');
    expect(matchingTrigger(t, fact('issue.labelled', { repoKey: KEY, ref: { issue: 1, label: 'Bug' }, payload: { author: 'alice', labels: ['bug'] } }), trust)?.kind).toBe('issue.labelled');
    expect(matchingTrigger(t, fact('issue.labelled', { repoKey: KEY, ref: { issue: 1, label: 'docs' }, payload: { author: 'alice', labels: ['bug', 'docs'] } }), trust)).toBeNull();
    expect(filterMatches({ labelsAny: ['bug'] }, fact('pr.opened', { payload: { labels: ['BUG'] } }), t, trust)).toBe(true);
    expect(filterMatches({ labelsAny: ['bug'] }, fact('pr.opened', { payload: {} }), t, trust)).toBe(false);
  });

  it('repo scope: repo facts reach only the bots on that repo; filter.repoKey narrows further', () => {
    const t = bot('bot-00000001', 'triage');
    expect(botSeesFact(t, fact('issue.opened', { repoKey: 'github.com/acme/other' }))).toBe(false);
    expect(botSeesFact(t, fact('issue.opened', { repoKey: 'Acme/App' }))).toBe(true);
    expect(botSeesFact(bot('bot-00000002', 'triage', { repo: undefined }), fact('issue.opened', { repoKey: KEY }))).toBe(false);
    expect(filterMatches({ repoKey: 'github.com/acme/other' }, fact('issue.opened', { repoKey: KEY }), t, trust)).toBe(false);
    expect(filterMatches({ repoKey: KEY }, fact('issue.opened', { repoKey: KEY }), t, trust)).toBe(true);
  });

  it('a bot.notice is seen by its addressee only', () => {
    const a = bot('bot-00000001', 'lead');
    const b = bot('bot-00000002', 'lead');
    const notice = fact('bot.notice', { workspaceId: a.workspaceId, ref: { botId: a.id, messageId: 'k' } });
    expect(botSeesFact(a, notice)).toBe(true);
    expect(botSeesFact(b, notice)).toBe(false);
  });

  it('workspace scope, directed facts and the HQ exception', () => {
    const lead = bot('bot-00000001', 'lead');
    const moa = bot('bot-00000009', 'moa', { workspaceId: 'hq', repo: undefined });
    expect(botSeesFact(lead, fact('task.done', { workspaceId: 'ws-2' }))).toBe(false);
    expect(botSeesFact(lead, fact('task.done', { workspaceId: 'ws-1' }))).toBe(true);
    expect(botSeesFact(lead, fact('handoff.received', { workspaceId: 'ws-1', ref: { botId: 'bot-00000002' } }))).toBe(false);
    expect(botSeesFact(moa, fact('handoff.received', { workspaceId: 'ws-1', ref: { botId: 'bot-00000009' } }))).toBe(true);
    expect(botSeesFact(moa, fact('bot.budget_exhausted', { workspaceId: 'ws-1', ref: { botId: 'bot-00000001' } }))).toBe(true);
    expect(botSeesFact(moa, fact('task.done', { workspaceId: 'ws-1' }))).toBe(false);
    // The repo watch's watch_cap refusal carries a repo and a workspace: HQ still sees it.
    expect(botSeesFact(moa, fact('bot.refused', { workspaceId: 'ws-1', repoKey: KEY, ref: { botId: 'bot-00000001', method: 'repo.watch' } }))).toBe(true);
    expect(botSeesFact(moa, fact('issue.opened', { repoKey: KEY }))).toBe(false);
    expect(botSeesFact(lead, fact('bot.budget_exhausted', { workspaceId: 'ws-2' }))).toBe(false);
  });

  it('priority: human 0, handoff / verdict / merge 1, other facts 2', () => {
    expect(wakePriority('human.message')).toBe(0);
    expect(wakePriority('handoff.received')).toBe(1);
    expect(wakePriority('verdict.recorded')).toBe(1);
    expect(wakePriority('merge.done')).toBe(1);
    expect(wakePriority('pr.opened')).toBe(2);
  });
});

describe('TriggerEngine', () => {
  it('enqueues one facts wake per matching bot, carrying the trigger and its batch config', () => {
    const v = bot('bot-00000001', 'verifier');
    const triage = bot('bot-00000002', 'triage');
    const off = bot('bot-00000003', 'verifier', { enabled: false });
    const h = harness([v, triage, off]);
    h.engine.start();
    const f = fact('pr.head_moved', { repoKey: KEY, ref: { pr: 1, headSha: 'h2' }, payload: { author: 'alice' } });
    h.emit(f);
    expect(h.enqueued).toEqual([{
      botId: 'bot-00000001', workspaceId: 'ws-1', priority: 2,
      reason: { kind: 'facts', factIds: [f.id], trigger: { kind: 'pr.head_moved', filter: { authorTrusted: true }, batch: { windowMs: 20_000, max: 5 } } },
      // Pinned to the PR's room thread.
      threadId: `pr:${KEY}#1`,
    }]);
    h.engine.dispose();
    h.emit(fact('pr.opened', { repoKey: KEY, payload: { author: 'alice' } }));
    expect(h.enqueued).toHaveLength(1);
  });

  it('one wake per bot even when two of its triggers match', () => {
    const lead = bot('bot-00000001', 'lead', { triggers: [{ kind: 'task.done' }, { kind: 'task.done', batch: { windowMs: 1, max: 1 } }] });
    const h = harness([lead]);
    expect(h.engine.route(fact('task.done', { workspaceId: 'ws-1', ref: { taskId: 't' } }))).toHaveLength(1);
    expect(h.enqueued[0].reason).toMatchObject({ trigger: { kind: 'task.done' } });
    expect(h.enqueued[0].threadId).toBe('task:t');
  });

  it('a fact with no thread of its own leaves the wake unpinned', () => {
    const moa = bot('bot-00000001', 'moa', { triggers: [{ kind: 'schedule.fired' }] });
    const h = harness([moa]);
    h.engine.route(fact('schedule.fired', { ref: { scheduleId: 'morning' } }));
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0].threadId).toBeUndefined();
  });

  it('a routine\'s schedule.fired wakes nobody here (its own wake was queued); the morning one still wakes its HQ bot', () => {
    const moa = bot('bot-00000001', 'moa', { triggers: [{ kind: 'schedule.fired' }] });
    const other = bot('bot-00000002', 'lead', { triggers: [{ kind: 'schedule.fired' }] });
    const h = harness([moa, other]);
    expect(h.engine.route(fact('schedule.fired', { workspaceId: 'ws-1', ref: { botId: moa.id, scheduleId: 'routine:r-abcdefgh12@5' } }))).toEqual([]);
    expect(isRoutineFact(fact('schedule.fired', { ref: { botId: moa.id, scheduleId: 'routine:r-x@1' } }))).toBe(true);
    expect(isRoutineFact(fact('schedule.fired', { ref: { scheduleId: 'routine:r-x@1' } }))).toBe(false);
    // The morning fact is directed to the HQ bot: it alone sees it.
    expect(h.engine.route(fact('schedule.fired', { ref: { botId: moa.id, scheduleId: 'morning' } })).map((w) => w.botId)).toEqual([moa.id]);
  });

  it('a delivered handoff wakes its addressee once: its handoff.received fact adds no facts wake', () => {
    const lead = bot('bot-00000001', 'lead', { triggers: [{ kind: 'handoff.received' }] });
    const h = harness([lead]);
    expect(h.engine.route(fact('handoff.received', { workspaceId: 'ws-1', ref: { handoffId: 'h-1', botId: lead.id } }))).toEqual([]);
    expect(h.enqueued).toEqual([]);
  });

  it('a throwing directory or queue never throws into the fact log', () => {
    const bad = new TriggerEngine({
      factLog: { append: () => null, subscribe: () => () => undefined, readSince: () => ({ facts: [], cursor: null }) },
      wakes: { enqueue: () => { throw new Error('full'); } },
      bots: { listEnabled: () => [bot('bot-00000001', 'lead')], get: () => null },
    }, () => undefined);
    expect(bad.route(fact('task.done', { workspaceId: 'ws-1' }))).toEqual([]);
    const noDir = new TriggerEngine({
      factLog: { append: () => null, subscribe: () => () => undefined, readSince: () => ({ facts: [], cursor: null }) },
      wakes: { enqueue: () => null },
      bots: { listEnabled: () => { throw new Error('io'); }, get: () => null },
    }, () => undefined);
    expect(noDir.route(fact('task.done'))).toEqual([]);
  });
});

describe('module seam', () => {
  let dir = '';
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-trigger-')); });
  afterEach(() => { setFactoryTriggerPorts(() => null); fs.rmSync(dir, { recursive: true, force: true }); });

  it('registers itself with the factory host', () => {
    expect(registeredFactoryModules()).toContain('triggerEngine');
  });

  it('no ports → start is a no-op (nothing subscribed, nothing polled)', async () => {
    expect(resolvePorts()).toBeNull();
    setFactoryTriggerPorts(() => ({ wakes: { enqueue: () => null } }));
    expect(resolvePorts()).toBeNull();
    setFactoryTriggerPorts(() => { throw new Error('not wired'); });
    expect(resolvePorts()).toBeNull();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const mod = createTriggerModule({ wmuxDir: () => dir });
    await mod.start();
    expect(mod.running).toEqual({ engine: null, watch: null });
    expect(fs.existsSync(path.join(dir, 'factory'))).toBe(false);
    info.mockRestore();
  });

  it('with ports → subscribes and watches the bots\' repos; dispose stops both', async () => {
    const subscribe = vi.fn(() => () => undefined);
    const graphql = vi.fn(async () => ({ ok: false as const, code: 'error' as const, message: 'offline' }));
    setFactoryTriggerPorts(() => ({
      factLog: { append: () => null, subscribe, readSince: () => ({ facts: [], cursor: null }) },
      wakes: { enqueue: () => null },
      bots: { listEnabled: () => [bot('bot-00000001', 'verifier')], get: () => null },
      graphql,
    }));
    const mod = createTriggerModule({ wmuxDir: () => dir });
    await mod.start();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(mod.running.watch?.watching()).toEqual([KEY]);
    await mod.dispose();
    expect(mod.running).toEqual({ engine: null, watch: null });
  });
});

describe('botSeesFact: the Coordinator reach follows the template', () => {
  it('a Coordinator-template bot sees bot-health facts of every workspace; the role tag alone does not', () => {
    const health = fact('bot.error', { workspaceId: 'ws-other', ref: { botId: 'bot-0000ffff' } });
    expect(botSeesFact(bot('bot-00000001', 'lead', { template: 'coordinator' }), health)).toBe(true);
    expect(botSeesFact(bot('bot-00000002', 'moa'), health)).toBe(true); // a Moa from before templates
    expect(botSeesFact(bot('bot-00000003', 'moa', { template: 'developer' }), health)).toBe(false);
    expect(botSeesFact(bot('bot-00000004', 'lead'), health)).toBe(false);
  });
});
