import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcRouter } from '../../RpcRouter';
import { registerEventsRpc } from '../events.rpc';
import { eventBus } from '../../../events/EventBus';

// registerHandlers.ts imports `electron` at module top-level (ipcMain,
// BrowserWindow). Mock it so we can import the pure a2a.task trust-boundary
// predicate (buildA2aTaskEmitInput) without standing up Electron — the same
// pattern 20+ main-process suites use. We only need the names that exist on
// the module surface to satisfy the import; nothing here is invoked.
vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeAllListeners: vi.fn() },
  app: { getPath: vi.fn(() => ''), on: vi.fn() },
}));

// events.poll now server-resolves an agent transport's workspace from a verified
// senderPtyId via the renderer bridge (input.findOwnerWorkspace) — mock it so the
// B3 agent-path suite can resolve a ptyId to a deterministic owning workspace.
// The first-party / lifecycle suites never reach it (no senderPtyId).
vi.mock('../_bridge', () => ({ sendToRenderer: vi.fn() }));

import { buildA2aTaskEmitInput } from '../../../ipc/registerHandlers';
import type { A2aTaskEvent } from '../../../../shared/events';
import { sendToRenderer } from '../_bridge';

const nullWindow = () => null;

// The renderer IPC bridge is the trusted first-party operator surface; it scopes
// every event class by the caller-supplied workspaceId (operator model). The bare
// helpers below dispatch as first-party so the scoping-filter suites keep asserting
// that behavior; the B3 suite dispatches WITHOUT it to exercise the agent path.
function setupRouter(): RpcRouter {
  const router = new RpcRouter();
  registerEventsRpc(router, nullWindow);
  return router;
}

/**
 * Emit an a2a.task onto the ring through the SAME allow-listed shape the
 * publish trust boundary (registerHandlers onEventsPublish) produces. Using
 * buildA2aTaskEmitInput keeps the test honest: if the boundary's validation
 * rejects the input, nothing is emitted and the assertion sees zero events —
 * exactly the production behavior.
 */
function publishA2aTask(input: Record<string, unknown>): boolean {
  const emit = buildA2aTaskEmitInput(input);
  if (!emit) return false;
  eventBus.emit(emit);
  return true;
}

async function pollEvents(
  router: RpcRouter,
  params: Record<string, unknown>,
): Promise<Array<{ type: string; kind?: string; from?: string; to?: string }>> {
  const res = await router.dispatch({ id: 'p', method: 'events.poll', params }, { firstParty: true });
  if (!res.ok) throw new Error('poll dispatch failed');
  return (res.result as { events: Array<{ type: string; kind?: string }> }).events;
}

describe('events.rpc — events.poll', () => {
  beforeEach(() => {
    eventBus.reset();
  });

  it('returns events with cursor and types defaults', async () => {
    eventBus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });
    eventBus.emit({ type: 'pane.closed', workspaceId: 'ws-1', paneId: 'p1' });

    const router = setupRouter();
    const res = await router.dispatch({ id: '1', method: 'events.poll', params: {} });

    expect(res.ok).toBe(true);
    if (res.ok) {
      const result = res.result as { events: unknown[]; nextCursor: number };
      expect(result.events).toHaveLength(2);
      expect(result.nextCursor).toBe(2);
    }
  });

  it('honors cursor param', async () => {
    eventBus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });
    eventBus.emit({ type: 'pane.closed', workspaceId: 'ws-1', paneId: 'p1' });
    eventBus.emit({ type: 'pane.focused', workspaceId: 'ws-1', paneId: 'p2' });

    const router = setupRouter();
    const res = await router.dispatch({ id: '2', method: 'events.poll', params: { cursor: 1 } });

    if (res.ok) {
      const result = res.result as { events: { seq: number }[] };
      expect(result.events.map((e) => e.seq)).toEqual([2, 3]);
    }
  });

  it('honors workspaceId scope', async () => {
    eventBus.emit({ type: 'pane.created', workspaceId: 'ws-A', paneId: 'pA' });
    eventBus.emit({ type: 'pane.created', workspaceId: 'ws-B', paneId: 'pB' });
    eventBus.emit({ type: 'pane.focused', workspaceId: 'ws-A', paneId: 'pA' });

    const router = setupRouter();
    const res = await router.dispatch({ id: '3', method: 'events.poll', params: { workspaceId: 'ws-A' } });

    if (res.ok) {
      const result = res.result as { events: { workspaceId: string }[] };
      expect(result.events.every((e) => e.workspaceId === 'ws-A')).toBe(true);
    }
  });

  it('honors types filter and drops unknown types silently', async () => {
    eventBus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });
    eventBus.emit({ type: 'process.started', workspaceId: 'ws-1', ptyId: 't1', shell: 'pwsh' });

    const router = setupRouter();
    const res = await router.dispatch({
      id: '4',
      method: 'events.poll',
      params: { types: ['process.started', 'not-a-real-type'] },
    });

    if (res.ok) {
      const result = res.result as { events: { type: string }[] };
      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe('process.started');
    }
  });

  it('accepts agent.lifecycle filter (new event type)', async () => {
    eventBus.emit({
      type: 'agent.lifecycle',
      workspaceId: 'ws-1',
      ptyId: 'pty-1',
      kind: 'agent.stop',
      source: 'hook',
      agent: 'claude',
      decision: 'emit',
    });
    eventBus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p-other' });

    const router = setupRouter();
    const res = await router.dispatch({
      id: 'lifecycle',
      method: 'events.poll',
      params: { types: ['agent.lifecycle'] },
    });

    if (res.ok) {
      const result = res.result as { events: { type: string; source?: string }[] };
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({ type: 'agent.lifecycle', source: 'hook' });
    }
  });

  it('accepts workspace.metadata.changed filter (pre-existing gap closed)', async () => {
    eventBus.emit({
      type: 'workspace.metadata.changed',
      workspaceId: 'ws-1',
      metadata: { cwd: '/repo' },
      patch: { cwd: '/repo' },
    });

    const router = setupRouter();
    const res = await router.dispatch({
      id: 'wsmeta',
      method: 'events.poll',
      params: { types: ['workspace.metadata.changed'] },
    });

    if (res.ok) {
      const result = res.result as { events: { type: string }[] };
      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe('workspace.metadata.changed');
    }
  });

  it('clamps cursor to non-negative integer', async () => {
    eventBus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });

    const router = setupRouter();
    const res = await router.dispatch({
      id: '5',
      method: 'events.poll',
      params: { cursor: -50 },
    });

    if (res.ok) {
      const result = res.result as { events: unknown[] };
      // Negative cursor clamps to 0, so we still get the event.
      expect(result.events).toHaveLength(1);
    }
  });

  it('honors max param', async () => {
    for (let i = 0; i < 5; i++) {
      eventBus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: `p${i}` });
    }

    const router = setupRouter();
    const res = await router.dispatch({
      id: '6',
      method: 'events.poll',
      params: { max: 2 },
    });

    if (res.ok) {
      const result = res.result as { events: unknown[] };
      expect(result.events).toHaveLength(2);
    }
  });

  it('keeps normal advancement and resync replacement distinct after scoped max truncation', async () => {
    eventBus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });
    eventBus.emit({ type: 'pane.closed', workspaceId: 'ws-1', paneId: 'p1' });

    const router = setupRouter();
    const normal = await router.dispatch({
      id: 'cursor-normal',
      method: 'events.poll',
      params: { cursor: 0, workspaceId: 'ws-1', max: 1 },
    }, { firstParty: true });

    expect(normal.ok).toBe(true);
    if (!normal.ok) return;
    const normalResult = normal.result as {
      events: { seq: number }[];
      nextCursor: number;
      priorCursor: number;
      resync?: true;
    };
    expect(normalResult.events.map((event) => event.seq)).toEqual([1]);
    expect(normalResult).toMatchObject({ priorCursor: 0, nextCursor: 1 });
    expect(normalResult.resync).toBeUndefined();
    expect(normalResult.nextCursor).toBeGreaterThan(normalResult.priorCursor);

    const replacement = await router.dispatch({
      id: 'cursor-resync',
      method: 'events.poll',
      params: { cursor: 999, workspaceId: 'ws-1', max: 1 },
    }, { firstParty: true });

    expect(replacement.ok).toBe(true);
    if (!replacement.ok) return;
    const replacementResult = replacement.result as {
      events: { seq: number }[];
      nextCursor: number;
      priorCursor: number;
      resync?: true;
    };
    expect(replacementResult.events.map((event) => event.seq)).toEqual([1]);
    expect(replacementResult).toMatchObject({ priorCursor: 999, nextCursor: 1, resync: true });
    expect(replacementResult.nextCursor).toBeLessThan(replacementResult.priorCursor);
  });

  it('exposes bootId + priorCursor on every response (review fixes 5a, 2a)', async () => {
    eventBus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });

    const router = setupRouter();
    const res = await router.dispatch({
      id: 'fix-1',
      method: 'events.poll',
      params: { cursor: 7 },
    });

    if (res.ok) {
      const result = res.result as { bootId: string; priorCursor: number };
      expect(typeof result.bootId).toBe('string');
      expect(result.bootId.length).toBeGreaterThan(0);
      expect(result.priorCursor).toBe(7);
    }
  });
});

