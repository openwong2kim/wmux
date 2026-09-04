import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import {
  buildWorkspaceFacts,
  createWorkspaceFactsPublisher,
  WORKSPACE_FACTS_DEBOUNCE_MS,
  type WorkspaceFactRow,
} from '../workspaceFactsFeed';

function fakeLedger(entries: { taskWorkspaceId: string }[]): () => TaskLedger {
  return () => ({ list: () => entries }) as unknown as TaskLedger;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('buildWorkspaceFacts', () => {
  it('publishes the EFFECTIVE approvalPress capability, not just the mode', () => {
    const rows = buildWorkspaceFacts({
      push: async () => undefined,
      ledger: fakeLedger([{ taskWorkspaceId: 'ws-task' }, { taskWorkspaceId: 'ws-report' }]),
      autonomy: () => ({
        'ws-task': { mode: 'danger', approvalPress: true },
        // A 'danger' workspace running a `report` loop: the mode still reads
        // danger, but main narrowed the capability to false. Publishing the
        // mode alone would have authorized a press the operator's own UI says
        // is off.
        'ws-report': { mode: 'danger', approvalPress: false },
      }),
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        { workspaceId: 'ws-task', isTaskWorkspace: true, autonomyMode: 'danger', approvalPress: true },
        { workspaceId: 'ws-report', isTaskWorkspace: true, autonomyMode: 'danger', approvalPress: false },
      ]),
    );
  });

  it('marks a hand-opened workspace as not a task workspace', () => {
    const rows = buildWorkspaceFacts({
      push: async () => undefined,
      ledger: fakeLedger([]),
      autonomy: () => ({ 'ws-human': { mode: 'danger', approvalPress: true } }),
    });
    expect(rows).toEqual([
      { workspaceId: 'ws-human', isTaskWorkspace: false, autonomyMode: 'danger', approvalPress: true },
    ]);
  });

  it('defaults a task workspace with no stored autonomy to off / press disabled', () => {
    const rows = buildWorkspaceFacts({
      push: async () => undefined,
      ledger: fakeLedger([{ taskWorkspaceId: 'ws-task' }]),
      autonomy: () => ({}),
    });
    expect(rows).toEqual([
      { workspaceId: 'ws-task', isTaskWorkspace: true, autonomyMode: 'off', approvalPress: false },
    ]);
  });

  it('publishes no task workspaces when the ledger cannot be read (refuse, not assume)', () => {
    const rows = buildWorkspaceFacts({
      push: async () => undefined,
      ledger: () => {
        throw new Error('ledger file is torn');
      },
      autonomy: () => ({ 'ws-task': { mode: 'assist', approvalPress: true } }),
    });
    expect(rows).toEqual([
      { workspaceId: 'ws-task', isTaskWorkspace: false, autonomyMode: 'assist', approvalPress: true },
    ]);
  });
});

describe('createWorkspaceFactsPublisher', () => {
  const ports = (push: (rows: WorkspaceFactRow[], seq: number) => Promise<unknown>) => ({
    push,
    ledger: fakeLedger([]),
    autonomy: () => ({}),
  });

  it('stamps a strictly increasing seq so a late push cannot restore an old table', async () => {
    const seen: number[] = [];
    const p = createWorkspaceFactsPublisher(ports(async (_rows, seq) => {
      seen.push(seq);
    }));
    await p.publishNow();
    await p.publishNow();
    await p.publishNow();
    expect(seen).toEqual([1, 2, 3]);
    p.dispose();
  });

  it('coalesces a burst into one push', async () => {
    vi.useFakeTimers();
    const push = vi.fn(async () => undefined);
    const p = createWorkspaceFactsPublisher(ports(push));
    // A fan-out registering N tasks fires N transitions in a few ms.
    for (let i = 0; i < 10; i++) p.schedule();
    expect(push).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WORKSPACE_FACTS_DEBOUNCE_MS + 5);
    expect(push).toHaveBeenCalledTimes(1);
    p.dispose();
  });

  it('never runs two pushes at once, and republishes once for changes made during one', async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    // A holder, not a bare `let`: TS does not track assignments made inside a
    // callback and would narrow the variable to `never`.
    const gate: { release: (() => void) | null } = { release: null };
    const push = vi.fn(async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise<void>((r) => {
        gate.release = r;
      });
      inFlight -= 1;
    });
    const letOnePushFinish = async (): Promise<void> => {
      await vi.waitFor(() => expect(gate.release).not.toBeNull());
      const release = gate.release;
      gate.release = null;
      release?.();
    };

    const p = createWorkspaceFactsPublisher(ports(push));
    const first = p.publishNow();
    // Two more requests arrive while the first is on the wire.
    void p.publishNow();
    void p.publishNow();
    await letOnePushFinish();
    await letOnePushFinish();
    await first;
    expect(maxConcurrent).toBe(1);
    // Latest-wins: the two overlapping requests collapse into ONE republish.
    expect(push).toHaveBeenCalledTimes(2);
    p.dispose();
  });

  it('swallows a failed push so a disconnected daemon never breaks the caller', async () => {
    const push = vi.fn(async () => {
      throw new Error('Daemon not connected');
    });
    const p = createWorkspaceFactsPublisher(ports(push));
    await expect(p.publishNow()).resolves.toBeUndefined();
    expect(push).toHaveBeenCalledTimes(1);
    p.dispose();
  });
});
