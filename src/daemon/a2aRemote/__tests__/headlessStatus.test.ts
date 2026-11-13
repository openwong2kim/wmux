// The rate and reach of a headless worker's status (headlessStatus.ts): what
// goes to the asking PC, when, and what never does.
import { beforeEach, describe, expect, it } from 'vitest';
import type { A2aRemoteStatusV1 } from '../../../shared/a2aRemote';
import type { HeadlessTaskStatus } from '../headlessDelivery';
import { HeadlessStatusReporter, STATUS_CHANGES_MAX, STATUS_FLOOR_MS, type StatusLabels } from '../headlessStatus';

const TASK = 'rt-task-1';
let clock: number;
let peer: { connected: boolean; takesStatus: boolean; epoch: string | null } | null;
let sent: Array<{ taskId: string; status: A2aRemoteStatusV1 }>;
let sendError: string | null;
let labels: StatusLabels;
let logs: string[];

function reporter(): HeadlessStatusReporter {
  return new HeadlessStatusReporter({
    peer: () => peer,
    send: (taskId, status) => {
      if (sendError) return { ok: false, error: sendError };
      sent.push({ taskId, status });
      return { ok: true };
    },
    labels: () => labels,
    log: (_level, msg) => { logs.push(msg); },
    now: () => clock,
  });
}
const at = (kind: HeadlessTaskStatus['kind'], detail?: HeadlessTaskStatus['detail']): HeadlessTaskStatus[] => [{ taskId: TASK, kind, ...(detail ? { detail } : {}) }];

beforeEach(() => {
  clock = Date.UTC(2026, 10, 13, 6, 0);
  peer = { connected: true, takesStatus: true, epoch: 'e1' };
  sent = [];
  sendError = null;
  labels = 'send';
  logs = [];
});

