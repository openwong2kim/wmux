// Rule 8 — the LEVEL-SNAPSHOT flush (the WP4 heartbeat's missed-judgment safety
// net) and its pure prompt builder. Covers the shared gate stack (decision /
// switch / mode / rate / busy / budget), the edge-fold accounting, the
// busy-drops-snapshot-keeps-edges posture, and the agentStatus→verdict grammar.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CommanderEventCoalescer,
  buildSnapshotPrompt,
  type CoalescerInput,
} from '../CommanderEventCoalescer';
import { type WorkspaceAutonomy } from '../deckAutonomyStore';
import type { FleetSnapshot, FleetSnapshotPane } from '../../../shared/workspaceMirror';

const AUTO_AUTONOMY: WorkspaceAutonomy = {
  mode: 'auto', summarize: true, continueInstruction: true, approvalPress: true,
};
const ASSIST: WorkspaceAutonomy = {
  mode: 'assist', summarize: true, continueInstruction: true, approvalPress: false,
};
const OFF: WorkspaceAutonomy = {
  mode: 'off', summarize: false, continueInstruction: false, approvalPress: false,
};

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const pane = (over: Partial<FleetSnapshotPane> = {}): FleetSnapshotPane => ({
  ptyId: 'ptyA',
  agentName: 'claude',
  agentStatus: 'waiting',
  isActivePane: true,
  ...over,
});

const snap = (panes: FleetSnapshotPane[], ws = 'ws-1'): FleetSnapshot => ({
  workspaceId: ws,
  ts: 1000,
  panes,
});

const budget = { remaining: 3, total: 5 };

// ── pure builder ───────────────────────────────────────────────────────────

describe('buildSnapshotPrompt — untrusted LEVEL block + verdict grammar', () => {
  it('fences as a LEVEL snapshot of CURRENT state and uses state= (never seq=) per pane', () => {
    const p = buildSnapshotPrompt(
      snap([pane({ ptyId: 'ptyA', agentStatus: 'awaiting_input' })]),
      [],
      AUTO_AUTONOMY,
      budget,
    );
    expect(p).toContain('[fleet-snapshot]');
    expect(p).toContain('UNTRUSTED');
    expect(p).toContain('CURRENT state');
    expect(p).toContain('state=awaiting_input');
    expect(p).toContain('pane=ptyA(claude)');
    // A snapshot line is level state, not an event — it carries no seq token.
    expect(p).not.toMatch(/\bseq=/);
    expect(p).toContain('wake-budget: 3/5');
  });

  it('awaiting_input maps to the awaiting verdict, VERIFY-THEN-PRESS with approvalPress on', () => {
    const on = buildSnapshotPrompt(
      snap([pane({ agentStatus: 'awaiting_input' })]),
      [], AUTO_AUTONOMY, budget,
    );
    // Snapshot state is never hook-fresh → always the detector (verify) path.
    expect(on).toContain('VERIFY THEN PRESS');
    expect(on).not.toContain('MAY press the approval per policy');

    const off = buildSnapshotPrompt(
      snap([pane({ agentStatus: 'awaiting_input' })]),
      [], ASSIST, budget,
    );
    expect(off).toContain('NOTIFY ONLY');
  });

  it('waiting also rides the awaiting verdict path (per the snapshot mapping)', () => {
    const p = buildSnapshotPrompt(snap([pane({ agentStatus: 'waiting' })]), [], AUTO_AUTONOMY, budget);
    expect(p).toContain('state=waiting');
    expect(p).toContain('VERIFY THEN PRESS');
  });

  it('complete/error map to the stop verdict, gated by continueInstruction', () => {
    const drive = buildSnapshotPrompt(snap([pane({ agentStatus: 'complete' })]), [], AUTO_AUTONOMY, budget);
    expect(drive).toContain('MAY send ONE follow-up instruction');

    const noDrive = buildSnapshotPrompt(
      snap([pane({ agentStatus: 'error' })]),
      [],
      { ...AUTO_AUTONOMY, continueInstruction: false },
      budget,
    );
    expect(noDrive).toContain('summarize only');
  });

  it('folds real buffered edges in below, with their ORIGINAL edge verdicts (seq lines)', () => {
    const edge = {
      ptyId: 'ptyB', kind: 'pr.ci_failed' as const, source: 'pr' as const,
      agent: null, seq: 9, ts: 9000, detail: { prNumber: 77, url: 'https://x/pull/77' },
    };
    const p = buildSnapshotPrompt(
      snap([pane({ ptyId: 'ptyA', agentStatus: 'awaiting_input' })]),
      [edge],
      AUTO_AUTONOMY,
      budget,
    );
    expect(p).toContain('recent buffered events');
    expect(p).toContain('seq=9');
    expect(p).toContain('kind=ci-failed');
    expect(p).toContain('PR #77');
  });

  it('caps snapshot lines at 20 with a truncation note', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      pane({ ptyId: `pty${i}`, agentStatus: 'awaiting_input' }),
    );
    const p = buildSnapshotPrompt(snap(many), [], AUTO_AUTONOMY, budget);
    expect(p).toContain('+5 more attention panes');
    expect((p.match(/state=/g) ?? []).length).toBe(20);
  });

  it('appends the WP4 fleet tail line when supplied', () => {
    const p = buildSnapshotPrompt(
      snap([pane({ agentStatus: 'awaiting_input' })]),
      [], AUTO_AUTONOMY, budget,
      { fleetTail: 'fleet: 3 running, 1 blocked' },
    );
    expect(p).toContain('fleet: 3 running, 1 blocked');
  });
});

