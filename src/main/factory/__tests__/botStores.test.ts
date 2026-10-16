// The bot runtime's persisted stores: bots.json (profiles + usage), the wake
// queue (ordering, batching, caps, TTL, R8 restart), budget windows and the
// factory settings file.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotStore, botsFilePath, parseBotProfile } from '../botStore';
import { LEGACY_TRIAGE_TRIGGERS, defaultTriggers } from '../roleDefaults';
import { WakeQueue, sanitizeWakeReason, wakeQueuePath, WAKE_RECORD_MAX, WAKE_RECORD_RETAIN_MS, HUMAN_RETRY_WINDOW_MS, OVER_CAP_RESERVE, setWakeQueue, currentWakeId, currentWakeThread } from '../wakeQueue';
import {
  budgetLeft,
  checkTurn,
  checkWorkers,
  emptyUsage,
  nextTurnAllowedAt,
  recordTurn,
  recordWorkerEnd,
  recordWorkerStart,
  workerHoursDay,
  HOUR_MS,
  hourlyCap,
  turnsUsedDay,
  workerTimeAllowedAt,
} from '../budget';
import { FactorySettingsStore, factorySettingsPath, mergeFactorySettings, DEFAULT_FACTORY_SETTINGS } from '../factorySettings';
import { __resetBotHooksForTesting, onBotHook, type BotHookEvent } from '../botHooks';
import { DEFAULT_BOT_BUDGETS, IDENTITY_SPREAD } from '../../../shared/bot';
import { WAKE_LIMITS } from '../../../shared/wake';
import { BOTS_PLAN_CONSENT_VERSION } from '../../../shared/factorySettings';

let dir = '';
let clock = 1_000_000;
const now = (): number => clock;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp2-stores-'));
  clock = 1_000_000;
  __resetBotHooksForTesting();
});

const pendingFlush: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(pendingFlush.splice(0).map((f) => f().catch(() => undefined)));
  fs.rmSync(dir, { recursive: true, force: true });
});

function newStore(): BotStore {
  let n = 0;
  const s = new BotStore(botsFilePath(dir), { now, newId: () => `bot-0000000${n++}`, platform: 'darwin' });
  pendingFlush.push(() => s.flush());
  return s;
}