// === A2A dual-party scoping — the make-or-break security suite ===
//
// An a2a.task involves TWO workspaces (from=sender, to=receiver). Its base
// workspaceId === from. The events.poll dual-party post-filter must make it
// visible to ONLY from and to, NEVER a third workspace, and NEVER an unscoped
// (workspaceId-less) poll. These cases drive the real EventBus + the real
// events.poll handler.
describe('events.rpc — a2a.task dual-party scoping', () => {
  const FROM = 'ws-sender';
  const TO = 'ws-receiver';
  const THIRD = 'ws-unrelated';

  beforeEach(() => {
    eventBus.reset();
  });

  /**
   * Seed a created + updated pair for the FROM→TO task, plus a non-a2a event
   * owned by FROM (to prove the strict path for other types is untouched).
   */
  function seedPair(): void {
    // created (kind:'created'), base workspaceId stamped === FROM by the boundary.
    expect(
      publishA2aTask({ type: 'a2a.task', from: FROM, to: TO, taskId: 't1', state: 'submitted', kind: 'created' }),
    ).toBe(true);
    // updated receipt (kind:'updated').
    expect(
      publishA2aTask({ type: 'a2a.task', from: FROM, to: TO, taskId: 't1', state: 'working', kind: 'updated' }),
    ).toBe(true);
    // A NON-a2a event with workspaceId === FROM — must stay strictly FROM-scoped.
    eventBus.emit({ type: 'pane.created', workspaceId: FROM, paneId: 'p-from' });
  }

  it('case 1: sender (poll workspaceId = from) sees the a2a.task created + updated', async () => {
    seedPair();
    const router = setupRouter();
    const events = await pollEvents(router, { workspaceId: FROM });
    const a2a = events.filter((e) => e.type === 'a2a.task');
    expect(a2a.map((e) => e.kind)).toEqual(['created', 'updated']);
  });

  it('case 2: receiver (poll workspaceId = to) sees the a2a.task created + updated', async () => {
    seedPair();
    const router = setupRouter();
    const events = await pollEvents(router, { workspaceId: TO });
    const a2a = events.filter((e) => e.type === 'a2a.task');
    // The receiver MUST see `created` even though the event's base
    // workspaceId === from (the dual-party `to` key + the no-strict-wsFilter
    // poll path make this work end-to-end).
    expect(a2a.map((e) => e.kind)).toEqual(['created', 'updated']);
    // And every a2a event the receiver sees is genuinely addressed to it.
    expect(a2a.every((e) => (e as A2aTaskEvent).to === TO)).toBe(true);
  });

  it('case 3: third party (unrelated workspaceId) sees NEITHER (zero a2a.task)', async () => {
    seedPair();
    const router = setupRouter();
    const events = await pollEvents(router, { workspaceId: THIRD });
    expect(events.filter((e) => e.type === 'a2a.task')).toHaveLength(0);
  });

  it('case 4: a non-a2a event with workspaceId === from is NOT leaked to a poller whose workspaceId = to', async () => {
    seedPair();
    const router = setupRouter();
    const events = await pollEvents(router, { workspaceId: TO });
    // The strict path for non-a2a types is untouched: a pane.created owned by
    // FROM must never reach the TO poller.
    const paneEvents = events.filter((e) => e.type === 'pane.created');
    expect(paneEvents).toHaveLength(0);
    // (And the sender DOES still see its own pane.created — sanity.)
    const senderEvents = await pollEvents(router, { workspaceId: FROM });
    expect(senderEvents.some((e) => e.type === 'pane.created')).toBe(true);
  });

  it('case 5: unscoped poll (no workspaceId) returns ZERO a2a.task events (plugin-host leak guard)', async () => {
    seedPair();
    const router = setupRouter();
    // No workspaceId — mimics the plugin-host forwarding poll. The `!!caller &&`
    // clause must unconditionally withhold every a2a.task.
    const events = await pollEvents(router, {});
    expect(events.filter((e) => e.type === 'a2a.task')).toHaveLength(0);
    // The unscoped poll still receives non-a2a events (strict path: no caller →
    // pass-through), proving the withholding is a2a-specific, not a blanket drop.
    expect(events.some((e) => e.type === 'pane.created')).toBe(true);
  });

  // === Regression locks requested by the security review (PASS_WITH_NITS) ===

  // Test A — per-event discrimination. The dual-party filter matches each
  // event's OWN from/to; it is NOT "deliver any a2a.task to anyone who is a
  // party to SOME task on the ring". Three distinct tasks share one ring; the
  // poller (THIRD) is the receiver of exactly one of them and must see only
  // that one — never the other two, even though they all carry type a2a.task.
  it('case A: dual-party filter discriminates per-event (THIRD sees only the task addressed to it)', async () => {
    const D = 'ws-d';
    const E = 'ws-e';
    // task1: FROM → TO          (THIRD is not a party)
    expect(
      publishA2aTask({ type: 'a2a.task', from: FROM, to: TO, taskId: 't1', state: 'submitted', kind: 'created' }),
    ).toBe(true);
    // task2: FROM → THIRD        (THIRD is the `to` — the ONLY one it may see)
    expect(
      publishA2aTask({ type: 'a2a.task', from: FROM, to: THIRD, taskId: 't2', state: 'submitted', kind: 'created' }),
    ).toBe(true);
    // task3: D → E               (two workspaces unrelated to THIRD)
    expect(
      publishA2aTask({ type: 'a2a.task', from: D, to: E, taskId: 't3', state: 'submitted', kind: 'created' }),
    ).toBe(true);

    const router = setupRouter();
    const events = await pollEvents(router, { workspaceId: THIRD });
    const a2a = events.filter((e) => e.type === 'a2a.task') as A2aTaskEvent[];
    // Exactly task2 — and proven by identity, not just count: every delivered
    // event is the FROM→THIRD pair. task1 (FROM→TO) and task3 (D→E) are absent.
    expect(a2a).toHaveLength(1);
    expect(a2a[0].taskId).toBe('t2');
    expect(a2a[0].from).toBe(FROM);
    expect(a2a[0].to).toBe(THIRD);
    // Belt-and-suspenders: NONE of the foreign pairs leaked in.
    expect(a2a.some((e) => e.taskId === 't1')).toBe(false);
    expect(a2a.some((e) => e.taskId === 't3')).toBe(false);
  });

  // Test B — max-truncation cursor correctness. A regression that "fixes"
  // throughput by recomputing nextCursor AFTER the post-filter could rewind
  // the cursor (the post-filter strips foreign events, so the last *delivered*
  // event sits behind the last *scanned* one). Rewinding risks either a
  // re-delivery loop or — if combined with `max` truncation — a permanent miss
  // of the one event the poller actually wants. We seed N foreign-pair events
  // ahead of a single addressed one and page through with max:1, threading the
  // server's nextCursor. The poller must (1) never see a foreign event,
  // (2) eventually receive its event, (3) observe a monotonic (never-rewinding)
  // cursor, and (4) terminate within a bounded number of polls.
  it('case B: max-truncation pages past foreign a2a.task events without rewinding the cursor or missing the addressed one', async () => {
    const Y = 'ws-y';
    const X = 'ws-x';
    const N = 5;
    // N foreign-pair events the poller (X) must NEVER receive...
    for (let i = 0; i < N; i++) {
      expect(
        publishA2aTask({ type: 'a2a.task', from: 'ws-d', to: 'ws-e', taskId: `f${i}`, state: 'submitted', kind: 'created' }),
      ).toBe(true);
    }
    // ...followed by the ONE event addressed to X (Y → X).
    expect(
      publishA2aTask({ type: 'a2a.task', from: Y, to: X, taskId: 'addressed', state: 'submitted', kind: 'created' }),
    ).toBe(true);

    const router = setupRouter();
    let cursor = 0;
    let prevCursor = 0;
    let sawAddressed = false;
    const maxIterations = N + 3; // bound the loop; fail loudly if X never gets its event
    let iterations = 0;

    for (; iterations < maxIterations; iterations++) {
      const res = await router.dispatch({
        id: `B${iterations}`,
        method: 'events.poll',
        params: { workspaceId: X, max: 1, cursor },
      }, { firstParty: true });
      expect(res.ok).toBe(true);
      if (!res.ok) break;
      const result = res.result as {
        events: A2aTaskEvent[];
        nextCursor: number;
      };

      // (1) A foreign D→E event must NEVER be delivered to X.
      for (const e of result.events) {
        if (e.type === 'a2a.task') {
          expect(e.to).toBe(X);
          expect(e.taskId).toBe('addressed');
          sawAddressed = true;
        }
      }

      // (3) Cursor is strictly non-decreasing across polls — it never rewinds.
      expect(result.nextCursor).toBeGreaterThanOrEqual(prevCursor);
      prevCursor = result.nextCursor;

      // Termination guard against a stuck cursor: if the page is empty AND the
      // cursor stopped advancing, we have drained the ring — stop looping.
      if (result.events.length === 0 && result.nextCursor === cursor) {
        cursor = result.nextCursor;
        break;
      }
      cursor = result.nextCursor;
      if (sawAddressed) break; // (2) got it — no reason to keep paging
    }

    // (2) X eventually received its single addressed event...
    expect(sawAddressed).toBe(true);
    // (4) ...within the bound (the loop did not exhaust its iteration budget,
    // which would signal a stuck/rewinding cursor that never makes progress).
    expect(iterations).toBeLessThan(maxIterations);
  });

  // Test B2 — the EFFICIENCY lock for the post-filter `max` placement (Codex
  // PR #232 review). Foreign events ahead of the addressed one must NOT consume
  // a scoped subscriber's page budget: a `max:1` poll has to return the
  // addressed event in a SINGLE round trip, not after one empty poll per
  // foreign event. (Before the fix, `max` was handed to EventBus pre-scope, so
  // each foreign event filled and emptied the page — costing one extra poll
  // apiece. case B tolerated that; this case forbids it.)
  it('case B2: foreign a2a.task events do not consume a scoped subscriber max budget (one poll, not N+1)', async () => {
    const Y = 'ws-y';
    const X = 'ws-x';
    const N = 5;
    for (let i = 0; i < N; i++) {
      expect(
        publishA2aTask({ type: 'a2a.task', from: 'ws-d', to: 'ws-e', taskId: `f${i}`, state: 'submitted', kind: 'created' }),
      ).toBe(true);
    }
    expect(
      publishA2aTask({ type: 'a2a.task', from: Y, to: X, taskId: 'addressed', state: 'submitted', kind: 'created' }),
    ).toBe(true);

    const router = setupRouter();
    const res = await router.dispatch({
      id: 'B2', method: 'events.poll', params: { workspaceId: X, max: 1, cursor: 0 },
    }, { firstParty: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const result = res.result as { events: A2aTaskEvent[] };
    // ONE poll yields exactly the addressed event — the 5 foreign events ahead
    // of it did not each cost an empty page.
    expect(result.events).toHaveLength(1);
    expect(result.events[0].taskId).toBe('addressed');
    expect(result.events[0].to).toBe(X);
  });

  // Test B3 — the CORRECTNESS lock for the same change: when the SCOPED page
  // itself exceeds `max`, truncation rewinds nextCursor to the last delivered
  // event so the overflow is DEFERRED to the next page, never dropped. Two
  // events addressed to X (interleaved with foreign pairs) must both arrive
  // across two max:1 polls, in order, exactly once, with no foreign leak.
  it('case B3: scoped overflow past max is deferred to the next page, never skipped or duplicated', async () => {
    const Y = 'ws-y';
    const X = 'ws-x';
    expect(publishA2aTask({ type: 'a2a.task', from: 'ws-d', to: 'ws-e', taskId: 'f0', state: 'submitted', kind: 'created' })).toBe(true);
    expect(publishA2aTask({ type: 'a2a.task', from: Y, to: X, taskId: 'a1', state: 'submitted', kind: 'created' })).toBe(true);
    expect(publishA2aTask({ type: 'a2a.task', from: 'ws-d', to: 'ws-e', taskId: 'f1', state: 'submitted', kind: 'created' })).toBe(true);
    expect(publishA2aTask({ type: 'a2a.task', from: Y, to: X, taskId: 'a2', state: 'submitted', kind: 'created' })).toBe(true);

    const router = setupRouter();
    const seen: string[] = [];
    let cursor = 0;
    for (let i = 0; i < 5; i++) {
      const res = await router.dispatch({
        id: `B3-${i}`, method: 'events.poll', params: { workspaceId: X, max: 1, cursor },
      }, { firstParty: true });
      expect(res.ok).toBe(true);
      if (!res.ok) break;
      const result = res.result as { events: A2aTaskEvent[]; nextCursor: number };
      for (const e of result.events) {
        expect(e.to).toBe(X); // never a foreign leak
        seen.push(e.taskId as string);
      }
      if (result.events.length === 0 && result.nextCursor === cursor) break; // drained
      cursor = result.nextCursor;
      if (seen.length >= 2) break;
    }
    // Both addressed events arrived, in publish order, exactly once.
    expect(seen).toEqual(['a1', 'a2']);
  });

  // Test C — receiver delivery rides the dual-party `to` key, NOT an accidental
  // strict `workspaceId === to` match. The event's BASE workspaceId is stamped
  // === from, so a strict `workspaceId === caller` arm (the non-a2a path) would
  // NEVER match for the receiver. Asserting the delivered event's base
  // workspaceId is FROM (≠ TO, the caller) proves it arrived through the `to`
  // branch specifically — strengthening case 2, which checks `to === TO` but
  // not that the base workspaceId differs from the caller.
  it('case C: receiver gets the event via the dual-party `to` key (delivered base workspaceId === from, not the caller)', async () => {
    expect(
      publishA2aTask({ type: 'a2a.task', from: FROM, to: TO, taskId: 't1', state: 'submitted', kind: 'created' }),
    ).toBe(true);

    const router = setupRouter();
    const events = await pollEvents(router, { workspaceId: TO });
    const a2a = events.filter((e) => e.type === 'a2a.task') as A2aTaskEvent[];
    expect(a2a).toHaveLength(1);
    // The receiver (caller === TO) got it, but the base workspaceId is FROM —
    // a strict `workspaceId === caller` filter could not have matched it. The
    // ONLY path that delivers it is the dual-party `to === caller` arm.
    expect(a2a[0].workspaceId).toBe(FROM);
    expect(a2a[0].workspaceId).not.toBe(TO);
    expect(a2a[0].to).toBe(TO);
  });

  // Publish trust boundary: onEventsPublish (via buildA2aTaskEmitInput) rejects
  // an a2a.task with missing/empty from or to — NO ring entry is created.
  it('onEventsPublish rejects an a2a.task with missing/empty from or to (no ring entry)', async () => {
    // Missing `to`.
    expect(publishA2aTask({ type: 'a2a.task', from: FROM, taskId: 't1', state: 'submitted', kind: 'created' })).toBe(false);
    // Empty `to`.
    expect(publishA2aTask({ type: 'a2a.task', from: FROM, to: '', taskId: 't1', state: 'submitted', kind: 'created' })).toBe(false);
    // Missing `from`.
    expect(publishA2aTask({ type: 'a2a.task', to: TO, taskId: 't1', state: 'submitted', kind: 'created' })).toBe(false);
    // Empty `from`.
    expect(publishA2aTask({ type: 'a2a.task', from: '', to: TO, taskId: 't1', state: 'submitted', kind: 'created' })).toBe(false);
    // Missing taskId is also rejected (scope key must be well-formed).
    expect(publishA2aTask({ type: 'a2a.task', from: FROM, to: TO, state: 'submitted', kind: 'created' })).toBe(false);

    // The ring is empty — none of the rejected publishes created an entry.
    const router = setupRouter();
    const events = await pollEvents(router, { workspaceId: FROM });
    expect(events.filter((e) => e.type === 'a2a.task')).toHaveLength(0);

    // Sanity: a well-formed publish IS accepted and lands a ring entry. The
    // server-side stamp sets workspaceId === from regardless of any supplied
    // workspaceId (here a hostile renderer claims THIRD — it is ignored).
    expect(
      publishA2aTask({
        type: 'a2a.task', from: FROM, to: TO, taskId: 't1', state: 'submitted', kind: 'created',
        workspaceId: THIRD, // hostile override — must be ignored
        extraField: 'should-not-ride-through', // must not be spread onto the event
      }),
    ).toBe(true);
    const after = await pollEvents(setupRouter(), { workspaceId: FROM });
    const a2a = after.filter((e) => e.type === 'a2a.task');
    expect(a2a).toHaveLength(1);
    expect((a2a[0] as A2aTaskEvent).workspaceId).toBe(FROM); // stamped, not THIRD
    expect((a2a[0] as unknown as Record<string, unknown>)['extraField']).toBeUndefined();
  });
});

// §6.M PR-C: the publish trust boundary must let a well-formed verifiedItemCount
// grade cross while dropping forged/malformed values. Without this, the renderer
// could emit the field but the server would silently strip it — the event poller
// could never distinguish an unverified completion (count 0) from a verified one.
describe('events.rpc — a2a.task verifiedItemCount allow-list (§6.M PR-C)', () => {
  const FROM = 'ws-sender';
  const TO = 'ws-receiver';
  const base = { type: 'a2a.task', from: FROM, to: TO, taskId: 't1', state: 'completed', kind: 'updated' };

  beforeEach(() => {
    eventBus.reset();
  });

  it('a non-negative integer rides through onto the emit shape', () => {
    expect(buildA2aTaskEmitInput({ ...base, verifiedItemCount: 3 })?.['verifiedItemCount']).toBe(3);
  });

  it('0 is a meaningful grade (unverified completion) and is NOT dropped', () => {
    // 0 distinguishes an unverified completion from an absent field — it must survive.
    expect(buildA2aTaskEmitInput({ ...base, verifiedItemCount: 0 })?.['verifiedItemCount']).toBe(0);
  });

  it('forged / malformed values are dropped (string, negative, float, NaN, object, bool, null)', () => {
    for (const bad of ['2', -1, 1.5, Number.NaN, {}, true, null] as unknown[]) {
      const emit = buildA2aTaskEmitInput({ ...base, verifiedItemCount: bad });
      // The publish itself still succeeds (other fields well-formed) — only the
      // bad grade is stripped, never coerced.
      expect(emit).not.toBeNull();
      expect(emit as Record<string, unknown>).not.toHaveProperty('verifiedItemCount');
    }
  });

  it('absent verifiedItemCount → field omitted (created pointer carries no grade)', () => {
    const emit = buildA2aTaskEmitInput({ type: 'a2a.task', from: FROM, to: TO, taskId: 't1', state: 'submitted', kind: 'created' });
    expect(emit).not.toBeNull();
    expect(emit as Record<string, unknown>).not.toHaveProperty('verifiedItemCount');
  });

  it('end-to-end: a valid count rides through to the polled event for both parties', async () => {
    expect(publishA2aTask({ ...base, verifiedItemCount: 2 })).toBe(true);
    for (const caller of [FROM, TO]) {
      const events = await pollEvents(setupRouter(), { workspaceId: caller });
      const a2a = events.filter((e) => e.type === 'a2a.task') as unknown as Array<Record<string, unknown>>;
      expect(a2a).toHaveLength(1);
      expect(a2a[0]['verifiedItemCount']).toBe(2);
    }
  });
});

describe('events.rpc — notifications.read opt-in gate', () => {
  beforeEach(() => {
    eventBus.reset();
  });

  function emitMixed() {
    eventBus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });
    eventBus.emit({
      type: 'notification.received', workspaceId: 'ws-1', ptyId: 't1',
      source: 'osc9', title: null, body: 'hello',
    });
  }

  function routerWithTrust(declared: string[] | undefined): RpcRouter {
    const router = new RpcRouter();
    registerEventsRpc(router, nullWindow, async (name) =>
      name === 'declared-plugin'
        ? {
            name, status: 'trusted' as const, firstSeen: 1, lastSeen: 1,
            ...(declared ? { declaredCapabilities: declared } : {}),
          }
        : undefined,
    );
    return router;
  }

  it('filters notification.received for a declared plugin without notifications.read', async () => {
    emitMixed();
    const router = routerWithTrust(['events.subscribe']);
    const res = await router.dispatch({
      id: 'n1', method: 'events.poll', params: {}, clientName: 'declared-plugin',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const result = res.result as { events: Array<{ type: string }> };
      expect(result.events.map((e) => e.type)).toEqual(['pane.created']);
    }
  });

  it('delivers notification.received when notifications.read is declared (bare or glob)', async () => {
    for (const cap of ['notifications.read', 'notifications.read:ws-*']) {
      eventBus.reset();
      emitMixed();
      const router = routerWithTrust(['events.subscribe', cap]);
      const res = await router.dispatch({
        id: 'n2', method: 'events.poll', params: {}, clientName: 'declared-plugin',
      });
      if (res.ok) {
        const result = res.result as { events: Array<{ type: string }> };
        expect(result.events.map((e) => e.type)).toEqual(['pane.created', 'notification.received']);
      }
    }
  });

  it('grandfathers callers without a declaration or without an identity envelope', async () => {
    emitMixed();
    const router = routerWithTrust(undefined);
    // Declared identity but no declaredCapabilities → grandfathered.
    const declared = await router.dispatch({
      id: 'n3', method: 'events.poll', params: {}, clientName: 'declared-plugin',
    });
    if (declared.ok) {
      expect((declared.result as { events: unknown[] }).events).toHaveLength(2);
    }
    // No clientName at all → grandfathered.
    const anonymous = await router.dispatch({ id: 'n4', method: 'events.poll', params: {} });
    if (anonymous.ok) {
      expect((anonymous.result as { events: unknown[] }).events).toHaveLength(2);
    }
  });

  it('an explicit notification.received types request returns nothing when unentitled', async () => {
    emitMixed();
    const router = routerWithTrust(['events.subscribe']);
    const res = await router.dispatch({
      id: 'n5', method: 'events.poll',
      params: { types: ['notification.received'] }, clientName: 'declared-plugin',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.result as { events: unknown[] }).events).toHaveLength(0);
    }
  });
});

