// A skill's use: skill_read of its body counts in main's own record (never
// the skill folder), survives an update and a restart, and a record from
// before uses were counted still loads. Unused for 30 days, an approved
// skill is stale — a display hint only: it still loads.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }, BrowserWindow: class {} }));

import type { RpcContext } from '../../../shared/rpc';
import { SKILL_STALE_AFTER_MS, skillIsStale } from '../../../shared/botSkill';
import { BOT_SKILLS_FILENAME, BotSkillStore, botSkillsRoot } from '../botSkills';
import { registerSkillHandlers } from '../../pipe/handlers/skill.rpc';

const A = 'bot-0000000a';
const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_000_000_000_000;

const skillMd = (name: string, version = '1.0.0', body = 'Run the gate before you report.\n') =>
  `---\nname: ${name}\ndescription: How to report a task\nversion: ${version}\n---\n${body}`;

let dir = '';
let wmuxDir = '';
let clock = T0;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-skill-use-'));
  wmuxDir = path.join(dir, 'wmux');
  fs.mkdirSync(path.join(wmuxDir, 'factory', 'bots'), { recursive: true });
  clock = T0;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const recordFile = () => path.join(wmuxDir, 'factory', BOT_SKILLS_FILENAME);
const store = () => new BotSkillStore({ wmuxDir, now: () => clock });

function approve(s: BotSkillStore, name: string, content = skillMd(name), references?: unknown): void {
  const p = s.propose(A, { name, content, reason: 'the owner corrected my report', ...(references ? { references } : {}) });
  if (!p.ok) throw new Error(`refused: ${p.code} ${p.message}`);
  const r = s.approve(A, name, p.hash);
  if (!r.ok) throw new Error(`not approved: ${r.code} ${r.message}`);
}

function readRpc(s: BotSkillStore, events: string[] = []) {
  const handlers = new Map<string, (raw: unknown, ctx?: RpcContext) => Promise<unknown>>();
  registerSkillHandlers({ register: (m: string, h: (raw: unknown, ctx?: RpcContext) => Promise<unknown>) => { handlers.set(m, h); } } as never, {
    store: () => s, approvals: () => null, emit: (e) => events.push(`${e.type}:${'botId' in e ? e.botId : ''}`),
  });
  const ctx = { bot: { workspaceId: 'ws-1', botId: A, role: 'lead' } } as RpcContext;
  return (raw: unknown) => (handlers.get('skill.read') as (raw: unknown, ctx?: RpcContext) => Promise<Record<string, unknown>>)(raw, ctx);
}

const viewOf = (s: BotSkillStore, name: string) => s.list(A).find((x) => x.name === name);