// ── flushSnapshot integration ────────────────────────────────────────────────

interface Harness {
  c: CommanderEventCoalescer;
  prompts: { ws: string; prompt: string }[];
  setBusy: (b: boolean) => void;
  setRunResult: (r: { ok: boolean; code?: string }) => void;
}

function mk(opts: {
  autonomy?: WorkspaceAutonomy;
  loop?: { running: boolean; iterations: number } | null;
  isAutoWakeEnabled?: () => boolean;
  hasPendingDecision?: () => boolean;
  wakeBudget?: number;
  maxWakesPerMin?: number;
} = {}): Harness {
  let busy = false;
  let runResult: { ok: boolean; code?: string } = { ok: true };
  const prompts: { ws: string; prompt: string }[] = [];
  const c = new CommanderEventCoalescer({
    runTurn: async (ws, prompt) => {
      prompts.push({ ws, prompt });
      return runResult;
    },
    isBusy: () => busy,
    getAutonomy: () => opts.autonomy ?? { ...AUTO_AUTONOMY },
    getLoop: () => opts.loop ?? null,
    ...(opts.isAutoWakeEnabled ? { isAutoWakeEnabled: opts.isAutoWakeEnabled } : {}),
    ...(opts.hasPendingDecision ? { hasPendingDecision: opts.hasPendingDecision } : {}),
    debounceMs: 50,
    wakeBudget: opts.wakeBudget ?? 100,
    maxWakesPerMin: opts.maxWakesPerMin ?? 6,
  });
  return {
    c, prompts,
    setBusy: (b) => { busy = b; },
    setRunResult: (r) => { runResult = r; },
  };
}

