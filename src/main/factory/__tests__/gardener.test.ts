// The gardener: three or more similar corrections wake Moa once with them in
// a gardener thread; an approved gardener proposal goes to a maintainer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_BOT_BUDGETS, type BotProfile, type BotRole } from '../../../shared/bot';
import type { Fact, FactDraft } from '../../../shared/facts';
import type { RoomCard } from '../../../shared/room';
import { createFactLog } from '../factLog';
import { correctionGroups, correctionKey, Gardener, GARDENER_FILENAME, GARDENER_THREAD_PREFIX } from '../gardener';
import { deliberateSleep } from '../../../test-utils/waitFor';

const NOW = Date.parse('2026-10-12T09:00:00Z');

function bot(id: string, role: BotRole, workspaceId: string, createdAt = 1): BotProfile {
  return {
    version: 1, id, workspaceId, role, name: role, engine: { kind: 'claude-sdk' }, triggers: [], budget: { ...DEFAULT_BOT_BUDGETS[role] },
    enabled: true, createdAt, updatedAt: 1,
  };
}

const MOA = bot('bot-00000001', 'moa', 'ws-hq');
const LEAD = bot('bot-00000002', 'lead', 'ws-a');
const MAINT_A = bot('bot-00000003', 'maintainer', 'ws-a', 5);
const MAINT_HQ = bot('bot-00000004', 'maintainer', 'ws-hq', 2);
const ALL = [MOA, LEAD, MAINT_A, MAINT_HQ];
const directory = (bots: BotProfile[] = ALL) => ({ listEnabled: () => bots.filter((b) => b.enabled), get: (id: string) => bots.find((b) => b.id === id) ?? null });

let n = 0;
function correction(over: { category?: string; botId?: string; note?: string; at?: number } = {}): FactDraft {
  n += 1;
  return {
    kind: 'human.correction', at: over.at ?? NOW - 1000, workspaceId: 'ws-a', actor: { kind: 'human' },
    ref: { botId: over.botId ?? LEAD.id, messageId: `m-${n}` },
    payload: { ...(over.category ? { category: over.category } : {}), ...(over.note ? { note: over.note } : {}) },
  };
}

function rig(bots: BotProfile[] = ALL) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp6-gardener-'));
  const log = createFactLog(path.join(dir, 'factory'), { now: () => NOW });
  log.start();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the wake input as the assertions read it
  const wake = vi.fn<(input: any) => unknown>(() => ({ id: 'w-1' }));
  const note = vi.fn();
  const reopen = vi.fn();
  const g = new Gardener({ factLog: () => log, bots: () => directory(bots), wake, note, reopen, factoryDir: path.join(dir, 'factory'), now: () => NOW });
  return { dir, log, wake, note, reopen, g };
}

describe('gardener grouping', () => {
  it('keys a correction by the corrected bot\'s role and the category', () => {
    const f = { id: 'f', seq: 1, dedupeKey: 'k', ...correction({ category: 'Missing-Test' }) } as Fact;
    expect(correctionKey(f, directory())).toBe('lead:missing-test');
    const bare = { id: 'g', seq: 2, dedupeKey: 'k2', ...correction() } as Fact;
    expect(correctionKey(bare, directory())).toBe('lead:unspecified');
    expect(correctionKey({ ...bare, kind: 'human.message' } as Fact, directory())).toBeNull();
  });

  it('only groups at the threshold', () => {
    const facts = [1, 2, 3].map((i) => ({ id: `f${i}`, seq: i, dedupeKey: `k${i}`, ...correction({ category: 'scope-creep', note: `n${i}` }) }) as Fact)
      .concat([{ id: 'x', seq: 9, dedupeKey: 'x', ...correction({ category: 'other' }) } as Fact]);
    expect(correctionGroups(facts, directory())).toEqual([
      { key: 'lead:scope-creep', factIds: ['f1', 'f2', 'f3'], workspaceIds: ['ws-a'], notes: ['n1', 'n2', 'n3'] },
    ]);
  });
});