// ─── FIX-MULTI-WS — `workspaceIds` union scoping ─────────────────────────────
//
// A multi-workspace renderer polls ONCE with every LOCAL workspace id; the
// daemon filters by set membership. The core case this exists for: a
// channel.message whose recipients include a BACKGROUND workspace must reach
// the poll while the caller's base `workspaceId` is a different (active)
// workspace — the single-id filter silently dropped those, so a mention of a
// pane in an unfocused workspace never delivered until the user switched.
describe('events.rpc — workspaceIds union scoping (FIX-MULTI-WS)', () => {
  beforeEach(() => {
    eventBus.reset();
  });

  /** Minimal channel.message emit — only the fields the poll filter reads
   *  (type / workspaceId / recipientWorkspaceIds) matter here; the embedded
   *  message payload is opaque to events.rpc. */
  function emitChannelMessage(senderWs: string, recipients: string[]): void {
    eventBus.emit({
      type: 'channel.message',
      workspaceId: senderWs,
      channelId: 'ch-1',
      seq: 1,
      senderWorkspaceId: senderWs,
      recipientWorkspaceIds: recipients,
      message: {} as never,
    } as never);
  }

  function emitChannelCatalog(actorWs: string, recipients: string[]): void {
    eventBus.emit({
      type: 'channel.catalog',
      workspaceId: actorWs,
      channelId: 'ch-1',
      actorWorkspaceId: actorWs,
      recipientWorkspaceIds: recipients,
      reason: 'membership',
    } as never);
  }

  it('delivers a channel.message addressed to a BACKGROUND workspace in the union (the P1 case)', async () => {
    // Sender ws-C posts to a channel whose members include ws-B. The renderer
    // is viewing ws-A but polls the union [ws-A, ws-B].
    emitChannelMessage('ws-C', ['ws-B', 'ws-C']);
    const router = setupRouter();
    const events = await pollEvents(router, {
      workspaceId: 'ws-A',
      workspaceIds: ['ws-A', 'ws-B'],
      types: ['channel.message'],
    });
    expect(events).toHaveLength(1);
  });

  it('WAKES a parked poll on a channel.message it is only a RECIPIENT of', async () => {
    // The wake pre-filter narrows by workspace so a parked poll is not woken by
    // every workspace's traffic. It must not narrow the PRIVATE types the same
    // way: a channel.message carries the SENDER in `workspaceId`, and the
    // membership lives in `recipientWorkspaceIds`. Testing the base id against
    // the caller's scope would skip this wake — and the event is already in the
    // ring by then, so nothing re-announces it and the poll burns its whole
    // budget before returning a page it should have had at once.
    const router = setupRouter();
    const pending = router.dispatch(
      {
        id: 'recipient-wake',
        method: 'events.poll',
        params: { workspaceId: 'ws-B', blockMs: 5_000, types: ['channel.message'] },
      },
      { firstParty: true },
    );
    // ws-C posts; ws-B is only a member, never the base workspaceId.
    setTimeout(() => emitChannelMessage('ws-C', ['ws-B', 'ws-C']), 20);
    const res = await pending;
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.result as { events: unknown[]; parked?: boolean };
      expect(r.events).toHaveLength(1);
      expect(r.parked).toBe(true);
    }
  });

  it('drops a channel.message with NO overlap against the union (third-party leak guard)', async () => {
    emitChannelMessage('ws-C', ['ws-C', 'ws-D']);
    const router = setupRouter();
    const events = await pollEvents(router, {
      workspaceId: 'ws-A',
      workspaceIds: ['ws-A', 'ws-B'],
      types: ['channel.message'],
    });
    expect(events).toHaveLength(0);
  });

  it('single workspaceId behavior is unchanged (back-compat, no workspaceIds param)', async () => {
    emitChannelMessage('ws-C', ['ws-B', 'ws-C']);
    const router = setupRouter();
    const asRecipient = await pollEvents(router, { workspaceId: 'ws-B', types: ['channel.message'] });
    expect(asRecipient).toHaveLength(1);
    const asThirdParty = await pollEvents(router, { workspaceId: 'ws-A', types: ['channel.message'] });
    expect(asThirdParty).toHaveLength(0);
  });

  it('an unscoped poll (neither workspaceId nor workspaceIds) still receives ZERO channel events', async () => {
    emitChannelMessage('ws-C', ['ws-B']);
    emitChannelCatalog('ws-C', ['ws-B']);
    const router = setupRouter();
    const events = await pollEvents(router, { types: ['channel.message', 'channel.catalog'] });
    expect(events).toHaveLength(0);
  });

  it('strict-scope types (agent.lifecycle et al.) match ANY workspace in the union, and only those', async () => {
    eventBus.emit({ type: 'pane.created', workspaceId: 'ws-A', paneId: 'pA' });
    eventBus.emit({ type: 'pane.created', workspaceId: 'ws-B', paneId: 'pB' });
    eventBus.emit({ type: 'pane.created', workspaceId: 'ws-C', paneId: 'pC' });
    const router = setupRouter();
    const events = await pollEvents(router, {
      workspaceId: 'ws-A',
      workspaceIds: ['ws-A', 'ws-B'],
    });
    expect(events).toHaveLength(2);
  });

  it('a2a.task dual-party scoping matches against the union (background receiver)', async () => {
    publishA2aTask({
      taskId: 'task-1',
      from: 'ws-C',
      to: 'ws-B',
      kind: 'created',
      state: 'submitted',
    });
    const router = setupRouter();
    const events = await pollEvents(router, {
      workspaceId: 'ws-A',
      workspaceIds: ['ws-A', 'ws-B'],
      types: ['a2a.task'],
    });
    expect(events).toHaveLength(1);
    const foreign = await pollEvents(router, {
      workspaceId: 'ws-A',
      workspaceIds: ['ws-A', 'ws-D'],
      types: ['a2a.task'],
    });
    expect(foreign).toHaveLength(0);
  });

  it('channel.catalog matches the union, including the "*" public broadcast sentinel', async () => {
    emitChannelCatalog('ws-C', ['ws-B']);
    emitChannelCatalog('ws-C', ['*']);
    const router = setupRouter();
    const events = await pollEvents(router, {
      workspaceId: 'ws-A',
      workspaceIds: ['ws-A', 'ws-B'],
      types: ['channel.catalog'],
    });
    expect(events).toHaveLength(2);
    // Union with no catalog overlap: only the '*' broadcast remains visible.
    const noOverlap = await pollEvents(router, {
      workspaceId: 'ws-D',
      types: ['channel.catalog'],
    });
    expect(noOverlap).toHaveLength(1);
  });

  it('ignores malformed workspaceIds entries (non-string / empty) instead of widening scope', async () => {
    emitChannelMessage('ws-C', ['ws-B']);
    const router = setupRouter();
    // Malformed entries dropped → effective scope is just ws-A → no delivery.
    const events = await pollEvents(router, {
      workspaceId: 'ws-A',
      workspaceIds: [42, '', null, { ws: 'ws-B' }],
      types: ['channel.message'],
    });
    expect(events).toHaveLength(0);
  });
});

