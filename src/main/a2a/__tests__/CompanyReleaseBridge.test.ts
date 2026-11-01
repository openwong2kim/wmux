import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPANY_HOLD_KEY, companyHoldOf, type A2aCompanyMarkParams, type CompanyBlockerEnd, type CompanyHoldMarker } from '../../../shared/companyHold';
import type { Task } from '../../../shared/types';
import {
  COMPANY_BRIDGE_NO_AGENT_TRIES,
  COMPANY_BRIDGE_RETRY_MIN_MS,
  CompanyReleaseBridge,
  companyCeoEventsOf,
  type CompanyReleaseMark,
} from '../CompanyReleaseBridge';

function companyTask(id: string, marker: CompanyHoldMarker, over: { paneId?: string | null } = {}): Task {
  return {
    kind: 'task',
    id,
    status: { state: 'submitted', timestamp: '2026-11-01T00:00:00.000Z' },
    history: [{
      kind: 'message',
      messageId: `m-${id}`,
      role: 'user',
      parts: [
        { kind: 'text', text: `build ${id}` },
        { kind: 'data', data: { kind: 'wmux.company.brief', v: 1, goal: 'g', scope: 's', acceptance: 'a', verify: 'v', report: 'r', blockedBy: marker.blockedBy } },
      ],
    }],
    artifacts: [],
    metadata: {
      title: id,
      from: { workspaceId: 'ws-co', name: 'Co', paneId: 'pane-ceo' },
      to: { workspaceId: 'ws-co', name: 'Co', ...(over.paneId === null ? {} : { paneId: over.paneId ?? 'pane-dev' }) },
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      [COMPANY_HOLD_KEY]: marker,
    },
  };
}

const released = (over: Partial<CompanyHoldMarker> = {}): CompanyHoldMarker => ({ blockedBy: ['task-a'], waitingOn: [], releasedAt: 'r', ...over });

/** The daemon side: its records, the two lists and company.mark, as A2aTaskService answers them. */
class FakeDaemon {
  tasks = new Map<string, Task>();
  /** Every mark taken, in order. */
  marks: A2aCompanyMarkParams[] = [];
  /** Marks to throw on (daemon unreachable), counted down. */
  failMarks = 0;
  /** Refuse the next attempted:true mark. */
  refuseAttempt = false;
  constructor(private readonly events: string[]) {}
  private marker(t: Task): CompanyHoldMarker {
    return companyHoldOf(t)!;
  }
  async a2aCompanyPending(): Promise<unknown> {
    return {
      tasks: [...this.tasks.values()].filter((t) => {
        const m = this.marker(t);
        return m.waitingOn.length === 0 && !m.delivered && !m.held;
      }).map((t) => structuredClone(t)),
    };
  }
  async a2aCompanyHeld(): Promise<unknown> {
    return {
      tasks: [...this.tasks.values()].filter((t) => {
        const m = this.marker(t);
        return m.waitingOn.length > 0 || (!m.delivered && !!m.held);
      }).map((t) => structuredClone(t)),
    };
  }
  async a2aCompanyMark(params: A2aCompanyMarkParams): Promise<unknown> {
    if (this.failMarks > 0) {
      this.failMarks -= 1;
      throw new Error('pipe closed');
    }
    if ('attempted' in params && params.attempted && this.refuseAttempt) {
      this.refuseAttempt = false;
      return { ok: false, error: 'a2a.company.mark: daemon log append failed (uncommitted)' };
    }
    const m = this.marker(this.tasks.get(params.taskId)!);
    this.marks.push(params);
    if ('attempted' in params) {
      this.events.push(`attempted:${params.attempted}`);
      if (!m.delivered && !m.held) {
        if (params.attempted) m.attempted = true;
        else delete m.attempted;
      }
    } else if ('delivered' in params) {
      this.events.push('delivered');
      m.delivered = true;
      if (params.ptyId) m.ptyId = params.ptyId;
    } else {
      this.events.push(`held:${params.held}`);
      if (!m.delivered) m.held = params.held;
    }
    return { ok: true, task: structuredClone(this.tasks.get(params.taskId)) };
  }
}

let events: string[];
let daemon: FakeDaemon;
let clock: number;
let deliverAnswers: unknown[];
let ceoAnswers: unknown[];
let renderer: ReturnType<typeof vi.fn<(method: string, params: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<unknown>>>;

function bridge(told?: Set<string>): CompanyReleaseBridge {
  return new CompanyReleaseBridge({ daemon, sendToRenderer: renderer, now: () => clock, ...(told ? { told } : {}) });
}

async function pull(b: CompanyReleaseBridge): Promise<void> {
  await b.trigger();
  await b.whenIdle();
}

const writes = () => renderer.mock.calls.filter((c) => c[0] === 'a2a.company.deliver');
const ceoLines = () => renderer.mock.calls.filter((c) => c[0] === 'a2a.company.ceoLine').map((c) => c[1] as Record<string, unknown>);
const marksOf = (taskId: string) => daemon.marks.filter((m) => m.taskId === taskId)
  .map((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'taskId')));