describe('gardener wakes', () => {
  it('three similar corrections wake Moa once, in a gardener thread, with their fact ids; a fourth does not wake it again', () => {
    const r = rig();
    r.g.start();
    r.log.append(correction({ category: 'missing-test' }));
    r.log.append(correction({ category: 'missing-test' }));
    r.log.append(correction({ category: 'other' }));
    expect(r.wake).not.toHaveBeenCalled();
    const third = r.log.append(correction({ category: 'missing-test' }));
    expect(r.wake).toHaveBeenCalledTimes(1);
    const call = r.wake.mock.calls[0][0];
    expect(call).toMatchObject({ botId: MOA.id, workspaceId: 'ws-hq', priority: 2, reason: { kind: 'facts', trigger: { kind: 'human.correction' } } });
    expect(call.threadId.startsWith(GARDENER_THREAD_PREFIX)).toBe(true);
    expect(call.reason.factIds).toContain(third?.id);
    expect(call.reason.factIds).toHaveLength(3);
    r.log.append(correction({ category: 'missing-test' }));
    expect(r.wake).toHaveBeenCalledTimes(1);
  });

  it('a proposal survives a restart: the same pattern is not proposed again', async () => {
    const r = rig();
    r.g.start();
    for (let i = 0; i < 3; i++) r.log.append(correction({ category: 'missing-test' }));
    expect(r.wake).toHaveBeenCalledTimes(1);
    r.g.dispose();
    await vi.waitFor(() => expect(fs.existsSync(path.join(r.dir, 'factory', GARDENER_FILENAME))).toBe(true), { timeout: 10_000 });
    const again = new Gardener({ factLog: () => r.log, bots: () => directory(), wake: r.wake, factoryDir: path.join(r.dir, 'factory'), now: () => NOW });
    again.start();
    expect(r.wake).toHaveBeenCalledTimes(1);
  });

  it('a wake the queue dropped is not a proposal: the next correction tries again', () => {
    const r = rig();
    r.wake.mockReturnValueOnce(null);
    r.g.start();
    for (let i = 0; i < 3; i++) r.log.append(correction({ category: 'missing-test' }));
    expect(r.wake).toHaveBeenCalledTimes(1);
    r.log.append(correction({ category: 'missing-test' }));
    expect(r.wake).toHaveBeenCalledTimes(2);
    r.log.append(correction({ category: 'missing-test' }));
    expect(r.wake).toHaveBeenCalledTimes(2);
  });

  it('a saved file of another version stops the gardener and is kept as it was', async () => {
    const r = rig();
    const file = path.join(r.dir, 'factory', GARDENER_FILENAME);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 2, proposals: {} }));
    const log = vi.fn();
    const g = new Gardener({ factLog: () => r.log, bots: () => directory(), wake: r.wake, factoryDir: path.join(r.dir, 'factory'), now: () => NOW, log });
    g.start();
    for (let i = 0; i < 3; i++) r.log.append(correction({ category: 'missing-test' }));
    await deliberateSleep(20, 'negative: a newer file version keeps the gardener off');
    expect(r.wake).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(2);
    expect(log.mock.calls[0][0]).toMatch(/stays off/);
  });

  it('corrections older than the window do not count, and nothing wakes without an HQ bot', () => {
    const r = rig();
    r.g.start();
    for (let i = 0; i < 3; i++) r.log.append(correction({ category: 'old', at: NOW - 8 * 86_400_000 }));
    expect(r.wake).not.toHaveBeenCalled();
    const noHq = rig([LEAD, MAINT_A]);
    noHq.g.start();
    for (let i = 0; i < 3; i++) noHq.log.append(correction({ category: 'x' }));
    expect(noHq.wake).not.toHaveBeenCalled();
  });
});