describe('BotStore', () => {
  it('keeps the owner\'s worker engine: set, cleared, validated on update and on read', async () => {
    const s = newStore();
    const r = s.create({ workspaceId: 'ws-1', name: 'Dev' });
    if (!r.ok) throw new Error('create');
    expect(r.bot.workerAgent).toBeUndefined();
    expect(s.update(r.bot.id, { workerAgent: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'low' } })).toMatchObject({ ok: true, bot: { workerAgent: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'low' } } });
    // Only an agent with a bot-worker guard; only a verified one; no unknown field.
    expect(s.update(r.bot.id, { workerAgent: { agent: 'grok' } })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(s.update(r.bot.id, { workerAgent: { agent: 'gemini' } })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(s.update(r.bot.id, { workerAgent: { agent: 'codex', unattended: true } })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(s.update(r.bot.id, { workerAgent: { agent: 'codex', model: '--yolo' } })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(s.get(r.bot.id)?.workerAgent).toEqual({ agent: 'codex', model: 'gpt-6.1-sol', effort: 'low' });
    expect(s.update(r.bot.id, { workerAgent: null })).toMatchObject({ ok: true });
    expect(s.get(r.bot.id)?.workerAgent).toBeUndefined();
    // A Windows host refuses codex workers at save, with the reason; claude stays.
    const win = new BotStore(botsFilePath(dir), { now, newId: () => 'bot-000000ff', platform: 'win32' });
    const w = win.create({ workspaceId: 'ws-1', name: 'Win' });
    if (!w.ok) throw new Error('create');
    expect(win.update(w.bot.id, { workerAgent: { agent: 'codex' } })).toMatchObject({ ok: false, code: 'invalid_argument', message: expect.stringMatching(/not available on Windows/) });
    expect(win.update(w.bot.id, { workerAgent: { agent: 'claude' } })).toMatchObject({ ok: true });
    // On read: a stored pick that no longer validates is dropped, the bot kept.
    const stored = { ...s.get(r.bot.id)!, workerAgent: { agent: 'grok' } };
    expect(parseBotProfile(stored)).toMatchObject({ id: r.bot.id });
    expect(parseBotProfile(stored)?.workerAgent).toBeUndefined();
    expect(parseBotProfile({ ...stored, workerAgent: { agent: 'codex' } })?.workerAgent).toEqual({ agent: 'codex' });
  });

  it('an old profile with no models loads unchanged (default brain, preset workers), stays version 1, and a stored model that fails the rule is dropped, the bot kept', async () => {
    fs.mkdirSync(path.dirname(botsFilePath(dir)), { recursive: true });
    const old = {
      version: 1, id: 'bot-0a0a0a21', workspaceId: 'ws-1', role: 'moa', template: 'coordinator', name: 'Coordinator', hue: 5,
      engine: { kind: 'claude-sdk' }, triggers: [], budget: DEFAULT_BOT_BUDGETS.moa, enabled: true, createdAt: 1, updatedAt: 1,
    };
    const pinned = { ...old, id: 'bot-0a0a0a22', role: 'lead', template: 'developer', name: 'Dev', hue: 2, engine: { kind: 'claude-sdk', model: 'claude-opus-5-5', effort: 'high' } };
    const bad = { ...old, id: 'bot-0a0a0a23', role: 'lead', template: 'developer', name: 'Bad', hue: 4, engine: { kind: 'claude-sdk', model: 'claude opus', effort: 'low' } };
    const variant = { ...old, id: 'bot-0a0a0a24', role: 'lead', template: 'developer', name: 'Long', hue: 3, engine: { kind: 'claude-sdk', model: 'sonnet[1m]' } };
    fs.writeFileSync(botsFilePath(dir), JSON.stringify({ version: 1, bots: [old, pinned, bad, variant] }));
    const s = newStore();
    s.load();
    // No template model is put on a stored coordinator: it stays on the default.
    expect(s.get(old.id)?.engine).toEqual({ kind: 'claude-sdk' });
    expect(s.get(old.id)?.workerAgent).toBeUndefined();
    expect(s.get(pinned.id)?.engine).toEqual({ kind: 'claude-sdk', model: 'claude-opus-5-5', effort: 'high' });
    expect(s.get(bad.id)?.engine).toEqual({ kind: 'claude-sdk', effort: 'low' });
    // A bot's own model may carry a variant suffix (an SDK option, not a shell word).
    expect(s.get(variant.id)?.engine).toEqual({ kind: 'claude-sdk', model: 'sonnet[1m]' });
    // Written back as it was read: version 1, the untouched profiles equal.
    await s.flush();
    const disk = JSON.parse(fs.readFileSync(botsFilePath(dir), 'utf8'));
    expect(disk.version).toBe(1);
    expect(disk.bots[0]).toEqual(old);
    expect(disk.bots[1]).toEqual(pinned);
  });

  it('a new bot starts on its template\'s models; an explicit engine or worker agent wins; Custom has none', () => {
    const s = newStore();
    const made = (input: Parameters<BotStore['create']>[0]) => {
      const r = s.create(input);
      if (!r.ok) throw new Error(r.message);
      return r.bot;
    };
    for (const template of ['coordinator', 'issue', 'researcher'] as const) {
      const b = made({ workspaceId: 'ws-1', template });
      expect(b.engine).toEqual({ kind: 'claude-sdk', model: 'haiku' });
      expect(b.workerAgent).toBeUndefined();
    }
    for (const template of ['developer', 'reviewer'] as const) {
      const b = made({ workspaceId: 'ws-1', template });
      expect(b.engine).toEqual({ kind: 'claude-sdk' });
      expect(b.workerAgent).toEqual({ agent: 'claude', model: 'opus' });
    }
    expect(made({ workspaceId: 'ws-1', template: 'custom' })).toMatchObject({ engine: { kind: 'claude-sdk' } });
    expect(made({ workspaceId: 'ws-1', template: 'custom' }).workerAgent).toBeUndefined();
    expect(made({ workspaceId: 'ws-1', template: 'coordinator', engine: { kind: 'claude-sdk', model: 'sonnet' } }).engine).toEqual({ kind: 'claude-sdk', model: 'sonnet' });
    expect(made({ workspaceId: 'ws-1', template: 'developer', workerAgent: { agent: 'codex', model: 'gpt-6.1-sol' } }).workerAgent).toEqual({ agent: 'codex', model: 'gpt-6.1-sol' });
    // A factory default engine that already names a model keeps it.
    const own = new BotStore(botsFilePath(dir), { now, newId: () => 'bot-000000ee', defaultEngine: () => ({ kind: 'claude-sdk', model: 'claude-sonnet-5-5' }) });
    const o = own.create({ workspaceId: 'ws-2', template: 'coordinator' });
    expect(o.ok && o.bot.engine).toEqual({ kind: 'claude-sdk', model: 'claude-sonnet-5-5' });
  });

  it('refuses a bot model or worker model that fan-out would refuse, on create and on update', () => {
    const s = newStore();
    for (const model of ['--dangerously-skip-permissions', 'claude opus', '-m', 'x'.repeat(65)]) {
      expect(s.create({ workspaceId: 'ws-1', engine: { kind: 'claude-sdk', model } })).toMatchObject({ ok: false, code: 'invalid_argument' });
      expect(s.create({ workspaceId: 'ws-1', workerAgent: { agent: 'claude', model } })).toMatchObject({ ok: false, code: 'invalid_argument' });
    }
    // An empty engine model is refused (absent means the default); for a
    // worker, fan-out reads '' as "no model given".
    expect(s.create({ workspaceId: 'ws-1', engine: { kind: 'claude-sdk', model: '' } })).toMatchObject({ ok: false, code: 'invalid_argument' });
    const r = s.create({ workspaceId: 'ws-1', name: 'Dev' });
    if (!r.ok) throw new Error('create');
    expect(s.update(r.bot.id, { engine: { kind: 'claude-sdk', model: '--yolo' } })).toMatchObject({ ok: false, code: 'invalid_argument', message: expect.stringMatching(/model id/) });
    expect(s.update(r.bot.id, { engine: { kind: 'claude-sdk', effort: 'turbo' } })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(s.update(r.bot.id, { engine: { kind: 'claude-sdk', model: 'claude-haiku-4-5-20251001', effort: 'low' } })).toMatchObject({ ok: true, bot: { engine: { kind: 'claude-sdk', model: 'claude-haiku-4-5-20251001', effort: 'low' } } });
    expect(s.update(r.bot.id, { workerAgent: { agent: 'claude', model: 'opus', effort: 'max' } })).toMatchObject({ ok: true, bot: { workerAgent: { agent: 'claude', model: 'opus', effort: 'max' } } });
    // The brain keeps a variant suffix; a worker's model lands on a shell line, so it does not.
    expect(s.update(r.bot.id, { engine: { kind: 'claude-sdk', model: 'sonnet[1m]' } })).toMatchObject({ ok: true, bot: { engine: { kind: 'claude-sdk', model: 'sonnet[1m]' } } });
    expect(s.update(r.bot.id, { workerAgent: { agent: 'claude', model: 'sonnet[1m]' } })).toMatchObject({ ok: false, code: 'invalid_argument' });
  });

  it('a usage-limit park keeps its until across a reload; only an error park carries one', async () => {
    const s = newStore();
    const r = s.create({ workspaceId: 'ws-1', name: 'Dev' });
    if (!r.ok) throw new Error('create');
    s.setParked(r.bot.id, { reason: 'error', at: 5, until: 99 });
    expect(s.get(r.bot.id)?.parked).toEqual({ reason: 'error', at: 5, until: 99 });
    await s.flush();
    const again = newStore();
    again.load();
    expect(again.get(r.bot.id)?.parked).toEqual({ reason: 'error', at: 5, until: 99 });
    again.setParked(r.bot.id, { reason: 'human', at: 6, until: 99 });
    expect(again.get(r.bot.id)?.parked).toEqual({ reason: 'human', at: 6 });
  });

  it('creates with role defaults; any number of bots of one role share a workspace', () => {
    const s = newStore();
    const r = s.create({ workspaceId: 'ws-1', role: 'verifier' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bot.name).toBe('Verifier');
    expect(r.bot.budget).toEqual(DEFAULT_BOT_BUDGETS.verifier);
    expect(r.bot.engine).toEqual({ kind: 'claude-sdk' });
    expect(r.bot.enabled).toBe(true);
    // No triggers given: the role's defaults; an explicit empty list stays empty.
    expect(r.bot.triggers).toEqual(defaultTriggers('verifier'));
    expect(r.bot.triggers.length).toBeGreaterThan(0);
    const quiet = s.create({ workspaceId: 'ws-3', role: 'verifier', triggers: [] });
    expect(quiet.ok && quiet.bot.triggers).toEqual([]);
    expect(r.bot.template).toBe('reviewer');
    expect(s.create({ workspaceId: 'ws-1', role: 'verifier' }).ok).toBe(true);
    expect(s.create({ workspaceId: 'ws-1', role: 'moa' }).ok).toBe(true);
    expect(s.create({ workspaceId: 'ws-2', role: 'moa' }).ok).toBe(true);
    expect(s.list({ workspaceId: 'ws-1' })).toHaveLength(3);
  });

  it('creates by template (the role follows), by name alone (custom), and keeps a job', () => {
    const s = newStore();
    expect(s.create({ workspaceId: 'ws-1', template: 'coordinator' })).toMatchObject({ ok: true, bot: { role: 'moa', template: 'coordinator', name: 'Coordinator' } });
    expect(s.create({ workspaceId: 'ws-1', name: 'Wmux Dev' })).toMatchObject({ ok: true, bot: { role: 'lead', template: 'custom', name: 'Wmux Dev' } });
    const j = s.create({ workspaceId: 'ws-1', template: 'issue', job: '  Find the root cause of each issue.\r\nFix it.  ' });
    expect(j).toMatchObject({ ok: true, bot: { role: 'triage', template: 'issue', name: 'Issue', job: 'Find the root cause of each issue.\nFix it.' } });
    expect(s.create({ workspaceId: 'ws-1', template: 'boss' })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(s.create({ workspaceId: 'ws-1', job: '' })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(s.create({ workspaceId: 'ws-1', job: 'a\u0007b' })).toMatchObject({ ok: false, code: 'invalid_argument' });
  });

  it('updates and clears a job and a template; setJob hands back the previous job', () => {
    const s = newStore();
    const r = s.create({ workspaceId: 'ws-1', name: 'Dev' });
    if (!r.ok) throw new Error('create');
    expect(s.update(r.bot.id, { job: 'Ship features.', template: 'developer' })).toMatchObject({ ok: true, bot: { job: 'Ship features.', template: 'developer', role: 'lead' } });
    expect(s.setJob(r.bot.id, 'Review PRs.')).toMatchObject({ ok: true, previous: 'Ship features.', bot: { job: 'Review PRs.' } });
    const cleared = s.setJob(r.bot.id, null);
    expect(cleared).toMatchObject({ ok: true, previous: 'Review PRs.' });
    expect(cleared.ok && cleared.bot.job).toBeUndefined();
    expect(s.update(r.bot.id, { template: 'wizard' })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(s.setJob(r.bot.id, 'x'.repeat(5000))).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(s.setJob('bot-ffffffff', 'x')).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('an hourly cap is optional: 0 is refused on write, null removes it, and a stored 0 reads as none', () => {
    const s = newStore();
    expect(s.create({ workspaceId: 'ws-1', role: 'lead', budget: { maxTurnsPerHour: 0 } })).toMatchObject({ ok: false, code: 'invalid_argument' });
    const r = s.create({ workspaceId: 'ws-1', role: 'lead', budget: { maxTurnsPerHour: 3 } });
    if (!r.ok) throw new Error('create');
    expect(r.bot.budget.maxTurnsPerHour).toBe(3);
    const u = s.update(r.bot.id, { budget: { maxTurnsPerHour: null } });
    expect(u.ok && u.bot.budget.maxTurnsPerHour).toBeUndefined();
    const stored = { version: 1, id: 'bot-0a0a0a0b', workspaceId: 'ws-1', role: 'lead', name: 'Lead', engine: { kind: 'claude-sdk' }, triggers: [], budget: { ...DEFAULT_BOT_BUDGETS.lead, maxTurnsPerHour: 0 }, enabled: true, createdAt: 1, updatedAt: 1 };
    expect(parseBotProfile(stored)?.budget.maxTurnsPerHour).toBeUndefined();
  });

  it('on load: a profile before templates gets its role\'s template and job-less, an old default hourly cap is dropped, an owner-set one kept; written back', async () => {
    fs.mkdirSync(path.dirname(botsFilePath(dir)), { recursive: true });
    const base = { version: 1, workspaceId: 'ws-1', name: 'Moa', engine: { kind: 'claude-sdk' }, triggers: [], enabled: true, createdAt: 1, updatedAt: 1 };
    const moa = { ...base, id: 'bot-0a0a0a11', role: 'moa', budget: { ...DEFAULT_BOT_BUDGETS.moa, maxTurnsPerHour: 12 } };
    const lead = { ...base, id: 'bot-0a0a0a12', role: 'lead', name: 'Lead', budget: { ...DEFAULT_BOT_BUDGETS.lead, maxTurnsPerHour: 3 }, job: 'a\u0000b' };
    fs.writeFileSync(botsFilePath(dir), JSON.stringify({ version: 1, bots: [moa, lead] }));
    const s = newStore();
    s.load();
    expect(s.get('bot-0a0a0a11')).toMatchObject({ template: 'coordinator', role: 'moa' });
    expect(s.get('bot-0a0a0a11')?.budget.maxTurnsPerHour).toBeUndefined();
    expect(s.get('bot-0a0a0a12')).toMatchObject({ template: 'developer', budget: { maxTurnsPerHour: 3 } });
    expect(s.get('bot-0a0a0a12')?.job).toBeUndefined();
    await s.flush();
    const disk = JSON.parse(fs.readFileSync(botsFilePath(dir), 'utf8'));
    expect(disk.version).toBe(1);
    expect(disk.bots.map((b: { template?: string }) => b.template)).toEqual(['coordinator', 'developer']);
    expect(disk.bots[0].budget.maxTurnsPerHour).toBeUndefined();
  });

  it('refuses malformed input fields instead of storing them', () => {
    const s = newStore();
    expect(s.create({ workspaceId: 'ws 1', role: 'lead' })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(s.create({ workspaceId: 'ws-1', role: 'merge' })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(s.create({ workspaceId: 'ws-1', role: 'lead', engine: { kind: 'acp', command: '' , args: [] } }).ok).toBe(false);
    expect(s.create({ workspaceId: 'ws-1', role: 'lead', budget: { maxTurnsPerHour: 10_000 } }).ok).toBe(false);
    expect(s.create({ workspaceId: 'ws-1', role: 'lead', repo: { repoKey: 'o/r', repoPath: 'relative' } }).ok).toBe(false);
    expect(s.create({ workspaceId: 'ws-1', role: 'lead', triggers: [{ kind: 'nope' }] }).ok).toBe(false);
  });

  it('update changes only updatable fields; identity is refused', () => {
    const s = newStore();
    const r = s.create({ workspaceId: 'ws-1', role: 'lead' });
    if (!r.ok) throw new Error('create');
    expect(s.update(r.bot.id, { role: 'moa' })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(s.update(r.bot.id, { workspaceId: 'ws-2' })).toMatchObject({ ok: false, code: 'invalid_argument' });
    const u = s.update(r.bot.id, { name: 'Boss', enabled: false, repo: { repoKey: 'o/r', repoPath: '/tmp/r' } });
    expect(u).toMatchObject({ ok: true, bot: { name: 'Boss', enabled: false, repo: { repoKey: 'github.com/o/r' } } });
    expect(s.listEnabled()).toEqual([]);
    expect(s.update('bot-ffffffff', { name: 'x' })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('takes owner/repo and host/owner/repo and stores the canonical key', () => {
    const s = newStore();
    const a = s.create({ workspaceId: 'ws-1', role: 'lead', repo: { repoKey: 'Acme/App', repoPath: '/tmp/r' } });
    expect(a).toMatchObject({ ok: true, bot: { repo: { repoKey: 'github.com/acme/app' } } });
    const b = s.create({ workspaceId: 'ws-2', role: 'lead', repo: { repoKey: 'GHE.corp/acme/app', repoPath: '/tmp/r' } });
    expect(b).toMatchObject({ ok: true, bot: { repo: { repoKey: 'ghe.corp/acme/app' } } });
    expect(s.create({ workspaceId: 'ws-5', role: 'lead', repo: { repoKey: 'GitLab.corp/g/sub/app', repoPath: '/tmp/r' } }))
      .toMatchObject({ ok: true, bot: { repo: { repoKey: 'gitlab.corp/g/sub/app' } } });
    for (const repoKey of ['app', 'h/a//c', 'a b/c']) {
      expect(s.create({ workspaceId: 'ws-3', role: 'lead', repo: { repoKey, repoPath: '/tmp/r' } }), repoKey).toMatchObject({ ok: false, code: 'invalid_argument' });
    }
    const t = s.create({ workspaceId: 'ws-3', role: 'lead', triggers: [{ kind: 'pr.opened', filter: { repoKey: 'Acme/App' } }] });
    expect(t).toMatchObject({ ok: true, bot: { triggers: [{ filter: { repoKey: 'github.com/acme/app' } }] } });
    expect(s.create({ workspaceId: 'ws-4', role: 'lead', triggers: [{ kind: 'pr.opened', filter: { repoKey: 'h/a//c' } }] }).ok).toBe(false);
  });

  it('a removed bot leaves a tombstone (name, role, its stored colour slot) that survives a reload', async () => {
    const s = newStore();
    const a = s.create({ workspaceId: 'ws-1', template: 'developer', name: 'Developer' });
    const b = s.create({ workspaceId: 'ws-1', name: 'Other' });
    if (!a.ok || !b.ok) throw new Error('create');
    expect([a.bot.hue, b.bot.hue]).toEqual([IDENTITY_SPREAD[0], IDENTITY_SPREAD[1]]);
    // The store's slot wins over the remover's.
    expect(s.remove(a.bot.id, { hue: 3 })).toBe(true);
    expect(s.remove(b.bot.id, { hue: 99 })).toBe(true);
    expect(s.remove(a.bot.id)).toBe(false);
    expect(s.get(a.bot.id)).toBeNull();
    expect(s.listRemoved()).toEqual([
      { id: a.bot.id, workspaceId: 'ws-1', role: 'lead', template: 'developer', name: 'Developer', hue: IDENTITY_SPREAD[0], removedAt: clock },
      { id: b.bot.id, workspaceId: 'ws-1', role: 'lead', template: 'custom', name: 'Other', hue: IDENTITY_SPREAD[1], removedAt: clock },
    ]);
    await s.flush();
    const t = newStore();
    t.load();
    expect(t.list()).toHaveLength(0);
    expect(t.listRemoved().map((r) => [r.name, r.hue])).toEqual([['Developer', IDENTITY_SPREAD[0]], ['Other', IDENTITY_SPREAD[1]]]);
  });

  it('identity slots: kept across a relaunch after a delete, a new bot takes the freed slot, rooms count apart', async () => {
    const s = newStore();
    const made = ['A', 'B', 'C'].map((name) => {
      const r = s.create({ workspaceId: 'ws-1', name });
      if (!r.ok) throw new Error('create');
      clock += 1;
      return r.bot;
    });
    expect(made.map((b) => b.hue)).toEqual(IDENTITY_SPREAD.slice(0, 3));
    expect(s.remove(made[0].id)).toBe(true);
    await s.flush();
    const t = newStore();
    t.load();
    // The survivors keep their characters after the relaunch.
    expect(t.list().map((b) => [b.name, b.hue])).toEqual([['B', IDENTITY_SPREAD[1]], ['C', IDENTITY_SPREAD[2]]]);
    // A new bot takes the removed bot's slot (the tombstone does not block it).
    const d = t.create({ workspaceId: 'ws-1', name: 'D' });
    const other = t.create({ workspaceId: 'ws-2', name: 'E' });
    if (!d.ok || !other.ok) throw new Error('create');
    expect(d.bot.hue).toBe(IDENTITY_SPREAD[0]);
    expect(other.bot.hue).toBe(IDENTITY_SPREAD[0]);
  });

  it('identity slots: a file from before slots gets them once, in creation order, written back', async () => {
    const base = { version: 1, role: 'lead', template: 'custom', engine: { kind: 'claude-sdk' }, triggers: [], budget: DEFAULT_BOT_BUDGETS.lead, enabled: true, updatedAt: 1 };
    fs.mkdirSync(path.dirname(botsFilePath(dir)), { recursive: true });
    fs.writeFileSync(botsFilePath(dir), JSON.stringify({
      version: 1,
      bots: [
        { ...base, id: 'bot-0a0a0a03', workspaceId: 'ws-1', name: 'Third', createdAt: 30 },
        { ...base, id: 'bot-0a0a0a01', workspaceId: 'ws-1', name: 'First', createdAt: 10 },
        { ...base, id: 'bot-0a0a0a02', workspaceId: 'ws-1', name: 'Second', createdAt: 20, hue: IDENTITY_SPREAD[0] },
      ],
    }));
    const s = newStore();
    s.load();
    expect(Object.fromEntries(s.list().map((b) => [b.name, b.hue]))).toEqual({ Second: IDENTITY_SPREAD[0], First: IDENTITY_SPREAD[1], Third: IDENTITY_SPREAD[2] });
    await s.flush();
    const onDisk = JSON.parse(fs.readFileSync(botsFilePath(dir), 'utf8')) as { bots: Array<{ name: string; hue?: number }> };
    expect(onDisk.bots.every((b) => b.hue !== undefined)).toBe(true);
  });

  it('persists profiles and usage, and refuses a file of another version', async () => {
    const s = newStore();
    const r = s.create({ workspaceId: 'ws-1', role: 'triage' });
    if (!r.ok) throw new Error('create');
    s.mutateUsage(r.bot.id, (u) => recordTurn(u, clock));
    await s.flush();
    const t = newStore();
    t.load();
    expect(t.get(r.bot.id)?.role).toBe('triage');
    expect(t.usageOf(r.bot.id).turns).toEqual([clock]);
    fs.writeFileSync(botsFilePath(dir), JSON.stringify({ version: 2, bots: [] }));
    expect(() => newStore().load()).toThrow(/version/);
  });

  it('moves a triage bot on the old default triggers to the current defaults on load; edited triggers stay', async () => {
    fs.mkdirSync(path.dirname(botsFilePath(dir)), { recursive: true });
    const base = { version: 1, workspaceId: 'ws-1', role: 'triage', name: 'Triage', engine: { kind: 'claude-sdk' }, budget: DEFAULT_BOT_BUDGETS.triage, enabled: true, createdAt: 1, updatedAt: 1 };
    const legacy = { ...base, id: 'bot-0a0a0a01', triggers: LEGACY_TRIAGE_TRIGGERS };
    const custom = { ...base, id: 'bot-0a0a0a02', workspaceId: 'ws-2', triggers: [{ kind: 'issue.opened' }] };
    const lead = { ...base, id: 'bot-0a0a0a03', role: 'lead', name: 'Lead', triggers: LEGACY_TRIAGE_TRIGGERS };
    fs.writeFileSync(botsFilePath(dir), JSON.stringify({ version: 1, bots: [legacy, custom, lead] }));
    const s = newStore();
    s.load();
    expect(s.get('bot-0a0a0a01')?.triggers).toEqual(defaultTriggers('triage'));
    expect(s.get('bot-0a0a0a01')?.triggers.every((t) => t.filter?.authorTrusted === true)).toBe(true);
    expect(s.get('bot-0a0a0a02')?.triggers).toEqual([{ kind: 'issue.opened' }]);
    expect(s.get('bot-0a0a0a03')?.triggers).toEqual(LEGACY_TRIAGE_TRIGGERS);
    expect(s.migratedTriageBots()).toEqual(['bot-0a0a0a01']);
    // Issue wakes queued under the old triggers never run; others are kept.
    const q = new WakeQueue(wakeQueuePath(dir), { now });
    pendingFlush.push(() => q.flush());
    const oldWake = q.enqueue({ botId: 'bot-0a0a0a01', workspaceId: 'ws-1', reason: { kind: 'facts', factIds: ['f1'], trigger: { kind: 'issue.opened' } }, priority: 2 });
    const trusted = q.enqueue({ botId: 'bot-0a0a0a01', workspaceId: 'ws-1', reason: { kind: 'facts', factIds: ['f2'], trigger: { kind: 'issue.opened', filter: { authorTrusted: true } } }, priority: 2 });
    const human = q.enqueue({ botId: 'bot-0a0a0a01', workspaceId: 'ws-1', reason: { kind: 'human', text: 'hi', source: 'desktop' }, priority: 0 });
    expect(q.dropUnfilteredIssueWakes('bot-0a0a0a01')).toBe(1);
    expect(q.get(oldWake?.id ?? '')).toMatchObject({ state: 'dropped', dropped: { code: 'expired' } });
    expect(q.get(trusted?.id ?? '')?.state).toBe('queued');
    expect(q.get(human?.id ?? '')?.state).toBe('queued');
    // Written back, and a second load leaves the new defaults alone.
    await s.flush();
    const t = newStore();
    t.load();
    expect(t.get('bot-0a0a0a01')?.triggers).toEqual(defaultTriggers('triage'));
    expect(JSON.parse(fs.readFileSync(botsFilePath(dir), 'utf8')).bots[0].triggers).toEqual(defaultTriggers('triage'));
  });

  it('a cap the owner saved after templates survives a reload, even at an old default; an unknown template is Custom', async () => {
    const s = newStore();
    const r = s.create({ workspaceId: 'ws-1', role: 'verifier', budget: { maxTurnsPerHour: 12 } });
    if (!r.ok) throw new Error('create');
    await s.flush();
    const t = newStore();
    t.load();
    expect(t.get(r.bot.id)?.budget.maxTurnsPerHour).toBe(12);
    const bad = { version: 1, id: 'bot-0a0a0a21', workspaceId: 'ws-1', role: 'moa', template: 'overlord', name: 'Moa', engine: { kind: 'claude-sdk' }, triggers: [], budget: DEFAULT_BOT_BUDGETS.moa, enabled: true, createdAt: 1, updatedAt: 1 };
    expect(parseBotProfile(bad)?.template).toBe('custom');
  });

  it('drops a malformed profile on load and keeps the rest', () => {
    fs.mkdirSync(path.dirname(botsFilePath(dir)), { recursive: true });
    const good = { version: 1, id: 'bot-0a0a0a0a', workspaceId: 'ws-1', role: 'lead', name: 'Lead', engine: { kind: 'claude-sdk' }, triggers: [], budget: DEFAULT_BOT_BUDGETS.lead, enabled: true, createdAt: 1, updatedAt: 1 };
    fs.writeFileSync(botsFilePath(dir), JSON.stringify({ version: 1, bots: [good, { ...good, id: 'nope' }] }));
    const s = newStore();
    s.load();
    expect(s.list().map((b) => b.id)).toEqual(['bot-0a0a0a0a']);
    expect(parseBotProfile({ ...good, role: 'merge' })).toBeNull();
  });
});

describe('budget windows', () => {
  const budget = { ...DEFAULT_BOT_BUDGETS.maintainer, maxTurnsPerHour: 2 }; // 2/hour, 4/day, 1 worker, 1 worker-hour

  it('without an hourly cap only the day counts, and turnsHour reads null', () => {
    const open = { ...DEFAULT_BOT_BUDGETS.maintainer }; // 4/day, no hourly cap
    expect(open.maxTurnsPerHour).toBeUndefined();
    const u = emptyUsage();
    for (let i = 0; i < 3; i++) recordTurn(u, i);
    expect(checkTurn(open, u, 5)).toEqual({ ok: true });
    expect(nextTurnAllowedAt(open, u, 5)).toBe(5);
    expect(budgetLeft(open, u, 5)).toMatchObject({ turnsHour: null, turnsDay: 1 });
    recordTurn(u, 4);
    expect(checkTurn(open, u, 5)).toEqual({ ok: false, reason: 'turns_day' });
  });

  it('workerTimeAllowedAt: now under the cap, else when enough of the last day\'s worker time leaves it', () => {
    const u = emptyUsage(); // cap: 1 worker-hour a day
    recordWorkerStart(u, 'a', 0);
    recordWorkerEnd(u, 'a', 30 * 60_000);
    expect(workerTimeAllowedAt(budget, u, HOUR_MS)).toBe(HOUR_MS);
    recordWorkerStart(u, 'b', HOUR_MS);
    recordWorkerEnd(u, 'b', 2 * HOUR_MS);
    const now = 3 * HOUR_MS;
    // 1.5 h used: under the cap once the first run and the start of the
    // second have left the day.
    const at = workerTimeAllowedAt(budget, u, now);
    expect(Math.abs(at - 25 * HOUR_MS)).toBeLessThanOrEqual(1_000);
    expect(checkWorkers(budget, u, 0, 1, at).ok).toBe(true);
    expect(checkWorkers(budget, u, 0, 1, at - 2_000).ok).toBe(false);
    expect(workerTimeAllowedAt({ ...budget, maxWorkerHoursPerDay: 0 }, u, now)).toBe(Infinity);
  });

  it('nextTurnAllowedAt: now when a turn is allowed, else when the window that refuses frees one', () => {
    const u = emptyUsage();
    expect(nextTurnAllowedAt(budget, u, 100)).toBe(100);
    recordTurn(u, 10);
    expect(nextTurnAllowedAt(budget, u, 100)).toBe(100);
    recordTurn(u, 20);
    // Hour full: free when the older of the two leaves the hour.
    expect(nextTurnAllowedAt(budget, u, 100)).toBe(10 + HOUR_MS);
    expect(checkTurn(budget, u, 10 + HOUR_MS).ok).toBe(true);
    expect(checkTurn(budget, u, 10 + HOUR_MS - 1).ok).toBe(false);
    // Day full (4): free when the oldest leaves the day, later than the hour.
    recordTurn(u, 2 * HOUR_MS);
    recordTurn(u, 3 * HOUR_MS);
    const at = 3 * HOUR_MS + 5;
    expect(nextTurnAllowedAt(budget, u, at)).toBe(10 + 24 * HOUR_MS);
    expect(checkTurn(budget, u, 10 + 24 * HOUR_MS).ok).toBe(true);
    // A day cap of 0 never frees by itself; an hourly 0 is no hourly cap.
    expect(nextTurnAllowedAt({ ...budget, maxTurnsPerDay: 0 }, emptyUsage(), 5)).toBe(Infinity);
    expect(nextTurnAllowedAt({ ...budget, maxTurnsPerHour: 0 }, emptyUsage(), 5)).toBe(5);
  });

  it('no hourly cap: absent or a stored 0 never refuses by the hour, and turnsHour reads null', () => {
    const u = emptyUsage();
    for (let i = 0; i < 4; i++) recordTurn(u, 10 + i);
    for (const b of [{ ...budget, maxTurnsPerHour: undefined }, { ...budget, maxTurnsPerHour: 0 }]) {
      expect(hourlyCap(b)).toBeNull();
      expect(checkTurn(b, u, 20)).toEqual({ ok: false, reason: 'turns_day' });
      expect(budgetLeft(b, u, 20).turnsHour).toBeNull();
    }
    expect(checkTurn({ ...budget, maxTurnsPerHour: undefined, maxTurnsPerDay: 10 }, u, 20).ok).toBe(true);
    expect(turnsUsedDay(u, 20)).toBe(4);
    expect(turnsUsedDay(u, 12 + 24 * HOUR_MS)).toBe(1);
  });

  it('refuses turns over the hourly then the daily window, and clears as it slides', () => {
    const u = emptyUsage();
    recordTurn(u, 0);
    recordTurn(u, 10);
    expect(checkTurn(budget, u, 20)).toEqual({ ok: false, reason: 'turns_hour' });
    expect(checkTurn(budget, u, HOUR_MS + 11).ok).toBe(true);
    recordTurn(u, HOUR_MS + 11);
    recordTurn(u, HOUR_MS + 12);
    expect(checkTurn(budget, u, 3 * HOUR_MS)).toEqual({ ok: false, reason: 'turns_day' });
    expect(budgetLeft(budget, u, 3 * HOUR_MS)).toMatchObject({ turnsHour: 2, turnsDay: 0 });
  });

  it('counts concurrent workers and worker-hours inside the day', () => {
    const u = emptyUsage();
    expect(checkWorkers(budget, u, 1, 1, 0)).toEqual({ ok: false, reason: 'concurrent_workers' });
    recordWorkerStart(u, 't1', 0);
    expect(recordWorkerEnd(u, 't1', HOUR_MS)).toBe(true);
    expect(recordWorkerEnd(u, 't1', HOUR_MS)).toBe(false);
    expect(workerHoursDay(u, HOUR_MS)).toBe(1);
    expect(checkWorkers(budget, u, 0, 1, HOUR_MS)).toEqual({ ok: false, reason: 'worker_hours_day' });
    expect(checkWorkers(budget, u, 0, 1, 26 * HOUR_MS).ok).toBe(true);
  });

  it('an end recorded before the start leaves no interval that never ends', () => {
    const u = emptyUsage();
    expect(recordWorkerEnd(u, 't1', HOUR_MS)).toBe(false);
    recordWorkerStart(u, 't1', 2 * HOUR_MS);
    expect(u.workers.filter((w) => w.endedAt === undefined)).toHaveLength(0);
    expect(workerHoursDay(u, 10 * HOUR_MS)).toBe(0);
  });

  it('a resumed worker opens a new interval after its earlier one ended, never two at once', () => {
    const u = emptyUsage();
    recordWorkerStart(u, 't1', 0);
    recordWorkerEnd(u, 't1', HOUR_MS);
    recordWorkerStart(u, 't1', 2 * HOUR_MS);
    expect(u.workers).toHaveLength(1);
    recordWorkerStart(u, 't1', 2 * HOUR_MS, { resumed: true });
    recordWorkerStart(u, 't1', 2 * HOUR_MS, { resumed: true });
    expect(u.workers).toHaveLength(2);
    expect(recordWorkerEnd(u, 't1', 3 * HOUR_MS)).toBe(true);
    expect(workerHoursDay(u, 3 * HOUR_MS)).toBe(2);
  });
});

describe('WakeQueue', () => {
  const trigger = { kind: 'pr.opened' as const, batch: { windowMs: 20_000, max: 3 } };
  let n = 0;
  const newQueue = (opts: { isBotEnabled?: (id: string) => boolean } = {}): WakeQueue => {
    const q = new WakeQueue(wakeQueuePath(dir), { now, newId: () => `w-${n++}`, ...opts });
    pendingFlush.push(() => q.flush());
    return q;
  };

  it('orders by priority then age, holding batched facts until their window closes', () => {
    const q = newQueue();
    const facts = q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'facts', factIds: ['f1'], trigger }, priority: 2 });
    clock += 1;
    q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'handoff', handoffId: 'h-1' }, priority: 1 });
    clock += 1;
    const human = q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'human', text: 'hi', source: 'desktop' }, priority: 0 });
    expect(q.next('bot-1')?.id).toBe(human?.id);
    q.start(human!.id);
    q.finish(human!.id);
    expect(q.next('bot-1')?.reason.kind).toBe('handoff');
    q.drop(q.next('bot-1')!.id, 'duplicate');
    expect(q.next('bot-1')).toBeNull(); // the facts item is held
    expect(q.nextHeldAt('bot-1')).toBe(facts!.notBefore);
    clock = facts!.notBefore!;
    expect(q.next('bot-1')?.id).toBe(facts?.id);
  });

  it('merges facts of one trigger up to the batch max and drops repeats as duplicates', () => {
    const q = newQueue();
    const a = q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'facts', factIds: ['f1'], trigger }, priority: 2 });
    const b = q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'facts', factIds: ['f2', 'f3'], trigger }, priority: 2 });
    expect(b?.id).toBe(a?.id);
    expect(b?.reason).toMatchObject({ factIds: ['f1', 'f2', 'f3'] });
    const c = q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'facts', factIds: ['f4'], trigger }, priority: 2 });
    expect(c?.id).not.toBe(a?.id); // over max: a new item
    expect(q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'facts', factIds: ['f2'], trigger }, priority: 2 })).toBeNull();
    expect(q.list({ botId: 'bot-1', states: ['dropped'] })[0].dropped).toEqual({ code: 'duplicate' });
  });

  it('keeps the routine, mention and intro reasons across a reload, deduped by their keys', async () => {
    const q = newQueue();
    const intro = q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'intro' }, priority: 0 });
    expect(q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'intro' }, priority: 0 })?.id).toBe(intro?.id);
    const routine = { kind: 'routine' as const, routineId: 'r-abcdefgh', dueAt: 42 };
    const r1 = q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: routine, priority: 1 });
    expect(q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { ...routine }, priority: 1 })?.id).toBe(r1?.id);
    const mention = { kind: 'mention' as const, cardId: 'c-1', handoffId: 'h-9', fromBotId: 'bot-0a1b2c3d' };
    q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: mention, priority: 1 });
    await q.flush();
    const again = newQueue();
    again.load();
    expect(again.list({ botId: 'bot-1' }).map((i) => i.reason).sort((a, b) => a.kind.localeCompare(b.kind)))
      .toEqual([{ kind: 'intro' }, mention, routine]);
  });

  it('an owner message keeps its run and room flag; a malformed one is dropped', () => {
    const base = { kind: 'human', text: 'Hi', source: 'desktop', clientMessageId: 'cm-1' };
    expect(sanitizeWakeReason({ ...base, runId: 'run-c-1', room: true })).toEqual({ ...base, runId: 'run-c-1', room: true });
    expect(sanitizeWakeReason(base)).toEqual(base);
    expect(sanitizeWakeReason({ ...base, runId: 'x'.repeat(201) })).toBeNull();
    expect(sanitizeWakeReason({ ...base, runId: 5 })).toBeNull();
    expect(sanitizeWakeReason({ ...base, room: false })).toBeNull();
    expect(sanitizeWakeReason({ ...base, lead: true })).toEqual({ ...base, lead: true });
    expect(sanitizeWakeReason({ ...base, lead: 'yes' })).toBeNull();
  });

  it('a routine wake that waited past the fact TTL is dropped expired, like facts', () => {
    const q = newQueue();
    const item = q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'routine', routineId: 'r-abcdefgh', dueAt: 1 }, priority: 2 });
    clock += WAKE_LIMITS.FACT_TTL_MS + 1;
    expect(q.next('bot-1')).toBeNull();
    expect(q.get(item?.id ?? '')).toMatchObject({ state: 'dropped', dropped: { code: 'expired' } });
  });

  it('drops a malformed routine or mention reason on read', () => {
    expect(sanitizeWakeReason({ kind: 'routine', routineId: 'r-1' })).toBeNull();
    expect(sanitizeWakeReason({ kind: 'mention', cardId: 'c', handoffId: 'h', fromBotId: 'moa' })).toBeNull();
    expect(sanitizeWakeReason({ kind: 'intro', extra: 1 })).toEqual({ kind: 'intro' });
  });

  it('caps the per-bot queue and refuses disabled bots, recording why', () => {
    const q = newQueue({ isBotEnabled: (id) => id !== 'bot-off' });
    for (let i = 0; i < WAKE_LIMITS.PER_BOT_QUEUE_CAP; i++) {
      expect(q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'manual', by: 'human' }, priority: 1 })).not.toBeNull();
    }
    expect(q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'manual', by: 'human' }, priority: 1 })).toBeNull();
    expect(q.enqueue({ botId: 'bot-off', workspaceId: 'ws', reason: { kind: 'manual', by: 'human' }, priority: 1 })).toBeNull();
    const codes = q.list({ states: ['dropped'] }).map((i) => i.dropped?.code).sort();
    expect(codes).toEqual(['bot_disabled', 'queue_full']);
  });

  it('a keyed wake (handoff id, human clientMessageId) is queued once and a repeat returns that item', () => {
    const q = newQueue();
    const h = q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'handoff', handoffId: 'h-1' }, priority: 1 });
    expect(q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'handoff', handoffId: 'h-1' }, priority: 1 })?.id).toBe(h?.id);
    // Finished: still the same wake, never a second turn.
    q.start(h!.id);
    q.finish(h!.id);
    expect(q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'handoff', handoffId: 'h-1' }, priority: 1 })).toMatchObject({ id: h?.id, state: 'done' });
    const m = q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'human', text: 'hi', source: 'phone', clientMessageId: 'cm-1' }, priority: 0 });
    expect(q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'human', text: 'hi', source: 'phone', clientMessageId: 'cm-1' }, priority: 0 })?.id).toBe(m?.id);
    expect(q.list({ botId: 'bot-1' })).toHaveLength(2);
    // Another bot's handoff of the same id is its own wake.
    expect(q.enqueue({ botId: 'bot-2', workspaceId: 'ws', reason: { kind: 'handoff', handoffId: 'h-1' }, priority: 1 })?.id).not.toBe(h?.id);
  });

  it('a dropped keyed wake does not block a later one of the same key', () => {
    const q = newQueue();
    for (let i = 0; i < WAKE_LIMITS.PER_BOT_QUEUE_CAP; i++) q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'manual', by: 'human' }, priority: 1 });
    const human = { botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'human' as const, text: 'hi', source: 'desktop' as const, clientMessageId: 'cm-9' }, priority: 0 as const };
    expect(q.enqueue(human)).toBeNull();
    q.drop(q.next('bot-1')!.id, 'expired');
    expect(q.enqueue(human)).toMatchObject({ state: 'queued' });
  });

  it('an overCap wake goes past the cap by at most its kind\'s reserve; other wakes do not', () => {
    const q = newQueue();
    for (let i = 0; i < WAKE_LIMITS.PER_BOT_QUEUE_CAP; i++) q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'manual', by: 'human' }, priority: 1 });
    expect(q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'human', text: 'x', source: 'desktop' }, priority: 0 })).toBeNull();
    expect(q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'manual', by: 'human' }, priority: 1, overCap: true })).toBeNull();
    for (let i = 0; i < OVER_CAP_RESERVE.human!; i++) {
      expect(q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'human', text: `m${i}`, source: 'desktop' }, priority: 0, overCap: true })).not.toBeNull();
    }
    expect(q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'human', text: 'one more', source: 'desktop' }, priority: 0, overCap: true })).toBeNull();
    // Answers have their own, larger reserve.
    let answers = 0;
    while (q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'handoff', handoffId: `h-${answers}` }, priority: 1, overCap: true })) answers++;
    expect(WAKE_LIMITS.PER_BOT_QUEUE_CAP + OVER_CAP_RESERVE.human! + answers).toBe(WAKE_LIMITS.PER_BOT_QUEUE_CAP + OVER_CAP_RESERVE.handoff!);
    expect(q.depth('bot-1')).toBe(WAKE_LIMITS.PER_BOT_QUEUE_CAP + OVER_CAP_RESERVE.handoff!);
  });

  it('expires facts wakes past the TTL but never a human message', () => {
    const q = newQueue();
    const f = q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'facts', factIds: ['f1'], trigger: { kind: 'ci.failed' } }, priority: 2 });
    const h = q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'human', text: 'later', source: 'phone' }, priority: 0 });
    clock += WAKE_LIMITS.FACT_TTL_MS + 1;
    expect(q.next('bot-1')?.id).toBe(h?.id);
    expect(q.get(f!.id)?.dropped).toEqual({ code: 'expired' });
  });

  it('R8: a running item becomes interrupted on restart, is not replayed, and emits a hook', async () => {
    const hooks: BotHookEvent[] = [];
    onBotHook((e) => hooks.push(e));
    const q = newQueue();
    const item = q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'manual', by: 'human' }, priority: 1, threadId: 'task:long' });
    q.start(item!.id);
    const queued = q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'handoff', handoffId: 'h-2' }, priority: 1 });
    await q.flush();
    const r = newQueue();
    const interrupted = r.load();
    expect(interrupted.map((i) => i.id)).toEqual([item!.id]);
    expect(r.get(item!.id)?.state).toBe('interrupted');
    expect(r.next('bot-1')?.id).toBe(queued?.id);
    // The hook names the wake's thread, so its card lands there.
    expect(hooks).toEqual([{ type: 'wake.interrupted', botId: 'bot-1', workspaceId: 'ws', wakeId: item!.id, threadId: 'task:long', at: clock }]);
  });

  it('carries the thread: facts merge only within one thread, and it persists', async () => {
    const q = newQueue();
    const a = q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'facts', factIds: ['f1'], trigger }, priority: 2, threadId: 'pr:o/r#1' });
    const b = q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'facts', factIds: ['f2'], trigger }, priority: 2, threadId: 'pr:o/r#2' });
    // Another spelling of the same PR thread merges too.
    const c = q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'facts', factIds: ['f3'], trigger }, priority: 2, threadId: 'pr:O/R#1' as never });
    expect(b?.id).not.toBe(a?.id);
    expect(c?.id).toBe(a?.id);
    const bad = q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'manual', by: 'human' }, priority: 1, threadId: 'nope' as never });
    expect(bad?.threadId).toBeUndefined();
    await q.flush();
    const r = newQueue();
    r.load();
    expect(r.get(a!.id)?.threadId).toBe('pr:github.com/o/r#1');
  });

  it('exposes the running wake id and thread of a bot', () => {
    const q = newQueue();
    setWakeQueue(q);
    try {
      const item = q.enqueue({ botId: 'bot-1', workspaceId: 'ws', reason: { kind: 'human', text: 'hi', source: 'desktop' }, priority: 0, threadId: 'task:wtask-1' });
      expect(currentWakeId('bot-1')).toBeNull();
      q.start(item!.id);
      expect(currentWakeId('bot-1')).toBe(item!.id);
      expect(currentWakeThread('bot-1')).toBe('task:wtask-1');
      q.finish(item!.id);
      expect(currentWakeThread('bot-1')).toBeNull();
    } finally {
      setWakeQueue(null);
    }
  });

  it('a taken human message keeps its record past the count cap for the retry window, so a retry finds it; then it counts', () => {
    const q = newQueue();
    const human = { botId: 'bot-h', workspaceId: 'ws', reason: { kind: 'human' as const, text: 'hi', source: 'phone' as const, clientMessageId: 'cm-old' }, priority: 0 as const };
    const first = q.enqueue(human)!;
    q.start(first.id);
    q.finish(first.id);
    for (let i = 0; i < WAKE_RECORD_MAX + 10; i++) {
      q.enqueue({ botId: `bot-${i}`, workspaceId: 'ws', reason: { kind: 'manual', by: 'human' }, priority: 1 });
      const it = q.next(`bot-${i}`)!;
      q.start(it.id);
      q.finish(it.id);
    }
    expect(q.enqueue(human)?.id).toBe(first.id);
    // Past the retry window the full count cap prunes it, the oldest record.
    clock += HUMAN_RETRY_WINDOW_MS + 1;
    q.enqueue({ botId: 'bot-x', workspaceId: 'ws', reason: { kind: 'manual', by: 'human' }, priority: 1 });
    expect(q.get(first.id)).toBeNull();
  });

  it('prunes finished records past the cap', () => {
    const q = newQueue();
    for (let i = 0; i < WAKE_RECORD_MAX + 10; i++) {
      q.enqueue({ botId: `bot-${i}`, workspaceId: 'ws', reason: { kind: 'manual', by: 'human' }, priority: 1 });
      const it = q.next(`bot-${i}`)!;
      q.start(it.id);
      q.finish(it.id);
    }
    expect(q.list().length).toBe(WAKE_RECORD_MAX);
  });
});