// === Agent transport identity scoping (audit B3) ===
//
// The confidentiality-sensitive PRIVATE types (a2a.task, channel.*) must be
// scoped to the caller's SERVER-RESOLVED workspace for an agent transport (any
// events.poll NOT dispatched with `firstParty`), NOT the caller-supplied
// `workspaceId` — a same-user pipe client could otherwise eavesdrop on any
// workspace's channels by naming its id (B3). Identity is resolved from a
// verified senderPtyId via the renderer bridge (input.findOwnerWorkspace).
// LIFECYCLE types keep honoring the caller-supplied scope: their all-workspace
// firehose is already reachable by any unscoped events.subscribe caller, so it
// is a convenience filter, not a boundary.
describe('events.rpc — agent transport identity scoping (audit B3)', () => {
  const VICTIM = 'ws-victim';

  beforeEach(() => {
    eventBus.reset();
    // Reset call history (vitest is not configured to auto-clear) so the
    // first-party "resolver never consulted" assertion sees only this test's calls.
    // senderPtyId 'pty-<x>' resolves to owning workspace 'ws-<x>'. An absent or
    // unknown ptyId resolves to null (no verifiable identity → fail closed).
    vi.mocked(sendToRenderer).mockReset();
    vi.mocked(sendToRenderer).mockImplementation((async (_gw: unknown, method: string, params: unknown) => {
      if (method === 'input.findOwnerWorkspace') {
        const pty = (params as Record<string, unknown> | null)?.ptyId;
        return typeof pty === 'string' && pty.startsWith('pty-')
          ? { workspaceId: `ws-${pty.slice('pty-'.length)}` }
          : null;
      }
      return null;
    }) as unknown as typeof sendToRenderer);
  });

  function emitChannelMessage(senderWs: string, recipients: string[], channelId = 'ch-1'): void {
    eventBus.emit({
      type: 'channel.message', workspaceId: senderWs, channelId, seq: 1,
      senderWorkspaceId: senderWs, recipientWorkspaceIds: recipients, message: {} as never,
    } as never);
  }

  /** Agent-transport poll — dispatched WITHOUT firstParty (the wire path). */
  async function agentPoll(
    router: RpcRouter,
    params: Record<string, unknown>,
  ): Promise<Array<{ type: string; taskId?: string }>> {
    const res = await router.dispatch({ id: 'agent', method: 'events.poll', params });
    if (!res.ok) throw new Error('poll dispatch failed');
    return (res.result as { events: Array<{ type: string; taskId?: string }> }).events;
  }

  it('scopes channel.message to the senderPtyId-resolved workspace, IGNORING a forged workspaceId (B3 core)', async () => {
    // A private channel between VICTIM and a peer; the attacker is NOT a member.
    emitChannelMessage(VICTIM, [VICTIM, 'ws-peer'], 'ch-victim');
    const router = setupRouter();
    // The attacker's MCP resolves to ws-attacker, but it FORGES workspaceId=VICTIM.
    const events = await agentPoll(router, {
      workspaceId: VICTIM, senderPtyId: 'pty-attacker', types: ['channel.message'],
    });
    // The forged workspaceId is ignored; scope is the resolved ws-attacker (not a
    // member) → zero leak.
    expect(events).toHaveLength(0);
  });

  it('delivers a channel.message to the senderPtyId-resolved member workspace (no workspaceId param needed)', async () => {
    emitChannelMessage('ws-peer', ['ws-peer', 'ws-member']);
    const router = setupRouter();
    const events = await agentPoll(router, { senderPtyId: 'pty-member', types: ['channel.message'] });
    expect(events).toHaveLength(1);
  });

  it('scopes a2a.task dual-party to the resolved workspace, ignoring a forged workspaceId', async () => {
    publishA2aTask({ type: 'a2a.task', from: VICTIM, to: 'ws-peer', taskId: 'tv', state: 'submitted', kind: 'created' });
    publishA2aTask({ type: 'a2a.task', from: 'ws-peer', to: 'ws-agent', taskId: 'ta', state: 'submitted', kind: 'created' });
    const router = setupRouter();
    const events = await agentPoll(router, { workspaceId: VICTIM, senderPtyId: 'pty-agent', types: ['a2a.task'] });
    const a2a = events.filter((e) => e.type === 'a2a.task');
    // Only the task addressed to the RESOLVED ws-agent — the forged VICTIM scope
    // never surfaces VICTIM's task.
    expect(a2a).toHaveLength(1);
    expect(a2a[0].taskId).toBe('ta');
  });

  it('fails closed on an unresolvable identity: private types dropped even with a workspaceId', async () => {
    emitChannelMessage(VICTIM, [VICTIM]);
    publishA2aTask({ type: 'a2a.task', from: VICTIM, to: 'ws-peer', taskId: 'tv', state: 'submitted', kind: 'created' });
    const router = setupRouter();
    // No senderPtyId (with a forged workspaceId) → no resolvable identity → every
    // private event withheld.
    const noPty = await agentPoll(router, { workspaceId: VICTIM, types: ['channel.message', 'a2a.task'] });
    expect(noPty).toHaveLength(0);
    // An unknown ptyId (renderer resolves null) fails closed the same way.
    const badPty = await agentPoll(router, { workspaceId: VICTIM, senderPtyId: 'unknown-pty', types: ['channel.message'] });
    expect(badPty).toHaveLength(0);
  });

  it('still delivers LIFECYCLE events scoped by the caller-supplied workspaceId (not a confidentiality boundary)', async () => {
    eventBus.emit({ type: 'pane.created', workspaceId: 'ws-agent', paneId: 'p1' });
    eventBus.emit({ type: 'pane.created', workspaceId: VICTIM, paneId: 'p2' });
    const router = setupRouter();
    const own = await agentPoll(router, { workspaceId: 'ws-agent', senderPtyId: 'pty-agent', types: ['pane.created'] });
    expect(own).toHaveLength(1);
  });

  it('a first-party operator poll STILL trusts the caller-supplied workspaceId for private types (operator model preserved)', async () => {
    emitChannelMessage(VICTIM, [VICTIM]);
    const router = setupRouter();
    // firstParty=true (renderer / plugin host) → the operator legitimately scopes
    // to any local workspace by id; no senderPtyId is needed or consulted.
    const res = await router.dispatch(
      { id: 'fp', method: 'events.poll', params: { workspaceId: VICTIM, types: ['channel.message'] } },
      { firstParty: true },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.result as { events: unknown[] }).events).toHaveLength(1);
    // And the resolver was never consulted on the first-party path.
    expect(vi.mocked(sendToRenderer)).not.toHaveBeenCalled();
  });
});