describe('gardener — the owner\'s answer to a proposal', () => {
  function proposal(threadId: string, over: Partial<RoomCard> = {}): RoomCard {
    return {
      version: 1, id: 'c-9', seq: 4, workspaceId: 'ws-hq', threadId: threadId as RoomCard['threadId'], kind: 'proposal', at: 1,
      actor: { kind: 'bot', workspaceId: 'ws-hq', botId: MOA.id }, title: 'Add a lint rule for missing tests', body: 'Three corrections...', state: 'resolved', ...over,
    };
  }

  it('an approved gardener proposal goes to the maintainer of the corrected bots\' workspace, the proposal fenced as data', () => {
    const r = rig();
    r.g.start();
    for (let i = 0; i < 3; i++) r.log.append(correction({ category: 'missing-test' }));
    const thread = r.wake.mock.calls[0][0].threadId as string;
    r.wake.mockClear();
    expect(r.g.onCardResolved({ workspaceId: 'ws-hq', card: proposal(thread), resolution: 'approve' })).toBe('maintainer');
    const call = r.wake.mock.calls[0][0];
    expect(call).toMatchObject({ botId: MAINT_A.id, workspaceId: 'ws-a', priority: 0, threadId: thread, reason: { kind: 'human', source: 'desktop' } });
    expect(call.reason.text).toMatch(new RegExp(`^I approved this gardener proposal from ${MOA.name} \\(card c-9 in ws-hq\\): approve`));
    expect(call.reason.text).toMatch(/```proposal\nAdd a lint rule for missing tests/);
  });

  it('falls back to the Coordinator workspace\'s maintainer, else the Coordinator itself; says so when neither can take it', () => {
    const r = rig();
    const thread = `${GARDENER_THREAD_PREFIX}unknown-1`;
    expect(r.g.onCardResolved({ workspaceId: 'ws-hq', card: proposal(thread), resolution: 'yes' })).toBe('maintainer');
    expect(r.wake.mock.calls[0][0].botId).toBe(MAINT_HQ.id);
    // No maintainer: the Coordinator starts the guard-rail work itself.
    const self = rig([MOA, LEAD]);
    expect(self.g.onCardResolved({ workspaceId: 'ws-hq', card: proposal(thread), resolution: 'yes' })).toBe('maintainer');
    expect(self.wake.mock.calls[0][0].botId).toBe(MOA.id);
    const none = rig([{ ...MOA, enabled: false }, LEAD]);
    expect(none.g.onCardResolved({ workspaceId: 'ws-hq', card: proposal(thread), resolution: 'yes' })).toBe('no_maintainer');
    expect(none.note).toHaveBeenCalledWith('ws-hq', thread, 'No bot to take this proposal', expect.any(String));
    // Re-opened, so the owner can approve it again once a bot can take it.
    expect(none.reopen).toHaveBeenCalledWith('ws-hq', 'c-9');
    expect(none.wake).not.toHaveBeenCalled();
  });

  it('a declined proposal wakes nobody; an edit, or another proposal, goes back to its author', () => {
    const r = rig();
    const g = `${GARDENER_THREAD_PREFIX}x-1`;
    expect(r.g.onCardResolved({ workspaceId: 'ws-hq', card: proposal(g), resolution: 'decline' })).toBe('declined');
    expect(r.wake).not.toHaveBeenCalled();
    expect(r.g.onCardResolved({ workspaceId: 'ws-hq', card: proposal(g), resolution: 'make it a test instead' })).toBe('moa');
    expect(r.wake.mock.calls[0][0]).toMatchObject({ botId: MOA.id, threadId: g });
    expect(r.g.onCardResolved({ workspaceId: 'ws-hq', card: proposal('general'), resolution: 'approve' })).toBe('moa');
    expect(r.g.onCardResolved({ workspaceId: 'ws-hq', card: proposal('general', { kind: 'plan' }), resolution: 'approve' })).toBe('ignored');
    // Any bot's own proposal wakes it on an answer; a gardener thread is the Coordinator's alone.
    expect(r.g.onCardResolved({ workspaceId: 'ws-a', card: proposal('general', { actor: { kind: 'bot', workspaceId: 'ws-a', botId: LEAD.id } }), resolution: 'approve' })).toBe('moa');
    expect(r.wake.mock.calls.at(-1)?.[0]).toMatchObject({ botId: LEAD.id });
    expect(r.g.onCardResolved({ workspaceId: 'ws-a', card: proposal(g, { actor: { kind: 'bot', workspaceId: 'ws-a', botId: LEAD.id } }), resolution: 'approve' })).toBe('ignored');
  });
});