beforeEach(() => {
  events = [];
  daemon = new FakeDaemon(events);
  clock = 1_000_000;
  deliverAnswers = [];
  ceoAnswers = [];
  renderer = vi.fn(async (method: string) => {
    if (method === 'a2a.company.deliver') {
      events.push('write');
      const next = deliverAnswers.shift() ?? { ok: true, delivered: true, ptyId: 'pty-dev' };
      if (next instanceof Error) throw next;
      return next;
    }
    if (method === 'a2a.company.ceoLine') return ceoAnswers.shift() ?? { ok: true, delivered: true, ptyId: 'pty-ceo' };
    throw new Error(`unexpected ${method}`);
  });
});

describe('CompanyReleaseBridge — delivery of a released task', () => {
  it('records the attempt before the write and the delivery after it, with the pty', async () => {
    daemon.tasks.set('task-c', companyTask('task-c', released()));
    await pull(bridge());
    expect(events).toEqual(['attempted:true', 'write', 'delivered']);
    expect(marksOf('task-c')).toEqual([{ attempted: true }, { delivered: true, ptyId: 'pty-dev' }]);
    const [, params, opts] = writes()[0];
    expect((params as { task: Task }).task.id).toBe('task-c');
    expect(typeof (params as { deliveryDeadlineAt: number }).deliveryDeadlineAt).toBe('number');
    expect(opts).toEqual({ timeoutMs: expect.any(Number) });
    await pull(bridge());
    expect(writes()).toHaveLength(1);
  });

  it('pulls when told a task ended, and delivers what that released', async () => {
    daemon.tasks.set('task-c', companyTask('task-c', { blockedBy: ['task-a'], waitingOn: ['task-a'] }));
    const b = bridge();
    await pull(b);
    expect(writes()).toHaveLength(0);
    // The daemon released it inside task-a's completed commit.
    Object.assign(companyHoldOf(daemon.tasks.get('task-c'))!, { waitingOn: [], releasedAt: 'r' });
    b.pullNow();
    await b.whenIdle();
    expect(events).toEqual(['attempted:true', 'write', 'delivered']);
  });

  it('writes nothing when the attempt could not be recorded, and tries again later', async () => {
    daemon.tasks.set('task-c', companyTask('task-c', released()));
    daemon.refuseAttempt = true;
    const b = bridge();
    await pull(b);
    expect(writes()).toHaveLength(0);
    clock += COMPANY_BRIDGE_RETRY_MIN_MS;
    await pull(b);
    expect(events).toEqual(['attempted:true', 'write', 'delivered']);
  });

  it('a refused write clears the attempt and retries after the delay', async () => {
    daemon.tasks.set('task-c', companyTask('task-c', released()));
    deliverAnswers.push({ ok: true, delivered: false, reason: 'approval_pending' });
    const b = bridge();
    await pull(b);
    expect(marksOf('task-c')).toEqual([{ attempted: true }, { attempted: false }]);
    await pull(b);
    expect(writes()).toHaveLength(1);
    clock += COMPANY_BRIDGE_RETRY_MIN_MS;
    await pull(b);
    expect(writes()).toHaveLength(2);
    expect(marksOf('task-c').at(-1)).toEqual({ delivered: true, ptyId: 'pty-dev' });
  });

  it('a pane with no agent, again and again, is held as no-agent and the CEO told once', async () => {
    daemon.tasks.set('task-c', companyTask('task-c', released()));
    for (let i = 0; i < COMPANY_BRIDGE_NO_AGENT_TRIES; i++) deliverAnswers.push({ ok: true, delivered: false, reason: 'no_agent_pane' });
    const b = bridge();
    for (let i = 0; i < COMPANY_BRIDGE_NO_AGENT_TRIES; i++) {
      // eslint-disable-next-line no-await-in-loop -- one try per pull
      await pull(b);
      // Past this try's backoff, well inside the no-agent time limit.
      clock += COMPANY_BRIDGE_RETRY_MIN_MS * 2 ** i;
    }
    expect(writes()).toHaveLength(COMPANY_BRIDGE_NO_AGENT_TRIES);
    expect(marksOf('task-c').at(-1)).toEqual({ held: 'no-agent' });
    await pull(b);
    await pull(b);
    expect(ceoLines()).toEqual([expect.objectContaining({ kind: 'held', held: 'no-agent', task: expect.objectContaining({ id: 'task-c' }) })]);
    expect(writes()).toHaveLength(COMPANY_BRIDGE_NO_AGENT_TRIES);
  });

  it('a seat pane that is gone is held as pane-missing, and the CEO told', async () => {
    daemon.tasks.set('task-c', companyTask('task-c', released()));
    deliverAnswers.push({ ok: true, delivered: false, held: 'pane-missing' });
    const b = bridge();
    await pull(b);
    expect(marksOf('task-c')).toEqual([{ attempted: true }, { held: 'pane-missing' }]);
    await pull(b);
    expect(ceoLines()).toEqual([expect.objectContaining({ kind: 'held', held: 'pane-missing' })]);
  });

  it('a task that names no seat pane is held without any write', async () => {
    daemon.tasks.set('task-c', companyTask('task-c', released(), { paneId: null }));
    await pull(bridge());
    expect(writes()).toHaveLength(0);
    expect(marksOf('task-c')).toEqual([{ held: 'pane-missing' }]);
  });

  it('the renderer\'s duplicate answer is recorded as delivered', async () => {
    daemon.tasks.set('task-c', companyTask('task-c', released()));
    deliverAnswers.push({ ok: true, delivered: true, duplicate: true });
    await pull(bridge());
    expect(marksOf('task-c')).toEqual([{ attempted: true }, { delivered: true }]);
  });

  it('a task left attempted by an earlier main is held as delivery-unconfirmed, never written again', async () => {
    daemon.tasks.set('task-c', companyTask('task-c', released({ attempted: true })));
    const b = bridge();
    await pull(b);
    await pull(b);
    expect(writes()).toHaveLength(0);
    expect(marksOf('task-c')).toEqual([{ held: 'delivery-unconfirmed' }]);
    expect(ceoLines()).toEqual([expect.objectContaining({ kind: 'held', held: 'delivery-unconfirmed' })]);
  });

  it('an unanswered write leaves the attempt standing: the next pull holds it, never writing twice', async () => {
    daemon.tasks.set('task-c', companyTask('task-c', released()));
    deliverAnswers.push(new Error('RPC timeout: a2a.company.deliver'));
    const b = bridge();
    await pull(b);
    expect(marksOf('task-c')).toEqual([{ attempted: true }]);
    clock += COMPANY_BRIDGE_RETRY_MIN_MS;
    await pull(b);
    expect(writes()).toHaveLength(1);
    expect(marksOf('task-c').at(-1)).toEqual({ held: 'delivery-unconfirmed' });
  });

  it('with no window, nothing was written: the attempt is cleared and tried again', async () => {
    daemon.tasks.set('task-c', companyTask('task-c', released()));
    deliverAnswers.push(new Error('BrowserWindow is not available'));
    const b = bridge();
    await pull(b);
    expect(marksOf('task-c')).toEqual([{ attempted: true }, { attempted: false }]);
    clock += COMPANY_BRIDGE_RETRY_MIN_MS;
    await pull(b);
    expect(marksOf('task-c').at(-1)).toEqual({ delivered: true, ptyId: 'pty-dev' });
  });

  it('a delivered mark the daemon did not take is retried alone, without a second write', async () => {
    daemon.tasks.set('task-c', companyTask('task-c', released()));
    const b = bridge();
    // attempted:true is taken; the delivered mark after the write is not.
    const mark = daemon.a2aCompanyMark.bind(daemon);
    let calls = 0;
    daemon.a2aCompanyMark = async (p) => {
      calls += 1;
      if (calls === 2) throw new Error('pipe closed');
      return mark(p);
    };
    await pull(b);
    await pull(b);
    expect(writes()).toHaveLength(1);
    expect(marksOf('task-c')).toEqual([{ attempted: true }, { delivered: true, ptyId: 'pty-dev' }]);
  });
});