describe('skill use', () => {
  it('skill_read of a body counts; the list, a reference and a skill that does not load do not', async () => {
    const s = store();
    approve(s, 'report', skillMd('report'), [{ name: 'notes.md', content: 'Gate tails.\n' }]);
    const read = readRpc(s);
    expect(viewOf(s, 'report')).not.toHaveProperty('useCount');

    clock = T0 + 5_000;
    expect(await read({ name: 'report' })).toMatchObject({ ok: true, name: 'report' });
    expect(await read({})).toMatchObject({ ok: true });
    expect(await read({ name: 'report', reference: 'notes.md' })).toMatchObject({ ok: true, content: 'Gate tails.\n' });
    expect(await read({ name: 'missing' })).toMatchObject({ ok: false });
    expect(viewOf(s, 'report')).toMatchObject({ useCount: 1, lastUsedAt: T0 + 5_000 });

    clock = T0 + 9_000;
    await read({ name: 'report' });
    expect(viewOf(s, 'report')).toMatchObject({ useCount: 2, lastUsedAt: T0 + 9_000 });
    // In main's record, never in the skill folder; a use is not an edit.
    const rec = JSON.parse(fs.readFileSync(recordFile(), 'utf8'));
    expect(rec.bots[A][0]).toMatchObject({ name: 'report', useCount: 2, lastUsedAt: T0 + 9_000, updatedAt: T0 });
    expect(fs.readdirSync(path.join(botSkillsRoot(wmuxDir, A), 'report')).sort()).toEqual(['SKILL.md', 'references']);
    expect(store().list(A)[0]).toMatchObject({ useCount: 2, lastUsedAt: T0 + 9_000 });
  });

  it('a recorded use tells the profile to re-read; a read that records nothing does not', async () => {
    const s = store();
    approve(s, 'report', skillMd('report'), [{ name: 'notes.md', content: 'Gate tails.\n' }]);
    const events: string[] = [];
    const read = readRpc(s, events);
    await read({});
    await read({ name: 'report', reference: 'notes.md' });
    await read({ name: 'missing' });
    expect(events).toEqual([]);
    await read({ name: 'report' });
    expect(events).toEqual([`skills-changed:${A}`]);
    // A use that cannot be recorded: no event, and the read still answers.
    const failing = new BotSkillStore({ wmuxDir, now: () => clock, writeRecord: () => { throw new Error('disk full'); } });
    const quiet: string[] = [];
    expect(await readRpc(failing, quiet)({ name: 'report' })).toMatchObject({ ok: true, name: 'report' });
    expect(quiet).toEqual([]);
  });

  it('a proposal waiting for the owner is never used: nothing is recorded', async () => {
    const s = store();
    s.propose(A, { name: 'report', content: skillMd('report'), reason: 'r' });
    expect(await readRpc(s)({ name: 'report' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(s.recordUse(A, 'report')).toBe(false);
    expect(viewOf(s, 'report')).not.toHaveProperty('useCount');
  });

  it('the count survives an update proposed and approved, and an archive', async () => {
    const s = store();
    approve(s, 'report');
    s.recordUse(A, 'report');
    clock = T0 + DAY;
    approve(s, 'report', skillMd('report', '1.1.0', 'Gate, then report.\n'));
    expect(viewOf(s, 'report')).toMatchObject({ version: '1.1.0', useCount: 1, lastUsedAt: T0 });
    s.archive(A, 'report');
    expect(viewOf(s, 'report')).toMatchObject({ state: 'archived', useCount: 1 });
  });

  it('a record written before uses were counted loads; a malformed use is dropped, never the skill', () => {
    approve(store(), 'report');
    approve(store(), 'triage');
    const rec = JSON.parse(fs.readFileSync(recordFile(), 'utf8'));
    expect(rec.bots[A][0]).not.toHaveProperty('useCount');
    rec.bots[A][1] = { ...rec.bots[A][1], useCount: -1, lastUsedAt: 'yesterday' };
    fs.writeFileSync(recordFile(), JSON.stringify(rec));
    const s = store();
    expect(s.index(A).map((x) => x.name)).toEqual(['report', 'triage']);
    for (const v of s.list(A)) {
      expect(v).not.toHaveProperty('useCount');
      expect(v).not.toHaveProperty('lastUsedAt');
    }
    expect(s.recordUse(A, 'triage')).toBe(true);
    expect(viewOf(s, 'triage')).toMatchObject({ useCount: 1 });
  });
});

describe('stale skills', () => {
  it('a new skill has 30 days of grace; unused at exactly 30 days it is stale, and still loads', async () => {
    const s = store();
    approve(s, 'report');
    clock = T0 + SKILL_STALE_AFTER_MS - 1;
    expect(viewOf(s, 'report')).not.toHaveProperty('stale');
    clock = T0 + SKILL_STALE_AFTER_MS;
    expect(viewOf(s, 'report')).toMatchObject({ stale: true });
    expect(s.index(A)).toEqual([{ name: 'report', description: 'How to report a task' }]);
    // Reading it is a use: no longer stale.
    expect(await readRpc(s)({ name: 'report' })).toMatchObject({ ok: true });
    expect(viewOf(s, 'report')).not.toHaveProperty('stale');
  });

  it('counts from the later of approval and last use; never for a proposal or an archived skill', () => {
    const approved = { state: 'approved' as const, approvedAt: T0 };
    expect(skillIsStale({ ...approved, lastUsedAt: T0 + 40 * DAY }, T0 + 69 * DAY)).toBe(false);
    expect(skillIsStale({ ...approved, lastUsedAt: T0 + 40 * DAY }, T0 + 70 * DAY)).toBe(true);
    // Used before an update was approved: the update gets its own grace.
    expect(skillIsStale({ state: 'approved', approvedAt: T0 + 50 * DAY, lastUsedAt: T0 }, T0 + 60 * DAY)).toBe(false);
    expect(skillIsStale({ state: 'proposed' }, T0 + 400 * DAY)).toBe(false);
    expect(skillIsStale({ state: 'archived', approvedAt: T0 }, T0 + 400 * DAY)).toBe(false);
  });
});
