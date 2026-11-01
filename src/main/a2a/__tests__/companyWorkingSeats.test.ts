// The count behind the per-PC cap: which company staff seats on this PC are
// working, read from the renderer's panes and the daemon's open tasks.
import { describe, expect, it, vi } from 'vitest';
import { COMPANY_HOLD_KEY, type CompanyHoldMarker } from '../../../shared/companyHold';
import type { TaskState } from '../../../shared/types';
import {
  COMPANY_SEAT_READ_TIMEOUT_MS,
  companyWorkingSeats,
  readCompanyWorkingSeats,
  type CompanySeatSnapshot,
} from '../CompanyReleaseBridge';

const BRIEF = { kind: 'wmux.company.brief', v: 1, goal: 'g', scope: 's', acceptance: 'a', verify: 'v', report: 'r' };

function task(id: string, ws: string, paneId: string, state: TaskState = 'working', over: { hold?: CompanyHoldMarker; brief?: boolean } = {}) {
  return {
    kind: 'task',
    id,
    status: { state, timestamp: 't' },
    history: [{
      kind: 'message',
      messageId: `m-${id}`,
      role: 'user',
      parts: [{ kind: 'text', text: id }, ...(over.brief === false ? [] : [{ kind: 'data', data: BRIEF }])],
    }],
    artifacts: [],
    metadata: {
      title: id,
      from: { workspaceId: ws, name: ws, paneId: `${ws}-ceo` },
      to: { workspaceId: ws, name: ws, paneId },
      createdAt: 't',
      updatedAt: 't',
      ...(over.hold ? { [COMPANY_HOLD_KEY]: over.hold } : {}),
    },
  };
}

/** A pane row as `pane.list` gives it. `alive: false` is a pane whose agent is known to have exited. */
function pane(id: string, seat: 'coordinator' | 'staff' | undefined, over: { alive?: boolean; label?: string; tag?: string } = {}) {
  const pty = `pty-${id}`;
  return {
    id,
    paneName: over.label ?? `${(over.tag ?? '#w1-1').slice(1)}(claude)`,
    paneTag: over.tag ?? '#w1-1',
    surfacePtyIds: [pty],
    agents: [{ ptyId: pty, surfaceId: `s-${id}`, agentName: over.alive === false ? null : 'claude', agentStatus: 'idle' }],
    ...(seat ? { companySeat: seat } : {}),
  };
}

const company = (ws: string, panes: unknown[], tasks: unknown[]): CompanySeatSnapshot => ({ workspaceId: ws, panes, tasks });
const names = (snaps: CompanySeatSnapshot[]) => companyWorkingSeats(snaps).working.map((s) => s.name);

describe('companyWorkingSeats', () => {
  const panes = [pane('ceo', 'coordinator'), pane('dev-1', 'staff', { label: 'dev-1' }), pane('dev-2', 'staff', { tag: '#w1-3' })];

  it('counts a seat once, however many tasks it holds', () => {
    const count = companyWorkingSeats([company('ws-a', panes, [task('t1', 'ws-a', 'dev-1'), task('t2', 'ws-a', 'dev-1', 'submitted')])]);
    expect(count.working).toEqual([{ workspaceId: 'ws-a', paneId: 'dev-1', name: '#dev-1' }]);
  });

  it('names a seat by its label, else by its pane tag', () => {
    expect(names([company('ws-a', panes, [task('t1', 'ws-a', 'dev-1'), task('t2', 'ws-a', 'dev-2')])])).toEqual(['#dev-1', '#w1-3']);
  });

  it('frees a seat that reported (input-required) or whose task ended', () => {
    for (const state of ['input-required', 'completed', 'failed', 'canceled'] as const) {
      expect(names([company('ws-a', panes, [task('t1', 'ws-a', 'dev-1', state)])])).toEqual([]);
    }
  });

  it('frees a seat whose agent is not alive', () => {
    const dead = [pane('dev-1', 'staff', { label: 'dev-1', alive: false })];
    expect(names([company('ws-a', dead, [task('t1', 'ws-a', 'dev-1')])])).toEqual([]);
    const noAgents = [{ ...pane('dev-1', 'staff', { label: 'dev-1' }), agents: [] }];
    expect(names([company('ws-a', noAgents, [task('t1', 'ws-a', 'dev-1')])])).toEqual([]);
  });

  it('counts a task with a hold only once it is delivered', () => {
    const waiting = task('t1', 'ws-a', 'dev-1', 'submitted', { hold: { blockedBy: ['x'], waitingOn: ['x'] } });
    const owed = task('t2', 'ws-a', 'dev-1', 'submitted', { hold: { blockedBy: [], waitingOn: [], releasedAt: 'r' } });
    const attempted = task('t3', 'ws-a', 'dev-1', 'submitted', { hold: { blockedBy: [], waitingOn: [], releasedAt: 'r', attempted: true } });
    const held = task('t4', 'ws-a', 'dev-1', 'submitted', { hold: { blockedBy: ['x'], waitingOn: [], releasedAt: 'r', held: 'no-agent' } });
    expect(names([company('ws-a', panes, [waiting, owed, attempted, held])])).toEqual([]);
    const delivered = task('t5', 'ws-a', 'dev-1', 'working', { hold: { blockedBy: ['x'], waitingOn: [], releasedAt: 'r', delivered: true } });
    expect(names([company('ws-a', panes, [waiting, delivered])])).toEqual(['#dev-1']);
  });

  it('counts neither the CEO, a pane outside a company, a plain task nor a task with another PC', () => {
    const rows = [...panes, pane('plain', undefined)];
    const tasks = [
      task('t1', 'ws-a', 'ceo'),
      task('t2', 'ws-a', 'plain'),
      task('t3', 'ws-a', 'dev-1', 'working', { brief: false }),
      task(`rt-${'a'.repeat(32)}`, 'ws-a', 'dev-2'),
      task('t5', 'ws-other', 'dev-2'),
    ];
    expect(names([company('ws-a', rows, tasks)])).toEqual([]);
  });

  it('shares one count across every company on the PC', () => {
    const b = [pane('b-ceo', 'coordinator'), pane('b-dev', 'staff', { label: 'b-dev' })];
    const count = companyWorkingSeats([
      company('ws-a', panes, [task('t1', 'ws-a', 'dev-1')]),
      company('ws-b', b, [task('t2', 'ws-b', 'b-dev')]),
    ]);
    expect(count.working.map((s) => [s.workspaceId, s.name])).toEqual([['ws-a', '#dev-1'], ['ws-b', '#b-dev']]);
    expect([...count.staff.keys()]).toEqual(['dev-1', 'dev-2', 'b-dev']);
  });
});