/**
 * Optional blocking poll (`blockMs`) + pane/kind narrowing.
 *
 * This is the primitive that replaces an orchestrator's `terminal_read` loop:
 * "wait until this pane blocks, then read the question". The properties that
 * matter are all about NOT losing an event:
 *
 *   - a caller that never passes `blockMs` must behave exactly as before;
 *   - an event already in the ring must answer immediately (a park that waits
 *     for the NEXT event after the one it was looking for is a lost wakeup);
 *   - a wake caused by unrelated traffic must not end the wait early with an
 *     empty page, or the caller is back to polling;
 *   - an attempt that matches nothing must not advance the cursor.
 */
describe('events.rpc — events.poll blocking', () => {
  beforeEach(() => {
    eventBus.reset();
  });

  const lifecycle = (ptyId: string, kind: string) => ({
    type: 'agent.lifecycle' as const,
    workspaceId: 'ws-1',
    ptyId,
    kind,
    agent: 'claude',
    source: 'hook',
  });

  it('returns immediately when the ring already has a match (no park)', async () => {
    eventBus.emit(lifecycle('pty-1', 'agent.awaiting_input'));
    const router = setupRouter();
    const started = Date.now();
    const res = await router.dispatch(
      { id: 'b1', method: 'events.poll', params: { blockMs: 5_000, ptyId: 'pty-1' } },
      { firstParty: true },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.result as { events: unknown[]; parked?: boolean };
      expect(r.events).toHaveLength(1);
      expect(r.parked).toBeUndefined(); // took the immediate path
    }
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('parks, then wakes on a matching event emitted later', async () => {
    const router = setupRouter();
    const pending = router.dispatch(
      { id: 'b2', method: 'events.poll', params: { blockMs: 5_000, ptyId: 'pty-1' } },
      { firstParty: true },
    );
    // Emitted AFTER the poll is already parked.
    setTimeout(() => eventBus.emit(lifecycle('pty-1', 'agent.awaiting_input')), 20);
    const res = await pending;
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.result as { events: Array<{ ptyId: string }>; parked?: boolean };
      expect(r.events).toHaveLength(1);
      expect(r.events[0].ptyId).toBe('pty-1');
      expect(r.parked).toBe(true);
    }
  });

  it('keeps waiting when the wake was another pane\'s traffic', async () => {
    const router = setupRouter();
    const pending = router.dispatch(
      { id: 'b3', method: 'events.poll', params: { blockMs: 5_000, ptyId: 'pty-1' } },
      { firstParty: true },
    );
    // Unrelated pane wakes the bus hook first; the poll must NOT return empty.
    setTimeout(() => eventBus.emit(lifecycle('pty-2', 'agent.stop')), 10);
    setTimeout(() => eventBus.emit(lifecycle('pty-1', 'agent.stop')), 40);
    const res = await pending;
    if (res.ok) {
      const r = res.result as { events: Array<{ ptyId: string }> };
      expect(r.events).toHaveLength(1);
      expect(r.events[0].ptyId).toBe('pty-1');
    }
  });

  /**
   * The cursor advances past events the caller's OWN filter skipped, and that
   * is the documented contract, not an oversight — one cursor chain per filter
   * combination.
   *
   * Rewinding is the obvious "fix" and does not work. Rewinding to the last
   * delivered event still steps over non-matches interleaved before it (deliver
   * seq 1 and 3, land on 3, seq 2 is gone regardless). Rewinding to the first
   * dropped event is lossless but lets any other pane's traffic pin the cursor,
   * so the caller re-receives its own matches forever. A scalar cursor cannot
   * mean two filters at once. This test exists so the next person to notice the
   * gap finds the reasoning instead of re-deriving the broken fix.
   */
  it('advances the cursor past filtered-out events (one cursor per filter)', async () => {
    eventBus.emit(lifecycle('pty-2', 'agent.stop'));
    const router = setupRouter();
    const res = await router.dispatch(
      { id: 'b4', method: 'events.poll', params: { blockMs: 60, ptyId: 'pty-1', cursor: 0 } },
      { firstParty: true },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.result as { events: unknown[]; nextCursor: number; parked?: boolean };
      expect(r.events).toHaveLength(0);
      expect(r.parked).toBe(true);
      // Scanned, not delivered — the caller resumes after it.
      expect(r.nextCursor).toBe(1);
    }

    // The other pane's event is still reachable from ITS OWN cursor chain,
    // which is what the tool description tells callers to keep.
    const viaOwnChain = await pollEvents(router, { cursor: 0, ptyId: 'pty-2' });
    expect(viaOwnChain).toHaveLength(1);
  });

  it('narrows agent.lifecycle by kind, and leaves other types alone', async () => {
    eventBus.emit(lifecycle('pty-1', 'agent.stop'));
    eventBus.emit(lifecycle('pty-1', 'agent.awaiting_input'));
    eventBus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });

    const router = setupRouter();
    const events = await pollEvents(router, { kinds: ['agent.awaiting_input'] });
    // the non-matching lifecycle is dropped; the unrelated type passes through
    expect(events.map((e) => e.kind ?? e.type)).toEqual(['agent.awaiting_input', 'pane.created']);
  });

  it('accepts agent.stop_failure as a kind — a turn that died is still a match', async () => {
    eventBus.emit(lifecycle('pty-1', 'agent.stop'));
    eventBus.emit(lifecycle('pty-1', 'agent.stop_failure'));

    const router = setupRouter();
    const events = await pollEvents(router, { kinds: ['agent.stop_failure'] });
    expect(events.map((e) => e.kind)).toEqual(['agent.stop_failure']);
  });

  it('drops events that carry no ptyId when a pane is named', async () => {
    eventBus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });
    eventBus.emit(lifecycle('pty-1', 'agent.stop'));

    const router = setupRouter();
    const events = await pollEvents(router, { ptyId: 'pty-1' });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('agent.stop');
  });

  it('blockMs is clamped and a missing/zero value keeps the immediate path', async () => {
    const router = setupRouter();
    const started = Date.now();
    // blockMs:0 and a negative value must both return at once on an empty ring.
    for (const blockMs of [0, -5]) {
      const res = await router.dispatch(
        { id: `b7-${blockMs}`, method: 'events.poll', params: { blockMs } },
        { firstParty: true },
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect((res.result as { parked?: boolean }).parked).toBeUndefined();
    }
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

/**
 * The shape an orchestrator actually calls — the flow this whole feature
 * exists to replace. Worth its own tests because the parts pass individually
 * and can still fail together: the escape-hatch types have no ptyId semantics
 * in common with agent.lifecycle, and `kinds` must not drop them.
 */
describe('events.rpc — the orchestrator wait shape', () => {
  beforeEach(() => {
    eventBus.reset();
  });

  const ORCHESTRATOR_CALL = {
    blockMs: 5_000,
    ptyId: 'pty-worker',
    types: ['agent.lifecycle', 'pane.closed', 'process.exited'],
    kinds: ['agent.awaiting_input', 'agent.stop'],
  };

  it('wakes on the worker blocking for input, and ignores its subagent noise', async () => {
    const router = setupRouter();
    const pending = router.dispatch(
      { id: 'e1', method: 'events.poll', params: ORCHESTRATOR_CALL },
      { firstParty: true },
    );
    // A nested subagent returning is NOT the pane blocking — it is the exact
    // signal that revived idle panes in the field (#733 family), so a wait
    // filtered to stop/awaiting_input must sit through it.
    setTimeout(() => eventBus.emit({
      type: 'agent.lifecycle', workspaceId: 'ws-1', ptyId: 'pty-worker',
      kind: 'agent.subagent_stop', agent: 'claude', source: 'hook',
    }), 10);
    setTimeout(() => eventBus.emit({
      type: 'agent.lifecycle', workspaceId: 'ws-1', ptyId: 'pty-worker',
      kind: 'agent.awaiting_input', agent: 'claude', source: 'hook',
    }), 40);

    const res = await pending;
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.result as { events: Array<{ kind: string }> };
      expect(r.events.map((e) => e.kind)).toEqual(['agent.awaiting_input']);
    }
  });

  it('ends the wait when the pane dies instead of burning the full budget', async () => {
    const router = setupRouter();
    const started = Date.now();
    const pending = router.dispatch(
      { id: 'e2', method: 'events.poll', params: ORCHESTRATOR_CALL },
      { firstParty: true },
    );
    // The documented escape hatch: without process.exited in `types`, a wait on
    // a pane that just died runs to the full blockMs and reports nothing —
    // indistinguishable from an agent that is simply still working.
    setTimeout(() => eventBus.emit({
      type: 'process.exited', workspaceId: 'ws-1', ptyId: 'pty-worker', exitCode: 1,
    }), 20);

    const res = await pending;
    if (res.ok) {
      const r = res.result as { events: Array<{ type: string }> };
      expect(r.events.map((e) => e.type)).toEqual(['process.exited']);
    }
    // returned on the event, not on the 5s budget
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

/**
 * Regressions from the 3-way review of this feature. Each was invisible with a
 * single waiter and only appears once a fleet parks in parallel — which is the
 * whole point of the feature, so none would have surfaced in a casual dogfood.
 */
describe('events.rpc — blocking poll, review regressions', () => {
  beforeEach(() => {
    eventBus.reset();
  });

  const lifecycle = (ptyId: string, kind: string) => ({
    type: 'agent.lifecycle' as const,
    workspaceId: 'ws-1',
    ptyId,
    kind,
    agent: 'claude',
    source: 'hook',
  });

  it('one waking poll does not steal the wake from another', async () => {
    // EventBus fans out with for..of over its subscriber array, so a subscriber
    // that removes itself mid-fanout shifts the array and the iterator skips the
    // NEXT one. With a synchronous unsubscribe the second parked poll never saw
    // the event that woke the first, and sat until its own deadline with its
    // answer already sitting in the ring.
    const router = setupRouter();
    const a = router.dispatch(
      { id: 'r1a', method: 'events.poll', params: { blockMs: 4_000, ptyId: 'pty-a' } },
      { firstParty: true },
    );
    const b = router.dispatch(
      { id: 'r1b', method: 'events.poll', params: { blockMs: 4_000, ptyId: 'pty-b' } },
      { firstParty: true },
    );
    // ONE emit stack, both panes: A is registered first and wakes first.
    setTimeout(() => {
      eventBus.emit(lifecycle('pty-a', 'agent.stop'));
      eventBus.emit(lifecycle('pty-b', 'agent.stop'));
    }, 15);

    const started = Date.now();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok && rb.ok).toBe(true);
    if (ra.ok && rb.ok) {
      expect((ra.result as { events: unknown[] }).events).toHaveLength(1);
      expect((rb.result as { events: unknown[] }).events).toHaveLength(1);
    }
    // Both returned on the event, not on the 4s budget.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('returns at once on resync instead of parking on a dead cursor', async () => {
    // A cursor past the ring window means events this caller never saw are
    // already gone. Waiting cannot bring them back, and every extra minute
    // slides more history out — the caller has to reconcile now.
    eventBus.emit(lifecycle('pty-1', 'agent.stop'));
    const router = setupRouter();
    const started = Date.now();
    const res = await router.dispatch(
      { id: 'r2', method: 'events.poll', params: { blockMs: 5_000, cursor: 999_999, ptyId: 'pty-1' } },
      { firstParty: true },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.result as { resync?: boolean }).resync).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('treats an empty kinds array as no filter, like an empty types array', async () => {
    // An empty Set is truthy, so `kinds: []` used to mean "drop every
    // agent.lifecycle" while `types: []` means "no filter" on the same call.
    eventBus.emit(lifecycle('pty-1', 'agent.stop'));
    const router = setupRouter();
    const events = await pollEvents(router, { kinds: [] });
    expect(events).toHaveLength(1);
  });

  it('caps parked polls well under the pipe server connection budget', async () => {
    // A parked poll holds a connection for its whole wait. Sized independently
    // of MAX_CONNECTIONS it can exhaust the server, and every OTHER MCP tool
    // then fails with what the client reports as "wmux is not running".
    const { MAX_PIPE_CONNECTIONS } = await import('../../PipeServer');
    // The cap must leave the majority of the budget for ordinary
    // connect -> send -> close traffic.
    expect(Math.floor(MAX_PIPE_CONNECTIONS / 4)).toBeLessThan(MAX_PIPE_CONNECTIONS / 2);
  });

  it('parks up to the cap and refuses to park past it', async () => {
    // The arithmetic above says the cap is SIZED sanely. It does not say the
    // cap is ENFORCED — delete the counter and it still passes. This does:
    // fill every slot, then show the next caller is turned away immediately
    // instead of queueing behind them, which is the whole back-pressure story.
    const { MAX_PIPE_CONNECTIONS } = await import('../../PipeServer');
    const cap = Math.floor(MAX_PIPE_CONNECTIONS / 4);
    const router = setupRouter();

    const parked = Array.from({ length: cap }, (_, i) => router.dispatch(
      { id: `cap-${i}`, method: 'events.poll', params: { blockMs: 5_000, ptyId: `pty-park-${i}` } },
      { firstParty: true },
    ));
    // Let every one of them reach the park (they only occupy a slot once the
    // handler has run its immediate collect and decided to wait).
    await new Promise((r) => setTimeout(r, 30));

    const overflow = await router.dispatch(
      { id: 'cap-over', method: 'events.poll', params: { blockMs: 5_000, ptyId: 'pty-overflow' } },
      { firstParty: true },
    );
    expect(overflow.ok).toBe(true);
    if (overflow.ok) {
      const r = overflow.result as { parked?: boolean; parkedCapReached?: boolean };
      expect(r.parkedCapReached).toBe(true);
      expect(r.parked).toBe(false);
    }

    // The parked ones are still parked — the overflow answer did not disturb
    // them — and each still wakes on its own pane.
    for (let i = 0; i < cap; i++) {
      eventBus.emit(lifecycle(`pty-park-${i}`, 'agent.stop'));
    }
    const settled = await Promise.all(parked);
    for (const res of settled) {
      expect(res.ok).toBe(true);
      if (res.ok) {
        const r = res.result as { parked?: boolean; parkedCapReached?: boolean };
        expect(r.parked).toBe(true);
        expect(r.parkedCapReached).toBeUndefined();
      }
    }

    // And the slots are given back, so the next caller can park again.
    const after = router.dispatch(
      { id: 'cap-after', method: 'events.poll', params: { blockMs: 5_000, ptyId: 'pty-after' } },
      { firstParty: true },
    );
    await new Promise((r) => setTimeout(r, 20));
    eventBus.emit(lifecycle('pty-after', 'agent.stop'));
    const afterRes = await after;
    if (afterRes.ok) {
      const r = afterRes.result as { parked?: boolean; parkedCapReached?: boolean };
      expect(r.parkedCapReached).toBeUndefined();
      expect(r.parked).toBe(true);
    }
  });
});

/**
 * Cancellation. A parked poll holds one of the pipe server's finite connection
 * slots for its whole wait, so a client that times out, is cancelled, or
 * crashes must not keep that slot until the handler's own deadline — enough of
 * those and the server stops accepting, which every other caller reads as
 * "wmux is not running".
 */
describe('events.rpc — blocking poll cancellation', () => {
  beforeEach(() => {
    eventBus.reset();
  });

  it('returns promptly when the caller goes away mid-park', async () => {
    const router = setupRouter();
    const abort = new AbortController();
    const started = Date.now();
    const pending = router.dispatch(
      { id: 'c1', method: 'events.poll', params: { blockMs: 30_000, ptyId: 'pty-gone' } },
      { firstParty: true, signal: abort.signal },
    );
    setTimeout(() => abort.abort(), 20);

    const res = await pending;
    expect(res.ok).toBe(true);
    // Well inside the 30s budget it would otherwise have burned.
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('does not park at all when the caller is already gone', async () => {
    const router = setupRouter();
    const abort = new AbortController();
    abort.abort();
    const started = Date.now();
    const res = await router.dispatch(
      { id: 'c2', method: 'events.poll', params: { blockMs: 30_000, ptyId: 'pty-gone' } },
      { firstParty: true, signal: abort.signal },
    );
    expect(res.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('still parks normally when no signal is supplied', async () => {
    // In-process surfaces have no socket to lose and pass nothing; absent must
    // read as "not cancellable", not as "already cancelled".
    const router = setupRouter();
    const pending = router.dispatch(
      { id: 'c3', method: 'events.poll', params: { blockMs: 4_000, ptyId: 'pty-x' } },
      { firstParty: true },
    );
    setTimeout(() => eventBus.emit({
      type: 'agent.lifecycle', workspaceId: 'ws-1', ptyId: 'pty-x',
      kind: 'agent.stop', agent: 'claude', source: 'hook',
    }), 20);
    const res = await pending;
    if (res.ok) expect((res.result as { events: unknown[] }).events).toHaveLength(1);
  });
});

// === #922 E — hosted (plugin-host) callers are not the operator ===
//
// The renderer bridge and the plugin host both dispatch first-party, but only
// the renderer is the operator. Before this suite's fix, `privateSet =
// clientSet` keyed on bare firstParty, so an approved plugin could gate
// another workspace's PRIVATE events (a2a.task, channel.*) by naming its id —
// with `events.subscribe`, an ordinary declarable capability. The hosted rule
// mirrors the B3 agent path: caller-supplied workspaceId is IGNORED for
// private types; the scope is the server-derived binding on the context.
describe('events.rpc — #922 hosted caller private-event scope', () => {
  const VICTIM = 'ws-victim';
  const OTHER = 'ws-other';
  const PLUGIN_WS = 'ws-plugin';

  beforeEach(() => {
    eventBus.reset();
  });

  function seed(): void {
    expect(
      publishA2aTask({ type: 'a2a.task', from: VICTIM, to: OTHER, taskId: 'tv', state: 'submitted', kind: 'created' }),
    ).toBe(true);
    expect(
      publishA2aTask({ type: 'a2a.task', from: PLUGIN_WS, to: OTHER, taskId: 'tp', state: 'submitted', kind: 'created' }),
    ).toBe(true);
    // A lifecycle event in the victim workspace — hosted callers keep the
    // every-subscriber lifecycle semantics, so this must stay visible.
    eventBus.emit({ type: 'pane.created', workspaceId: VICTIM, paneId: 'p-v' });
  }

  async function pollAs(
    router: RpcRouter,
    params: Record<string, unknown>,
    opts: { firstParty: true; hostedWorkspace?: string | null },
  ): Promise<Array<{ type: string; from?: string }>> {
    const res = await router.dispatch({ id: 'hp', method: 'events.poll', params }, opts);
    if (!res.ok) throw new Error('poll dispatch failed');
    return (res.result as { events: Array<{ type: string; from?: string }> }).events;
  }

  it("a hosted caller naming the victim workspace gets its OWN events — the claim is ignored", async () => {
    const router = setupRouter();
    seed();
    const events = await pollAs(
      router,
      { cursor: 0, workspaceId: VICTIM, types: ['a2a.task'] },
      { firstParty: true, hostedWorkspace: PLUGIN_WS },
    );
    // The victim's private event is NOT returned; the binding scope is.
    expect(events).toHaveLength(1);
    expect(events[0]?.from).toBe(PLUGIN_WS);
  });

  it("the same poll as the operator still works — the fix distinguishes, not narrows", async () => {
    const router = setupRouter();
    seed();
    const events = await pollAs(router, { cursor: 0, workspaceId: VICTIM, types: ['a2a.task'] }, { firstParty: true });
    expect(events).toHaveLength(1);
    expect(events[0]?.from).toBe(VICTIM);
  });

  it("a hosted caller that names nothing still resolves to its binding", async () => {
    const router = setupRouter();
    seed();
    const own = await pollAs(
      router,
      { cursor: 0, types: ['a2a.task'] },
      { firstParty: true, hostedWorkspace: PLUGIN_WS },
    );
    expect(own).toHaveLength(1);
    expect(own[0]?.from).toBe(PLUGIN_WS);
  });

  it('an UNBOUND hosted caller (null binding) gets private types failed closed, lifecycle intact', async () => {
    const router = setupRouter();
    seed();
    const priv = await pollAs(
      router,
      { cursor: 0, workspaceId: VICTIM, types: ['a2a.task'] },
      { firstParty: true, hostedWorkspace: null },
    );
    expect(priv).toHaveLength(0);
    const lifecycle = await pollAs(
      router,
      { cursor: 0, types: ['pane.created'] },
      { firstParty: true, hostedWorkspace: null },
    );
    expect(lifecycle.some((e) => e.type === 'pane.created')).toBe(true);
  });
});