const awaitingEdge = (seq: number, ptyId = 'ptyE'): CoalescerInput => ({
  workspaceId: 'ws-1', ptyId, kind: 'agent.awaiting_input', source: 'detector',
  agent: 'codex', seq, ts: seq * 1000,
});
const stopEdge = (seq: number, ptyId = 'ptyS'): CoalescerInput => ({
  workspaceId: 'ws-1', ptyId, kind: 'agent.stop', source: 'hook',
  agent: 'claude', seq, ts: seq * 1000,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('flushSnapshot — gate stack + accounting', () => {
  it('accepts a snapshot, accounts a wake, and drains it', async () => {
    const h = mk();
    h.c.flushSnapshot('ws-1', snap([pane({ agentStatus: 'awaiting_input' })]));
    await settle();
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].prompt).toContain('[fleet-snapshot]');
    expect(h.c.getWakeBudgetRemaining('ws-1')).toBe(99); // one auto-wake spent
  });

  it('drops when there are no attention panes and no buffered edges', async () => {
    const h = mk();
    h.c.flushSnapshot('ws-1', snap([pane({ agentStatus: 'running' }), pane({ agentStatus: 'idle' })]));
    await settle();
    expect(h.prompts).toHaveLength(0);
  });

  it('folds buffered edges into the prompt and advances the watermark past them on accept', async () => {
    const h = mk();
    h.setBusy(true);
    h.c.push(awaitingEdge(4, 'ptyE'));
    await settle();
    h.setBusy(false);
    h.c.flushSnapshot('ws-1', snap([pane({ ptyId: 'ptyA', agentStatus: 'complete' })]));
    await settle();
    expect(h.prompts).toHaveLength(1);
    const p = h.prompts[0].prompt;
    expect(p).toContain('state=complete');
    expect(p).toContain('seq=4'); // the buffered edge folded in
    expect(h.c.getWatermark('ws-1')).toBe(4); // consumed
    expect(h.c.getPhase('ws-1')).toBe('idle'); // buffer drained
  });

  it('a busy reject DROPS the snapshot but KEEPS buffered edges intact', async () => {
    const h = mk();
    // Buffer an edge while busy, then snapshot-flush against a busy brain.
    h.setBusy(true);
    h.c.push(awaitingEdge(6, 'ptyE'));
    await settle();
    h.c.flushSnapshot('ws-1', snap([pane({ agentStatus: 'awaiting_input' })]));
    await settle();
    // Snapshot dropped at the sync busy gate — no prompt, no wake spent.
    expect(h.prompts).toHaveLength(0);
    expect(h.c.getWakeBudgetRemaining('ws-1')).toBe(100);
    // The buffered edge must survive untouched (watermark not advanced).
    expect(h.c.getWatermark('ws-1')).toBe(0);
    // And it still flushes once the brain frees up.
    h.setBusy(false);
    h.c.notifyIdle('ws-1');
    await settle();
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].prompt).toContain('seq=6');
  });

  it('a pending decision blocks the snapshot (leaves the buffer untouched)', async () => {
    const h = mk({ hasPendingDecision: () => true });
    h.c.flushSnapshot('ws-1', snap([pane({ agentStatus: 'awaiting_input' })]));
    await settle();
    expect(h.prompts).toHaveLength(0);
  });

  it('global auto-wake OFF suppresses a snapshot; a running loop overrides it', async () => {
    const off = mk({ isAutoWakeEnabled: () => false });
    off.c.flushSnapshot('ws-1', snap([pane({ agentStatus: 'awaiting_input' })]));
    await settle();
    expect(off.prompts).toHaveLength(0);

    const loop = mk({ isAutoWakeEnabled: () => false, loop: { running: true, iterations: 10 } });
    loop.c.flushSnapshot('ws-1', snap([pane({ agentStatus: 'awaiting_input' })]));
    await settle();
    expect(loop.prompts).toHaveLength(1);
    expect(loop.prompts[0].prompt).toContain('loop-mode: ACTIVE');
  });

  it('off-mode consumes nothing and never wakes on a snapshot', async () => {
    const h = mk({ autonomy: OFF });
    h.c.flushSnapshot('ws-1', snap([pane({ agentStatus: 'awaiting_input' })]));
    await settle();
    expect(h.prompts).toHaveLength(0);
  });

  it('assist (value-filtered) narrows to blocked panes and drops plain-stop edges', async () => {
    const h = mk({ autonomy: ASSIST });
    // Buffer a plain-stop edge + a snapshot with one blocked and one complete pane.
    h.setBusy(true);
    h.c.push(stopEdge(3, 'ptyS'));
    await settle();
    h.setBusy(false);
    h.c.flushSnapshot('ws-1', snap([
      pane({ ptyId: 'ptyA', agentStatus: 'awaiting_input' }),
      pane({ ptyId: 'ptyB', agentStatus: 'complete' }),
    ]));
    await settle();
    expect(h.prompts).toHaveLength(1);
    const p = h.prompts[0].prompt;
    // Only the blocked pane survives the assist filter…
    expect(p).toContain('pane=ptyA');
    expect(p).not.toContain('pane=ptyB');
    // …and the plain-stop edge is NOT surfaced (but IS consumed).
    expect(p).not.toContain('seq=3');
    expect(h.c.getWatermark('ws-1')).toBe(3);
  });

  it('snapshot flushes count toward the sliding-window rate ceiling', async () => {
    const h = mk({ maxWakesPerMin: 2 });
    for (const _ of [1, 2]) {
      h.c.flushSnapshot('ws-1', snap([pane({ agentStatus: 'awaiting_input' })]));
      await settle();
    }
    expect(h.prompts).toHaveLength(2);
    // Third snapshot within the window → rate-limited.
    h.c.flushSnapshot('ws-1', snap([pane({ agentStatus: 'awaiting_input' })]));
    await settle();
    expect(h.prompts).toHaveLength(2);
    expect(h.c.getPhase('ws-1')).toBe('rate-limited');
  });

  it('budget exhaustion blocks a snapshot too', async () => {
    const h = mk({ wakeBudget: 1, maxWakesPerMin: 100 });
    h.c.flushSnapshot('ws-1', snap([pane({ agentStatus: 'awaiting_input' })]));
    await settle();
    expect(h.prompts).toHaveLength(1);
    h.c.flushSnapshot('ws-1', snap([pane({ agentStatus: 'awaiting_input' })]));
    await settle();
    expect(h.prompts).toHaveLength(1);
    expect(h.c.getPhase('ws-1')).toBe('budget-blocked');
  });
});