describe('readCompanyWorkingSeats', () => {
  const rows: Record<string, unknown[]> = {
    'ws-a': [pane('ceo', 'coordinator'), pane('dev-1', 'staff', { label: 'dev-1' })],
    'ws-plain': [pane('p1', undefined)],
  };

  function io(over: { tasks?: Record<string, unknown[]>; daemon?: (params: Record<string, unknown>) => unknown; renderer?: (method: string) => unknown } = {}) {
    const daemonRpc = vi.fn(async (_method: string, params: Record<string, unknown>) => {
      if (over.daemon) return over.daemon(params);
      const all = over.tasks?.[params.workspaceId as string] ?? [];
      return { ok: true, tasks: all.filter((t) => (t as { status: { state: string } }).status.state === params.status) };
    });
    const sendToRenderer = vi.fn(async (method: string, params: Record<string, unknown>) => {
      const answer = over.renderer?.(method);
      if (answer !== undefined) return answer;
      if (method === 'workspace.list') return [{ id: 'ws-a' }, { id: 'ws-plain' }];
      if (method === 'pane.list') return rows[params.workspaceId as string] ?? [];
      return null;
    });
    return { daemonRpc, sendToRenderer };
  }

  it('reads each company\'s submitted and working tasks as main\'s own lane, and skips a workspace that is no company', async () => {
    const deps = io({ tasks: { 'ws-a': [task('t1', 'ws-a', 'dev-1', 'submitted'), task('t2', 'ws-a', 'dev-1', 'input-required')] } });
    const count = await readCompanyWorkingSeats(deps);
    expect(count?.working.map((s) => s.name)).toEqual(['#dev-1']);
    expect(deps.sendToRenderer).toHaveBeenCalledWith('pane.list', { workspaceId: 'ws-a', includeStashed: true });
    expect(deps.daemonRpc.mock.calls).toEqual([
      ['a2a.task.query', { workspaceId: 'ws-a', role: 'agent', status: 'submitted', trustedLane: true }, { timeoutMs: COMPANY_SEAT_READ_TIMEOUT_MS }],
      ['a2a.task.query', { workspaceId: 'ws-a', role: 'agent', status: 'working', trustedLane: true }, { timeoutMs: COMPANY_SEAT_READ_TIMEOUT_MS }],
    ]);
  });

  it('counts nothing on a guess: null when the renderer or the daemon does not answer', async () => {
    expect(await readCompanyWorkingSeats(io({ renderer: (m) => (m === 'workspace.list' ? null : undefined) }))).toBeNull();
    expect(await readCompanyWorkingSeats(io({ renderer: (m) => (m === 'pane.list' ? null : undefined) }))).toBeNull();
    expect(await readCompanyWorkingSeats(io({ daemon: () => ({ ok: false, error: 'a2a.task.query: task log unavailable' }) }))).toBeNull();
    expect(await readCompanyWorkingSeats(io({ daemon: () => { throw new Error('pipe closed'); } }))).toBeNull();
  });
});
