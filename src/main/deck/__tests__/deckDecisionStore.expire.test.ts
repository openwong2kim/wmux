// expireUnanswerableDecisions (#2943): a pending decision a removed workspace
// brain raised has no card left to answer it, so startup expires it in the
// shape an operator dismissal is stored with.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  EXPIRED_RESOLUTION,
  expireUnanswerableDecisions,
  getDeckDecisionPath,
  hasPendingDecision,
  loadAllDeckDecisions,
  loadWorkspaceDecisions,
  onDecisionsChanged,
  raiseDecision,
  raiseThreadDecisionIfFree,
  resolveThreadDecision,
} from '../deckDecisionStore';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wmux-decision-expire-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('expireUnanswerableDecisions', () => {
  it('expires a brain-raised pending decision and leaves main-owned, resolved and other cards alone', async () => {
    const brain = await raiseDecision('ws-1', { question: 'Resume it, or drop it?', options: ['Resume', 'Drop'] }, dir);
    const ask = await raiseThreadDecisionIfFree('ws-1', 'task:t-1', { question: 'Which port?', origin: 'ask_person', handoffId: 'h-1' }, dir);
    const otherAsk = await raiseThreadDecisionIfFree('ws-2', 'general', { question: 'Deploy now?', origin: 'ask_person', handoffId: 'h-2' }, dir);
    const answered = await raiseThreadDecisionIfFree('ws-3', 'general', { question: 'Done?', origin: 'ask_person', handoffId: 'h-3' }, dir);
    await resolveThreadDecision('ws-3', answered!.id, 'yes', {}, dir);
    const before = loadAllDeckDecisions(dir);

    const expired = await expireUnanswerableDecisions(dir);

    expect(expired).toEqual([{ workspaceId: 'ws-1', id: brain!.id, question: 'Resume it, or drop it?' }]);
    const ws1 = loadWorkspaceDecisions('ws-1', dir);
    const gone = ws1.find((d) => d.id === brain!.id);
    expect(gone).toMatchObject({
      status: 'resolved',
      resolution: EXPIRED_RESOLUTION,
      resolvedBy: 'human',
      dismissed: true,
      options: ['Resume', 'Drop'],
    });
    expect(typeof gone?.resolvedAt).toBe('number');
    expect(hasPendingDecision('ws-1', dir)).toBe(false);
    expect(ws1.find((d) => d.id === ask!.id)).toEqual(before['ws-1'].find((d) => d.id === ask!.id));
    expect(loadWorkspaceDecisions('ws-2', dir)).toEqual(before['ws-2']);
    expect(loadWorkspaceDecisions('ws-3', dir)).toEqual(before['ws-3']);
    expect(otherAsk?.status).toBe('pending');
  });

  it('expires a v1 file record (one object per workspace)', async () => {
    writeFileSync(getDeckDecisionPath(dir), JSON.stringify({
      'ws-1': { id: 'd-1', question: 'A request from before this wmux session is still on the books. Resume it, or drop it?', options: [], context: '', status: 'pending', raisedAt: 5 },
    }));
    const expired = await expireUnanswerableDecisions(dir);
    expect(expired.map((e) => e.id)).toEqual(['d-1']);
    const raw = JSON.parse(readFileSync(getDeckDecisionPath(dir), 'utf8')) as Record<string, unknown[]>;
    expect(raw['ws-1'][0]).toMatchObject({ id: 'd-1', status: 'resolved', dismissed: true, resolution: EXPIRED_RESOLUTION });
  });

  it('tells the listeners once when it expires something, and a second run changes nothing', async () => {
    await raiseDecision('ws-1', { question: 'Go?' }, dir);
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

  it('returns nothing for a missing or corrupt file', async () => {
    expect(await expireUnanswerableDecisions(dir)).toEqual([]);
    writeFileSync(getDeckDecisionPath(dir), '{not json');
    expect(await expireUnanswerableDecisions(dir)).toEqual([]);
  });
});
