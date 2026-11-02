// expireUnanswerableDecisions (#2943): a decision a removed workspace brain
// raised has no card left to answer it and nothing left to consume it, so
// startup removes it and frees its thread for an ask_person question.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  expireUnanswerableDecisions,
  getDeckDecisionPath,
  hasPendingDecision,
  loadAllDeckDecisions,
  loadWorkspaceDecision,
  loadWorkspaceDecisions,
  onDecisionsChanged,
  raiseDecision,
  raiseThreadDecisionIfFree,
  resolveDecision,
  resolveThreadDecision,
} from '../deckDecisionStore';
import { GENERAL_THREAD } from '../../../shared/room';
import { atomicWriteJSON } from '../../../daemon/util/atomicWrite';

vi.mock('../../../daemon/util/atomicWrite', async (actual) => {
  const real = await actual<typeof import('../../../daemon/util/atomicWrite')>();
  return { ...real, atomicWriteJSON: vi.fn(real.atomicWriteJSON) };
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wmux-decision-expire-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('expireUnanswerableDecisions', () => {
  it('removes a brain-raised pending decision and leaves main-owned and other workspaces alone', async () => {
    const brain = await raiseDecision('ws-1', { question: 'Resume it, or drop it?', options: ['Resume', 'Drop'] }, dir);
    const ask = await raiseThreadDecisionIfFree('ws-1', 'task:t-1', { question: 'Which port?', origin: 'ask_person', handoffId: 'h-1' }, dir);
    await raiseThreadDecisionIfFree('ws-2', GENERAL_THREAD, { question: 'Deploy now?', origin: 'ask_person', handoffId: 'h-2' }, dir);
    const answered = await raiseThreadDecisionIfFree('ws-3', GENERAL_THREAD, { question: 'Done?', origin: 'ask_person', handoffId: 'h-3' }, dir);
    await resolveThreadDecision('ws-3', answered!.id, 'yes', {}, dir);
    const before = loadAllDeckDecisions(dir);

    const expired = await expireUnanswerableDecisions(dir);

    expect(expired).toEqual([{ workspaceId: 'ws-1', id: brain!.id, question: 'Resume it, or drop it?' }]);
    expect(hasPendingDecision('ws-1', dir)).toBe(false);
    expect(loadWorkspaceDecisions('ws-1', dir)).toEqual(before['ws-1'].filter((d) => d.id === ask!.id));
    expect(loadWorkspaceDecisions('ws-2', dir)).toEqual(before['ws-2']);
    expect(loadWorkspaceDecisions('ws-3', dir)).toEqual(before['ws-3']);
  });

  it('frees the general thread for an ask_person question', async () => {
    await raiseDecision('ws-1', { question: 'Resume it, or drop it?' }, dir);
    await expireUnanswerableDecisions(dir);
    const ask = await raiseThreadDecisionIfFree('ws-1', GENERAL_THREAD, { question: 'Merge it?', origin: 'ask_person', handoffId: 'h-1' }, dir);
    expect(ask).toMatchObject({ question: 'Merge it?', origin: 'ask_person', status: 'pending' });
  });

  it('removes a resolved brain decision nothing will consume, without listing it', async () => {
    const brain = await raiseDecision('ws-1', { question: 'Go?' }, dir);
    await resolveDecision('ws-1', brain!.id, 'yes', dir);
    expect(await expireUnanswerableDecisions(dir)).toEqual([]);
    expect(loadWorkspaceDecision('ws-1', dir)).toBeNull();
    expect(loadAllDeckDecisions(dir)).toEqual({});
  });

  it('expires a v1 file record (one object per workspace)', async () => {
    writeFileSync(getDeckDecisionPath(dir), JSON.stringify({
      'ws-1': { id: 'd-1', question: 'A request from before this wmux session is still on the books. Resume it, or drop it?', options: [], context: '', status: 'pending', raisedAt: 5 },
    }));
    const expired = await expireUnanswerableDecisions(dir);
    expect(expired.map((e) => e.id)).toEqual(['d-1']);
    expect(JSON.parse(readFileSync(getDeckDecisionPath(dir), 'utf8'))).toEqual({});
  });

  it('tells the listeners once when it removes something, and a second run changes nothing', async () => {
    await raiseDecision('ws-1', { question: 'Go?' }, dir);
    await raiseThreadDecisionIfFree('ws-2', GENERAL_THREAD, { question: 'Merge it?', origin: 'ask_person', handoffId: 'h-1' }, dir);
    let told = 0;
    const off = onDecisionsChanged(() => { told++; });
    try {
      expect(await expireUnanswerableDecisions(dir)).toHaveLength(1);
      expect(told).toBe(1);
      const after = readFileSync(getDeckDecisionPath(dir), 'utf8');
      expect(await expireUnanswerableDecisions(dir)).toEqual([]);
      expect(told).toBe(1);
      expect(readFileSync(getDeckDecisionPath(dir), 'utf8')).toBe(after);
    } finally {
      off();
    }
  });

  it('warns and returns nothing when the write fails', async () => {
    await raiseDecision('ws-1', { question: 'Go?' }, dir);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(atomicWriteJSON).mockRejectedValueOnce(new Error('disk full'));
    try {
      expect(await expireUnanswerableDecisions(dir)).toEqual([]);
      expect(warn.mock.calls.some(([line]) => String(line).includes('could not expire unanswerable decisions: Error: disk full'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('returns nothing for a missing or corrupt file', async () => {
    expect(await expireUnanswerableDecisions(dir)).toEqual([]);
    writeFileSync(getDeckDecisionPath(dir), '{not json');
    expect(await expireUnanswerableDecisions(dir)).toEqual([]);
  });
});