describe('a headless worker\'s status to the asking PC', () => {
  it('one per change: the same status again is not sent, and keeps its since', () => {
    const r = reporter();
    r.tick(at('working'));
    clock += 60_000;
    r.tick(at('working'));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.status).toEqual({ kind: 'working', since: new Date(Date.UTC(2026, 10, 13, 6, 0)).toISOString() });
    r.tick(at('waiting-input'));
    expect(sent.map((s) => s.status.kind)).toEqual(['working', 'waiting-input']);
  });

  it('a PC that does not take a status (an older build) gets nothing, ever', () => {
    peer = { connected: true, takesStatus: false, epoch: 'e1' };
    const r = reporter();
    for (const kind of ['working', 'question', 'usage-limit', 'waiting-input'] as const) {
      r.tick(at(kind));
      clock += STATUS_FLOOR_MS;
    }
    r.gone([TASK]);
    expect(sent).toEqual([]);
  });

  it('nothing is queued while the asking PC is away; the current status goes once when it is back', () => {
    const r = reporter();
    r.tick(at('working'));
    peer = { connected: false, takesStatus: true, epoch: null };
    clock += STATUS_FLOOR_MS;
    r.tick(at('question', { question: 'permission' }));
    clock += STATUS_FLOOR_MS;
    r.tick(at('working'));
    clock += STATUS_FLOOR_MS;
    r.tick(at('waiting-input'));
    expect(sent.map((s) => s.status.kind)).toEqual(['working']);
    peer = { connected: true, takesStatus: true, epoch: 'e2' };
    r.tick(at('waiting-input'));
    r.tick(at('waiting-input'));
    expect(sent.map((s) => s.status.kind)).toEqual(['working', 'waiting-input']);
    // A reconnect with nothing new: the current one again, once (a restarted desktop holds none).
    peer = { connected: true, takesStatus: true, epoch: 'e3' };
    r.tick(at('waiting-input'));
    r.tick(at('waiting-input'));
    expect(sent.map((s) => s.status.kind)).toEqual(['working', 'waiting-input', 'waiting-input']);
    expect(sent[2]!.status.since).toBe(sent[1]!.status.since);
  });

  it('a flapping screen: at most one change per floor, the newest one, and a cap per task', () => {
    const r = reporter();
    const times: number[] = [];
    const start = clock;
    for (let i = 0; i < 600; i++) {
      r.tick(at(i % 2 === 0 ? 'working' : 'question', i % 2 === 0 ? undefined : { question: 'dialog' }));
      if (sent.length > times.length) times.push(clock);
      clock += 1000;
    }
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(STATUS_FLOOR_MS);
    expect(sent.length).toBeLessThanOrEqual(Math.ceil(600_000 / STATUS_FLOOR_MS));
    // Over a longer flap the cap holds.
    for (let i = 0; i < 2000; i++) {
      r.tick(at(i % 2 === 0 ? 'working' : 'question', i % 2 === 0 ? undefined : { question: 'dialog' }));
      clock += 1000;
    }
    expect(sent).toHaveLength(STATUS_CHANGES_MAX);
    expect(logs.filter((l) => l.includes('status changes sent'))).toHaveLength(1);
    expect(clock - start).toBeGreaterThan(STATUS_CHANGES_MAX * STATUS_FLOOR_MS);
    // Past the cap, a usage limit and the agent going still go, at once.
    r.tick(at('usage-limit', { resetsAt: '2026-11-13T09:00:00.000Z', provider: 'claude' }));
    r.gone([TASK]);
    expect(sent.slice(-2).map((s) => s.status.kind)).toEqual(['usage-limit', 'gone']);
  });

  it('gone and usage-limit go at once, inside the floor', () => {
    const r = reporter();
    r.tick(at('working'));
    clock += 100;
    r.tick(at('usage-limit', { resetsAt: '2026-11-13T09:00:00.000Z', provider: 'claude' }));
    clock += 100;
    r.gone([TASK]);
    expect(sent.map((s) => s.status.kind)).toEqual(['working', 'usage-limit', 'gone']);
    expect(sent[1]!.status.detail).toEqual({ resetsAt: '2026-11-13T09:00:00.000Z', provider: 'claude' });
  });

  it('a change held by the floor goes once the floor passed, if it is still the status', () => {
    const r = reporter();
    r.tick(at('working'));
    clock += 1000;
    r.tick(at('waiting-input'));
    expect(sent).toHaveLength(1);
    clock += STATUS_FLOOR_MS;
    r.tick(at('waiting-input'));
    expect(sent.map((s) => s.status.kind)).toEqual(['working', 'waiting-input']);
  });

  it('a menu\'s labels go, or only how many, as this PC\'s setting says', () => {
    const detail = { question: 'menu' as const, menuId: 'toolu_01', options: ['Red', 'Blue'] };
    reporter().tick(at('question', detail));
    expect(sent[0]!.status.detail).toEqual(detail);
    labels = 'keep';
    sent = [];
    reporter().tick(at('question', detail));
    expect(sent[0]!.status.detail).toEqual({ question: 'menu', menuId: 'toolu_01', optionCount: 2 });
  });

  it('the setting at the moment a status leaves: a menu seen under send, then keep, then sent on reconnect, goes without its labels', () => {
    const r = reporter();
    r.tick(at('working'));
    peer = { connected: false, takesStatus: true, epoch: null };
    clock += STATUS_FLOOR_MS;
    r.tick(at('question', { question: 'menu', menuId: 'toolu_01', options: ['Red', 'Blue'] }));
    labels = 'keep';
    peer = { connected: true, takesStatus: true, epoch: 'e2' };
    r.tick(at(null));
    expect(sent.at(-1)!.status.detail).toEqual({ question: 'menu', menuId: 'toolu_01', optionCount: 2 });
    expect(JSON.stringify(sent)).not.toContain('Red');
  });

  it('nothing new (null) keeps the last status; a task no longer worked on is forgotten', () => {
    const r = reporter();
    r.tick(at('working'));
    clock += STATUS_FLOOR_MS;
    r.tick(at(null));
    expect(sent).toHaveLength(1);
    r.tick([]);
    clock += STATUS_FLOOR_MS;
    // Seen again after it was forgotten: a status of its own, a new since.
    r.tick(at('working'));
    expect(sent).toHaveLength(2);
    expect(sent[1]!.status.since).not.toBe(sent[0]!.status.since);
  });

  it('a task that ended is refused quietly; any other refusal is logged and tried again', () => {
    sendError = 'ended';
    const r = reporter();
    r.tick(at('working'));
    expect(logs).toEqual([]);
    sendError = 'unavailable: outbox full';
    r.tick(at('working'));
    expect(logs).toHaveLength(1);
    sendError = null;
    r.tick(at('working'));
    expect(sent.map((s) => s.status.kind)).toEqual(['working']);
  });
});