describe('CompanyReleaseBridge — CEO lines', () => {
  const stranded = () => companyTask('task-c', { blockedBy: ['task-a', 'task-b'], waitingOn: ['task-a', 'task-b'], blockerEnded: [{ id: 'task-a', state: 'failed' }] });

  it('tells the CEO once that a blocker of a waiting task failed', async () => {
    daemon.tasks.set('task-c', stranded());
    const b = bridge();
    await pull(b);
    await pull(b);
    expect(ceoLines()).toEqual([expect.objectContaining({ kind: 'blocker-ended', blocker: { id: 'task-a', state: 'failed' } })]);
    expect(writes()).toHaveLength(0);
  });

  it('a write a stopped bridge started is left to finish, and its mark goes through the next connection', async () => {
    daemon.tasks.set('task-c', companyTask('task-c', released()));
    let land!: (answer: unknown) => void;
    deliverAnswers.push(new Promise((resolve) => { land = resolve; }));
    let gone = false;
    const oldClient = {
      a2aCompanyPending: () => daemon.a2aCompanyPending(),
      a2aCompanyHeld: () => daemon.a2aCompanyHeld(),
      a2aCompanyMark: async (params: A2aCompanyMarkParams) => {
        if (gone) throw new Error('pipe closed');
        return daemon.a2aCompanyMark(params);
      },
    };
    const inFlight = new Set<string>();
    const pendingMarks = new Map<string, CompanyReleaseMark>();
    const first = new CompanyReleaseBridge({ daemon: oldClient, sendToRenderer: renderer, now: () => clock, inFlight, pendingMarks });
    await first.trigger();
    await vi.waitFor(() => expect(writes()).toHaveLength(1), { timeout: 5_000 });
    first.stop();
    gone = true;
    const next = new CompanyReleaseBridge({ daemon, sendToRenderer: renderer, now: () => clock, inFlight, pendingMarks });
    await pull(next);
    // Still being written: not judged unconfirmed, not written again.
    expect(marksOf('task-c')).toEqual([{ attempted: true }]);
    land({ ok: true, delivered: true, ptyId: 'pty-dev' });
    await first.whenIdle();
    await pull(next);
    expect(marksOf('task-c')).toEqual([{ attempted: true }, { delivered: true, ptyId: 'pty-dev' }]);
    expect(writes()).toHaveLength(1);
  });

  it('remembers what it told across reconnects when given one set, and repeats once without it', async () => {
    daemon.tasks.set('task-c', stranded());
    const told = new Set<string>();
    await pull(bridge(told));
    await pull(bridge(told));
    expect(ceoLines()).toHaveLength(1);
    // An app restart starts with nothing told: at most one repeat.
    await pull(bridge());
    expect(ceoLines()).toHaveLength(2);
  });

  it('a refused line is tried again; a CEO pane with no agent is not', async () => {
    daemon.tasks.set('task-c', stranded());
    ceoAnswers.push({ ok: true, delivered: false, reason: 'user_typing' });
    const b = bridge();
    await pull(b);
    await pull(b);
    expect(ceoLines()).toHaveLength(1);
    clock += COMPANY_BRIDGE_RETRY_MIN_MS;
    await pull(b);
    expect(ceoLines()).toHaveLength(2);
    daemon.tasks.set('task-d', companyTask('task-d', released({ held: 'no-agent' })));
    ceoAnswers.push({ ok: true, delivered: false, reason: 'no_agent_pane' });
    await pull(b);
    await pull(b);
    expect(ceoLines().filter((l) => (l.task as Task).id === 'task-d')).toHaveLength(1);
  });

  it('names one event per held reason and per ended blocker still waited on', () => {
    const task = companyTask('task-c', { blockedBy: ['task-a', 'task-b'], waitingOn: ['task-b'], blockerEnded: [{ id: 'task-a', state: 'canceled' }, { id: 'task-b', state: 'canceled' }] });
    expect(companyCeoEventsOf(task).map((e) => e.key)).toEqual(['task-c|ended|task-b|canceled']);
    expect(companyCeoEventsOf(companyTask('task-d', released({ held: 'pane-missing' }))).map((e) => e.key)).toEqual(['task-d|held|pane-missing']);
    expect(companyCeoEventsOf(companyTask('task-e', released({ delivered: true, held: 'no-agent' })))).toEqual([]);
  });

  it('tells the CEO again when a reopened blocker ends again, by when it ended', async () => {
    const endedAt = (at: string): CompanyBlockerEnd => ({ id: 'task-a', state: 'failed', at } as CompanyBlockerEnd);
    daemon.tasks.set('task-c', companyTask('task-c', { blockedBy: ['task-a'], waitingOn: ['task-a'], blockerEnded: [endedAt('2026-11-01T01:00:00.000Z')] }));
    const b = bridge();
    await pull(b);
    await pull(b);
    expect(ceoLines()).toHaveLength(1);
    // task-a was reopened, then failed again: the daemon notes the new end.
    companyHoldOf(daemon.tasks.get('task-c'))!.blockerEnded = [endedAt('2026-11-01T02:00:00.000Z')];
    await pull(b);
    await pull(b);
    expect(ceoLines()).toHaveLength(2);
    expect(companyCeoEventsOf(daemon.tasks.get('task-c')!)[0].key).toBe('task-c|ended|task-a|failed|2026-11-01T02:00:00.000Z');
    // An end with no time keeps the earlier key.
    expect(companyCeoEventsOf(companyTask('task-x', { blockedBy: ['task-a'], waitingOn: ['task-a'], blockerEnded: [{ id: 'task-a', state: 'failed' }] }))[0].key)
      .toBe('task-x|ended|task-a|failed');
  });
});