describe('factory settings', () => {
  it('defaults to off and keeps only well-formed fields', async () => {
    const s = new FactorySettingsStore(factorySettingsPath(dir));
    expect(s.load()).toMatchObject({ enabled: false, verifierOnOwnerPrs: true, globalConcurrentBots: 3 });
    const next = await s.update({ enabled: true, planConsent: { version: 1, at: '2026-10-15T00:00:00.000Z' }, globalConcurrentBots: 9, trustedAuthors: ['owner', 'bad login'], morning: { hour: 7, weekdays: [5, 1, 9] } });
    expect(next).toMatchObject({ enabled: true, globalConcurrentBots: 3, trustedAuthors: ['owner'], morning: { hour: 7, weekdays: [1, 5] } });
    const t = new FactorySettingsStore(factorySettingsPath(dir));
    expect(t.load().enabled).toBe(true);
    expect(mergeFactorySettings({ ...DEFAULT_FACTORY_SETTINGS, trustedAuthors: [], morning: { hour: 9, weekdays: [] } }, { defaultEngine: { kind: 'acp', command: 'hermes', args: ['acp'] } }).defaultEngine)
      .toEqual({ kind: 'acp', command: 'hermes', args: ['acp'] });
  });

  it('turning bots on needs the plan consent: refused without it, taken with it (main\'s time), and bots on from before it stay on', async () => {
    const s = new FactorySettingsStore(factorySettingsPath(dir));
    s.load();
    await expect(s.update({ enabled: true })).rejects.toThrow('turn bots on in the wmux app first');
    expect(s.get()).toMatchObject({ enabled: false });
    expect(s.get().planConsent).toBeUndefined();
    const before = Date.now();
    const on = await s.update({ enabled: true, planConsent: { version: BOTS_PLAN_CONSENT_VERSION, at: '2000-01-01T00:00:00.000Z' } });
    expect(on).toMatchObject({ enabled: true, planConsent: { version: BOTS_PLAN_CONSENT_VERSION } });
    expect(Date.parse(on.planConsent!.at)).toBeGreaterThanOrEqual(before);
    // A settings file from before the consent: the bots stay on and other changes still apply.
    fs.writeFileSync(factorySettingsPath(dir), JSON.stringify({ version: 1, enabled: true }));
    const legacy = new FactorySettingsStore(factorySettingsPath(dir));
    expect(legacy.load()).toMatchObject({ enabled: true });
    expect(legacy.get().planConsent).toBeUndefined();
    await expect(legacy.update({ laneDailyCap: 3 })).resolves.toMatchObject({ enabled: true, laneDailyCap: 3 });
  });
});
