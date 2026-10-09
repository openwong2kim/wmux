import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AutomationEvent, AutomationRun } from '../../../shared/automation';
import type { SessionPromptScheduleResult } from '../../../shared/sessionPromptSchedule';
import { AutomationEngine, type AutomationAgentView, type AutomationEnginePorts } from '../AutomationEngine';
import { AUTOMATION_RUNS_FILE, AUTOMATIONS_FILE, snapshotPath } from '../store';

const MIN = 60_000;

const draft = (over: Record<string, unknown> = {}) => ({
  name: 'Nightly',
  trigger: { kind: 'schedule', weekdays: [0, 1, 2, 3, 4, 5, 6], time: '08:30', graceMinutes: 60 },
  action: { kind: 'launch', cwd: '/work/repo', agent: 'claude', prompt: 'do the thing' },
  ...over,
});

interface Harness {
  engine: AutomationEngine;
  dir: string;
  clock: { t: number };
  created: Array<{ id: string; cwd: string; command: string; env: Record<string, string> }>;
  destroyed: string[];
  killed: number[];
  keys: string[];
  delivered: string[];
  events: AutomationEvent[];
  alive: Set<string>;
  state: { screen: string; agent: AutomationAgentView; pendingApproval: boolean; turnEndAt?: number; deliver: SessionPromptScheduleResult };
}

function harness(opts: { dir?: string; ports?: Partial<AutomationEnginePorts> } = {}): Harness {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-engine-'));
  const clock = { t: new Date(2026, 8, 28, 9, 0).getTime() };
  let seq = 0;
  const h: Omit<Harness, 'engine'> = {
    dir, clock, created: [], destroyed: [], killed: [], keys: [], delivered: [], events: [], alive: new Set(),
    state: {
      screen: '╭──╮\n│ > │\n╰──╯',
      agent: { slug: 'claude', verified: true, status: 'idle', inputQuiet: true, incarnationId: 'inc-1' },
      pendingApproval: false,
      deliver: 'sent',
    },
  };
  const ports: AutomationEnginePorts = {
    wmuxDir: dir,
    parentEnv: { PATH: '/bin' },
    log: () => undefined,
    emit: (e) => h.events.push(e),
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; },
    newId: () => `id${++seq}`,
    isDirectory: () => true,
    buildBaseCommand: async (choice) => choice.agent,
    createSession: async (p) => { h.created.push(p); h.alive.add(p.id); },
    sessionPid: (id) => (h.alive.has(id) ? 4242 : null),
    isAttached: () => false,
    destroySession: async (id) => { h.destroyed.push(id); h.alive.delete(id); },
    readScreen: async () => h.state.screen,
    sendKey: async (_id, seq2) => { h.keys.push(seq2); },
    readAgent: () => h.state.agent,
    armAgentTracker: () => undefined,
    deliverPrompt: async (_id, _slug, _inc, prompt) => { h.delivered.push(prompt); return h.state.deliver; },
    hasPendingApproval: () => h.state.pendingApproval,
    transcriptTurnEndAt: () => h.state.turnEndAt,
    snapshotText: async () => 'final screen',
    killTree: async (pid) => { h.killed.push(pid); },
    ...opts.ports,
  };
  return { ...h, engine: new AutomationEngine(ports) };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
};

/** Launch awaits real file writes, which slow CI runners finish after `settle`; wait on the state instead. */
const settleLaunch = async (h: Harness): Promise<void> => {
  await vi.waitFor(() => {
    expect(h.engine.listRuns().some((r) => r.state === 'launching')).toBe(false);
  }, { timeout: 5000, interval: 5 });
};

async function startedRun(h: Harness, over: Record<string, unknown> = {}): Promise<AutomationRun> {
  await h.engine.start({ timers: false });
  const created = await h.engine.create(draft(over));
  if (!created.ok) throw new Error(created.error);
  const res = await h.engine.runNow(created.automation.id, 'manual');
  if (!res.ok) throw new Error(res.error);
  await settleLaunch(h);
  return h.engine.listRuns()[0];
}

describe('AutomationEngine — revision & grants', () => {
  it('bumps the revision on a what-runs edit and skips a stale grant instead of downgrading it', async () => {
    const h = harness();
    await h.engine.start({ timers: false });
    const a = await h.engine.create(draft());
    if (!a.ok) throw new Error();
    expect(a.automation).toMatchObject({ enabled: true, revision: 1, permission: { mode: 'approval' }, createdBy: 'desktop-ui' });
    const g = await h.engine.grant(a.automation.id, 'bypass', undefined);
    expect(g.ok && g.automation.permission).toEqual({ mode: 'bypass', grantedRevision: 1 });
    // Renaming does not change what runs.
    const renamed = await h.engine.update(a.automation.id, draft({ name: 'Renamed' }));
    expect(renamed.ok && renamed.automation.revision).toBe(1);
    // A client-sent grant inside the draft is ignored; the prompt edit bumps.
    const edited = await h.engine.update(a.automation.id, {
      ...draft({ action: { kind: 'launch', cwd: '/work/repo', agent: 'claude', prompt: 'something else' } }),
      permission: { mode: 'bypass', grantedRevision: 2 },
    });
    expect(edited.ok && edited.automation.revision).toBe(2);
    expect(edited.ok && edited.automation.permission.grantedRevision).toBe(1);
    // The update queued the stale-grant notice right away, held back (not
    // broadcast, not listed) while the editor's update → confirm → grant runs.
    expect(h.engine.list().pendingAttention?.map((x) => x.kind)).toEqual(['grant-raised']);
    const regrantEvents = () => h.events.filter((e) => e.type === 'attention' && e.kind === 'needs-regrant');
    h.engine.tick(h.clock.t + 60_000);
    expect(regrantEvents()).toHaveLength(0);
    h.engine.tick(h.clock.t + 5 * MIN + 1_000);
    h.engine.tick(h.clock.t + 5 * MIN + 2_000);
    expect(regrantEvents()).toHaveLength(1);
    expect(h.engine.list().pendingAttention?.map((x) => x.kind)).toEqual(['grant-raised', 'needs-regrant']);
    // A manual/test run refuses; nothing is spawned.
    expect(await h.engine.runNow(a.automation.id, 'test')).toEqual({ ok: false, error: expect.any(String) });
    // The schedule's own occurrence is recorded skipped, never launched as approval.
    const skipped = await h.engine.startRun(h.engine.list().automations[0], h.clock.t, 'scheduled');
    expect(skipped).toMatchObject({ state: 'skipped', reason: 'needs_regrant', effectiveMode: 'bypass', revision: 2 });
    await settle();
    expect(h.created).toEqual([]);
    // Granting again at the new revision clears the stale notice (and is a
    // raise in its own right) and runs.
    await h.engine.grant(a.automation.id, 'bypass', undefined);
    expect(h.engine.list().pendingAttention?.map((x) => x.kind)).toEqual(['grant-raised', 'grant-raised']);
    expect((await h.engine.runNow(a.automation.id, 'test')).ok).toBe(true);
    await settle();
    expect(h.created[0].command).toBe('claude --dangerously-skip-permissions --disallowedTools mcp__wmux');
  });

  it('a skipped occurrence announces its held-back notice at once', async () => {
    const h = harness();
    await h.engine.start({ timers: false });
    const a = await h.engine.create(draft());
    if (!a.ok) throw new Error();
    await h.engine.grant(a.automation.id, 'auto', undefined);
    await h.engine.update(a.automation.id, draft({ action: { kind: 'launch', cwd: '/work/repo', agent: 'claude', prompt: 'edited' } }));
    await h.engine.startRun(h.engine.list().automations[0], h.clock.t, 'scheduled');
    expect(h.events.filter((e) => e.type === 'attention' && e.kind === 'needs-regrant')).toHaveLength(1);
    expect(h.engine.list().pendingAttention?.map((x) => x.kind)).toContain('needs-regrant');
  });

  it('boot: a schedule already holding a stale grant gets one needs-regrant notice', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-engine-'));
    fs.writeFileSync(path.join(dir, AUTOMATIONS_FILE), JSON.stringify({
      version: 1,
      automations: [
        { ...draft(), id: 'a1', enabled: true, revision: 3, createdAt: 1, permission: { mode: 'bypass', grantedRevision: 2 } },
        { ...draft(), id: 'a2', enabled: true, revision: 3, createdAt: 1, permission: { mode: 'bypass', grantedRevision: 3 } },
      ],
      attention: [],
    }));
    const h = harness({ dir });
    await h.engine.start({ timers: false });
    expect(h.engine.list().pendingAttention?.map((x) => [x.automationId, x.kind])).toEqual([['a1', 'needs-regrant']]);
    // Not queued twice across restarts.
    const again = harness({ dir });
    await again.engine.start({ timers: false });
    expect(again.engine.list().pendingAttention).toHaveLength(1);
  });

  it('a grant pinned to a revision the schedule has left is refused', async () => {
    const h = harness();
    await h.engine.start({ timers: false });
    const a = await h.engine.create(draft());
    if (!a.ok) throw new Error();
    // An edit lands while the native confirm (pinned to revision 1) is open.
    await h.engine.update(a.automation.id, draft({ action: { kind: 'launch', cwd: '/work/repo', agent: 'claude', prompt: 'edited' } }));
    const stale = await h.engine.grant(a.automation.id, 'auto', undefined, 1);
    expect(stale).toEqual({ ok: false, error: expect.stringContaining('changed') });
    expect(h.engine.list().automations[0].permission).toEqual({ mode: 'approval' });
    const fresh = await h.engine.grant(a.automation.id, 'auto', undefined, 2);
    expect(fresh.ok && fresh.automation.permission).toEqual({ mode: 'auto', grantedRevision: 2 });
  });

  it('the tick skips a due occurrence whose grant is stale', async () => {
    const h = harness();
    await h.engine.start({ timers: false });
    const a = await h.engine.create(draft());
    if (!a.ok) throw new Error();
    await h.engine.grant(a.automation.id, 'auto', undefined);
    await h.engine.update(a.automation.id, draft({ action: { kind: 'launch', cwd: '/work/repo', agent: 'claude', prompt: 'edited' } }));
    h.engine.tick(new Date(2026, 8, 29, 8, 31).getTime());
    await settle();
    expect(h.created).toEqual([]);
    expect(h.engine.listRuns()[0]).toMatchObject({ state: 'skipped', reason: 'needs_regrant', trigger: 'scheduled' });
  });

  it('auto: claude only; the grant survives a restart and launches with the auto flag', async () => {
    const h = harness();
    await h.engine.start({ timers: false });
    const codex = await h.engine.create(draft({ action: { kind: 'launch', cwd: '/work/repo', agent: 'codex', prompt: 'x' } }));
    if (!codex.ok) throw new Error();
    expect(await h.engine.grant(codex.automation.id, 'auto', undefined)).toEqual({ ok: false, error: expect.any(String) });
    const a = await h.engine.create(draft());
    if (!a.ok) throw new Error();
    const g = await h.engine.grant(a.automation.id, 'auto', undefined);
    expect(g.ok && g.automation.permission).toEqual({ mode: 'auto', grantedRevision: 1 });
    h.engine.stop();
    const again = harness({ dir: h.dir });
    await again.engine.start({ timers: false });
    const restored = again.engine.list().automations.find((x) => x.id === a.automation.id);
    expect(restored?.permission).toEqual({ mode: 'auto', grantedRevision: 1 });
    const res = await again.engine.runNow(a.automation.id, 'manual');
    expect(res.ok && res.run.effectiveMode).toBe('auto');
    await settle();
    expect(again.created[0].command).toBe("claude --permission-mode auto --disallowedTools mcp__wmux");
  });

  it('a raised grant queues an attention item', async () => {
    const h = harness();
    await h.engine.start({ timers: false });
    const a = await h.engine.create(draft());
    if (!a.ok) throw new Error();
    await h.engine.grant(a.automation.id, 'scoped', ['Read', 'Edit']);
    expect(h.events).toContainEqual({ type: 'attention', automationId: a.automation.id, automationName: 'Nightly', kind: 'grant-raised' });
    expect(h.engine.list().pendingAttention?.map((x) => x.kind)).toEqual(['grant-raised']);
    expect((await h.engine.grant(a.automation.id, 'scoped', ['Bash(rm:*)'])).ok).toBe(false);
  });

  it('propose always stores a disabled approval-mode draft and queues attention until acked', async () => {
    const h = harness();
    await h.engine.start({ timers: false });
    const p = await h.engine.propose({ ...draft(), enabled: true, permission: { mode: 'bypass', grantedRevision: 1 } });
    if (!p.ok) throw new Error(p.error);
    expect(p.automation).toMatchObject({
      enabled: false, proposed: true, permission: { mode: 'approval' }, createdBy: 'mcp-proposal', nextRunAt: null,
    });
    const pending = h.engine.list().pendingAttention ?? [];
    expect(pending).toHaveLength(1);
    // Survives a restart (a desktop that connects later still sees it).
    const again = harness({ dir: h.dir });
    await again.engine.start({ timers: false });
    expect(again.engine.list().pendingAttention).toHaveLength(1);
    await again.engine.ackAttention([pending[0].id]);
    expect(again.engine.list().pendingAttention).toEqual([]);
    const enabled = await again.engine.setEnabled(p.automation.id, true);
    expect(enabled.ok && enabled.automation.proposed).toBeUndefined();
    // Reviewing a draft keeps it in approval until a human grants more.
    expect(enabled.ok && enabled.automation.permission).toEqual({ mode: 'approval' });
  });
});

describe('AutomationEngine — launch & readiness', () => {
  it('launches into an auto- PTY with the scrubbed env and pastes the prompt once ready', async () => {
    const h = harness();
    const run = await startedRun(h);
    expect(h.created).toHaveLength(1);
    expect(h.created[0].id).toBe(`auto-${run.id}`);
    expect(h.created[0].env.CLAUDE_CODE_SANDBOXED).toBe('1');
    expect(h.delivered).toEqual(['do the thing']);
    expect(run.state).toBe('running');
    expect(h.engine.ownsPane(`auto-${run.id}`)).toBe(true);
    expect(h.engine.holdsDaemon()).toBe(true);
  });

  it('dismisses a known first-run interstitial with ESC, then delivers', async () => {
    const h = harness();
    h.state.screen = 'Try the new fullscreen renderer?\n❯ 1. Yes\n  2. Not now\nEnter to confirm · Esc to cancel';
    const original = h.engine['ports'].sendKey;
    h.engine['ports'].sendKey = async (id, s) => { await original(id, s); h.state.screen = '│ > │'; };
    const run = await startedRun(h);
    expect(h.keys).toEqual(['\x1b']);
    expect(run.state).toBe('running');
  });

  it('an unknown blocking screen fails first_run_blocked and never pastes', async () => {
    const h = harness();
    h.state.screen = 'Pick one\n❯ 1. Alpha\n  2. Beta\nEnter to confirm';
    const run = await startedRun(h);
    expect(h.delivered).toEqual([]);
    expect(h.keys).toEqual([]);
    expect(run).toMatchObject({ state: 'failed', reason: 'first_run_blocked', hasSnapshot: true });
    expect(h.killed).toEqual([4242]);
    expect(h.destroyed).toHaveLength(1);
  });

  it('a missing account fails before any session exists', async () => {
    const h = harness();
    const run = await startedRun(h, { action: { kind: 'launch', cwd: '/w', agent: 'claude', accountId: 'nope', prompt: 'x' } });
    expect(run).toMatchObject({ state: 'failed', reason: 'account_missing' });
    expect(h.created).toEqual([]);
  });

  it('a claim that cannot be persisted never spawns', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-ro-')), 'not-a-dir');
    fs.writeFileSync(file, 'x');
    const h = harness({ dir: file });
    const run = await startedRun(h);
    expect(run).toMatchObject({ state: 'failed', reason: 'launch_failed' });
    expect(h.created).toEqual([]);
  });

  it('skip_if_active: a second start while one is active is recorded skipped(overlap)', async () => {
    const h = harness();
    const first = await startedRun(h);
    const second = await h.engine.runNow(first.automationId, 'manual');
    expect(second.ok && second.run).toMatchObject({ state: 'skipped', reason: 'overlap' });
    expect(h.created).toHaveLength(1);
  });

  it('boot: a run left launching/running is marked unknown and never relaunched', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-boot-'));
    fs.writeFileSync(path.join(dir, AUTOMATIONS_FILE), JSON.stringify({
      version: 1,
      automations: [{ ...draft(), id: 'a1', enabled: false, revision: 1, createdAt: 1 }],
    }));
    fs.writeFileSync(path.join(dir, AUTOMATION_RUNS_FILE), JSON.stringify({
      version: 1,
      runs: [{ id: 'r1', automationId: 'a1', revision: 1, effectiveMode: 'bypass', scheduledFor: 1, trigger: 'scheduled', state: 'running', ptyId: 'auto-r1', startedAt: 1 }],
    }));
    const h = harness({ dir });
    await h.engine.start({ timers: false });
    h.engine.tick();
    await settle();
    const [run] = h.engine.listRuns();
    expect(run).toMatchObject({ id: 'r1', state: 'unknown', reason: 'interrupted' });
    expect(run.ptyId).toBeUndefined();
    expect(h.created).toEqual([]);
  });

  it('the tick fires a due occurrence inside grace', async () => {
    const h = harness();
    await h.engine.start({ timers: false });
    const a = await h.engine.create(draft());
    if (!a.ok) throw new Error();
    // Created at 09:00 → next is tomorrow 08:30; jump there plus 10 minutes.
    h.clock.t = a.automation.nextRunAt! + 10 * MIN;
    h.engine.tick();
    await settleLaunch(h);
    const [run] = h.engine.listRuns();
    expect(run).toMatchObject({ trigger: 'scheduled', scheduledFor: a.automation.nextRunAt, state: 'running' });
  });
});

describe('AutomationEngine — completion & caps', () => {
  it('hook Stop completes, the session lingers, then is snapshotted, tree-killed and destroyed', async () => {
    const h = harness();
    const run = await startedRun(h);
    const pty = `auto-${run.id}`;
    await h.engine.onAgentEvent(pty, { kind: 'agent.stop', status: 'complete', agentSessionId: 'sess-1' });
    let [now] = h.engine.listRuns();
    expect(now).toMatchObject({ state: 'completed', agentSessionId: 'sess-1' });
    expect(h.destroyed).toEqual([]);
    h.clock.t += 11 * MIN;
    await h.engine.monitorOnce();
    [now] = h.engine.listRuns();
    expect(now.hasSnapshot).toBe(true);
    expect(fs.readFileSync(snapshotPath(h.dir, run.id)!, 'utf8')).toBe('final screen');
    expect(h.killed).toEqual([4242]);
    expect(h.destroyed).toEqual([pty]);
    expect(h.engine.ownsPane(pty)).toBe(false);
  });

  it('a Stop hook before the prompt was delivered is not a completion', async () => {
    const h = harness();
    h.state.deliver = 'busy';
    const deliver = h.engine['ports'].deliverPrompt;
    let stopSeen = false;
    h.engine['ports'].deliverPrompt = async (...args) => {
      if (!stopSeen) {
        stopSeen = true;
        await h.engine.onAgentEvent(args[0], { kind: 'agent.stop', status: 'complete' });
        h.state.deliver = 'sent';
      }
      return deliver(...args);
    };
    const run = await startedRun(h);
    expect(run.state).toBe('running');
  });

  it('StopFailure fails the run with agent_error', async () => {
    const h = harness();
    const run = await startedRun(h);
    await h.engine.onAgentEvent(`auto-${run.id}`, { kind: 'agent.stop_failure', status: 'error' });
    expect(h.engine.listRuns()[0]).toMatchObject({ state: 'failed', reason: 'agent_error' });
  });

  it('PTY exit decides by exit code', async () => {
    for (const [code, expected] of [[0, { state: 'completed' }], [3, { state: 'failed', reason: 'process_exit' }], [null, { state: 'unknown' }]] as const) {
      const h = harness();
      const run = await startedRun(h);
      h.alive.delete(`auto-${run.id}`);
      await h.engine.onSessionDied(`auto-${run.id}`, code);
      expect(h.engine.listRuns()[0]).toMatchObject(expected);
      expect(h.engine.ownsPane(`auto-${run.id}`)).toBe(false);
    }
  });

  it('transcript turn end after delivery completes; detector complete needs a running first', async () => {
    const h = harness();
    await startedRun(h);
    h.state.agent = { ...h.state.agent, status: 'complete' };
    await h.engine.monitorOnce();
    expect(h.engine.listRuns()[0].state).toBe('running');
    h.state.turnEndAt = h.clock.t + 1;
    await h.engine.monitorOnce();
    expect(h.engine.listRuns()[0].state).toBe('completed');
  });

  it('agent gone but PTY up is ambiguous: unknown, not killed', async () => {
    const h = harness();
    const run = await startedRun(h);
    h.engine.onAgentProcessExit(`auto-${run.id}`);
    h.clock.t += 31_000;
    await h.engine.monitorOnce();
    expect(h.engine.listRuns()[0]).toMatchObject({ state: 'unknown', reason: 'process_exit' });
    expect(h.killed).toEqual([]);
    // …but the absolute cap still reaps it.
    h.clock.t += 241 * MIN;
    await h.engine.monitorOnce();
    expect(h.killed).toEqual([4242]);
  });

  it('absolute run cap applies in approval mode too', async () => {
    const h = harness();
    await startedRun(h);
    h.state.agent = { ...h.state.agent, status: 'running' };
    h.clock.t += 241 * MIN;
    await h.engine.monitorOnce();
    expect(h.engine.listRuns()[0]).toMatchObject({ state: 'failed', reason: 'timeout', hasSnapshot: true });
    expect(h.destroyed).toHaveLength(1);
  });

  it('awaiting beyond the timeout fails: 60 min unattended, 15 min in approval', async () => {
    const bypass = harness();
    await bypass.engine.start({ timers: false });
    const a = await bypass.engine.create(draft());
    if (!a.ok) throw new Error();
    await bypass.engine.grant(a.automation.id, 'bypass', undefined);
    await bypass.engine.runNow(a.automation.id, 'manual');
    await settle();
    expect(bypass.created[0].command).toBe('claude --dangerously-skip-permissions --disallowedTools mcp__wmux');
    bypass.state.pendingApproval = true;
    await bypass.engine.monitorOnce();
    expect(bypass.engine.listRuns()[0].state).toBe('awaiting');
    bypass.clock.t += 61 * MIN;
    await bypass.engine.monitorOnce();
    expect(bypass.engine.listRuns()[0]).toMatchObject({ state: 'failed', reason: 'await_timeout' });

    const approval = harness();
    await startedRun(approval);
    approval.state.pendingApproval = true;
    await approval.engine.monitorOnce();
    approval.clock.t += 14 * MIN;
    await approval.engine.monitorOnce();
    expect(approval.engine.listRuns()[0].state).toBe('awaiting');
    approval.clock.t += 2 * MIN;
    await approval.engine.monitorOnce();
    expect(approval.engine.listRuns()[0]).toMatchObject({ state: 'failed', reason: 'await_timeout', effectiveMode: 'approval' });
    expect(approval.destroyed).toHaveLength(1);
  });

  it('turn progress during a wait restarts the await clock; repaint-only output does not', async () => {
    const transcript: { lastEventAt?: number } = {};
    const h = harness({ ports: { transcriptLastEventAt: () => transcript.lastEventAt } });
    await startedRun(h);
    h.state.agent = { ...h.state.agent, status: 'awaiting_input' };
    await h.engine.monitorOnce();
    expect(h.engine.listRuns()[0].state).toBe('awaiting');
    // The transcript moved 10 min into the "wait": the agent is working.
    transcript.lastEventAt = h.clock.t + 10 * MIN;
    h.clock.t += 16 * MIN;
    await h.engine.monitorOnce();
    expect(h.engine.listRuns()[0].state).toBe('awaiting');
    // No progress for a full limit after that: it ends.
    h.clock.t += 10 * MIN;
    await h.engine.monitorOnce();
    expect(h.engine.listRuns()[0]).toMatchObject({ state: 'failed', reason: 'await_timeout' });
  });

  it('a running hook during a misread wait keeps the run alive', async () => {
    const h = harness();
    const run = await startedRun(h);
    h.state.agent = { ...h.state.agent, status: 'awaiting_input' };
    await h.engine.monitorOnce();
    h.clock.t += 14 * MIN;
    await h.engine.onAgentEvent(`auto-${run.id}`, { kind: 'agent.tool_started', status: 'running', decision: 'activity' });
    h.clock.t += 2 * MIN;
    await h.engine.monitorOnce();
    expect(h.engine.listRuns()[0].state).not.toBe('failed');
  });

  it('a configured await timeout wins in approval mode too', async () => {
    const h = harness();
    await startedRun(h, { policy: { awaitTimeoutMinutes: 1 } });
    h.state.pendingApproval = true;
    await h.engine.monitorOnce();
    h.clock.t += 2 * MIN;
    await h.engine.monitorOnce();
    expect(h.engine.listRuns()[0]).toMatchObject({ state: 'failed', reason: 'await_timeout' });
  });

  it('a finished turn followed by the idle awaiting_input notice stays completed past the approval timeout', async () => {
    // Hook path: a confirmed Stop, then Claude's idle "waiting for input" notification.
    const h = harness();
    const run = await startedRun(h);
    await h.engine.onAgentEvent(`auto-${run.id}`, { kind: 'agent.stop', status: 'complete', decision: 'emit' });
    await h.engine.onAgentEvent(`auto-${run.id}`, { kind: 'agent.awaiting_input', status: 'awaiting_input', decision: 'emit' });
    h.state.agent = { ...h.state.agent, status: 'awaiting_input' };
    h.clock.t += 16 * MIN;
    await h.engine.monitorOnce();
    expect(h.engine.listRuns()[0]).toMatchObject({ state: 'completed' });
    expect(h.engine.listRuns()[0].reason).toBeUndefined();

    // Monitor path: the Stop was not confirmed and the idle notice arrived
    // first; the transcript's turn end still completes the run.
    const m = harness();
    const run2 = await startedRun(m);
    await m.engine.onAgentEvent(`auto-${run2.id}`, { kind: 'agent.stop', status: 'complete', decision: 'internal' });
    await m.engine.onAgentEvent(`auto-${run2.id}`, { kind: 'agent.awaiting_input', status: 'awaiting_input', decision: 'emit' });
    expect(m.engine.listRuns()[0].state).toBe('awaiting');
    m.state.agent = { ...m.state.agent, status: 'awaiting_input' };
    m.state.turnEndAt = m.clock.t + 1;
    m.clock.t += 16 * MIN;
    await m.engine.monitorOnce();
    expect(m.engine.listRuns()[0]).toMatchObject({ state: 'completed' });
  });

  it('cancelRun terminates a live run', async () => {
    const h = harness();
    const run = await startedRun(h);
    expect((await h.engine.cancelRun(run.id)).ok).toBe(true);
    expect(h.engine.listRuns()[0]).toMatchObject({ state: 'failed', reason: 'cancelled' });
    expect(h.destroyed).toEqual([`auto-${run.id}`]);
  });
});

describe('AutomationEngine — review regressions', () => {
  it('an update landing during the claim save cannot pair the new prompt with the old grant', async () => {
    const h = harness();
    await h.engine.start({ timers: false });
    const a = await h.engine.create(draft());
    if (!a.ok) throw new Error();
    await h.engine.grant(a.automation.id, 'bypass', undefined);
    const started = h.engine.runNow(a.automation.id, 'manual');
    const edited = h.engine.update(a.automation.id, draft({ action: { kind: 'launch', cwd: '/work/repo', agent: 'claude', prompt: 'new prompt' } }));
    await Promise.all([started, edited]);
    await settle();
    expect(h.created[0].command).toBe('claude --dangerously-skip-permissions --disallowedTools mcp__wmux');
    expect(h.delivered).toEqual(['do the thing']);
    expect(h.engine.listRuns()[0].revision).toBe(1);
  });

  it('a session that exits before the prompt was delivered is a failed launch, even with code 0', async () => {
    const h = harness();
    h.state.agent = { ...h.state.agent, verified: false };
    let fired = false;
    h.engine['ports'].sleep = async (ms) => {
      h.clock.t += ms;
      if (!fired) {
        fired = true;
        const pty = h.created[0].id;
        h.alive.delete(pty);
        await h.engine.onSessionDied(pty, 0);
      }
    };
    await startedRun(h);
    expect(h.engine.listRuns()[0]).toMatchObject({ state: 'failed', reason: 'launch_failed' });
  });

  it('a finished turn showing the ready footer completes instead of sticking in awaiting', async () => {
    const h = harness();
    await startedRun(h);
    h.state.agent = { ...h.state.agent, status: 'running' };
    await h.engine.monitorOnce();
    h.state.agent = { ...h.state.agent, status: 'waiting' };
    await h.engine.monitorOnce();
    expect(h.engine.listRuns()[0].state).toBe('running');
    h.state.turnEndAt = h.clock.t + 1;
    await h.engine.monitorOnce();
    expect(h.engine.listRuns()[0].state).toBe('completed');
  });

  it('a Stop the hook layer did not confirm is not a completion', async () => {
    const h = harness();
    const run = await startedRun(h);
    await h.engine.onAgentEvent(`auto-${run.id}`, { kind: 'agent.stop', status: 'complete', decision: 'internal' });
    expect(h.engine.listRuns()[0].state).toBe('running');
    await h.engine.onAgentEvent(`auto-${run.id}`, { kind: 'agent.stop', status: 'complete', decision: 'emit' });
    expect(h.engine.listRuns()[0].state).toBe('completed');
  });

  it('a lingering session still counts as active for overlap', async () => {
    const h = harness();
    const run = await startedRun(h);
    await h.engine.onAgentEvent(`auto-${run.id}`, { kind: 'agent.stop', status: 'complete', decision: 'emit' });
    const second = await h.engine.runNow(run.automationId, 'manual');
    expect(second.ok && second.run).toMatchObject({ state: 'skipped', reason: 'overlap' });
    expect(h.created).toHaveLength(1);
  });

  it('an attached client cannot hold a completed session open forever', async () => {
    const h = harness({ ports: { isAttached: () => true } });
    const run = await startedRun(h);
    await h.engine.onAgentEvent(`auto-${run.id}`, { kind: 'agent.stop', status: 'complete', decision: 'emit' });
    h.clock.t += 11 * MIN;
    await h.engine.monitorOnce();
    expect(h.destroyed).toEqual([]);
    h.clock.t += 60 * MIN;
    await h.engine.monitorOnce();
    expect(h.destroyed).toEqual([`auto-${run.id}`]);
  });

  it('a session destroyed from outside settles the run as unknown', async () => {
    const h = harness();
    const run = await startedRun(h);
    h.alive.delete(`auto-${run.id}`);
    await h.engine.monitorOnce();
    expect(h.engine.listRuns()[0]).toMatchObject({ state: 'unknown', reason: 'process_exit' });
    expect(h.engine.ownsPane(`auto-${run.id}`)).toBe(false);
  });

  it('codex scoped takes no tool list', async () => {
    const h = harness();
    await h.engine.start({ timers: false });
    const a = await h.engine.create(draft({ action: { kind: 'launch', cwd: '/w', agent: 'codex', prompt: 'x' } }));
    if (!a.ok) throw new Error();
    expect((await h.engine.grant(a.automation.id, 'scoped', ['Read'])).ok).toBe(false);
    const g = await h.engine.grant(a.automation.id, 'scoped', undefined);
    expect(g.ok && g.automation.permission).toEqual({ mode: 'scoped', grantedRevision: 1 });
  });

  it('a run cancelled while its session was being created reaps that session', async () => {
    let release: () => void = () => undefined;
    const h = harness();
    h.engine['ports'].createSession = async (p) => {
      await new Promise<void>((r) => { release = r; });
      h.created.push(p);
      h.alive.add(p.id);
    };
    await h.engine.start({ timers: false });
    const a = await h.engine.create(draft());
    if (!a.ok) throw new Error();
    const res = await h.engine.runNow(a.automation.id, 'manual');
    if (!res.ok) throw new Error();
    await settle();
    await h.engine.cancelRun(res.run.id);
    release();
    await settle();
    expect(h.engine.listRuns()[0]).toMatchObject({ state: 'failed', reason: 'cancelled' });
    expect(h.killed).toEqual([4242]);
    expect(h.destroyed).toContain(`auto-${res.run.id}`);
    expect(h.delivered).toEqual([]);
    expect(h.engine.ownsPane(`auto-${res.run.id}`)).toBe(false);
  });

  it('a throwing prompt delivery fails the launch instead of escaping', async () => {
    const h = harness({ ports: { deliverPrompt: async () => { throw new Error('boom'); } } });
    const run = await startedRun(h);
    expect(run).toMatchObject({ state: 'failed', reason: 'launch_failed' });
  });

  it('a tick during remove() cannot start a run for the schedule being deleted', async () => {
    const h = harness();
    const run = await startedRun(h);
    const a = h.engine.list().automations[0];
    h.clock.t = a.nextRunAt! + MIN;
    const removing = h.engine.remove(run.automationId);
    h.engine.tick();
    await removing;
    await settle();
    expect(h.created).toHaveLength(1);
    expect(h.engine.list().automations).toEqual([]);
  });
});

describe('AutomationEngine — readiness diagnostics', () => {
  it('logs why a launch never became ready, without prompt text', async () => {
    const logs: string[] = [];
    const h = harness({ ports: { log: (_l, m) => { logs.push(m); } } });
    h.state.agent = { ...h.state.agent, verified: false, slug: null };
    const run = await startedRun(h);
    expect(run).toMatchObject({ state: 'failed', reason: 'launch_failed' });
    const line = logs.find((m) => m.includes('not ready after'));
    expect(line).toContain('everVerified=false');
    expect(line).toContain('"verified":false');
    expect(line).not.toContain('do the thing');
  });
});

describe('AutomationEngine — attached finished runs', () => {
  it('a completed run a human opened does not block the next occurrence; an unattended linger still does', async () => {
    let attached = false;
    const h = harness({ ports: { isAttached: () => attached } });
    const run = await startedRun(h);
    await h.engine.onAgentEvent(`auto-${run.id}`, { kind: 'agent.stop', status: 'complete', decision: 'emit' });
    const blocked = await h.engine.runNow(run.automationId, 'manual');
    expect(blocked.ok && blocked.run).toMatchObject({ state: 'skipped', reason: 'overlap' });
    attached = true;
    const next = await h.engine.runNow(run.automationId, 'manual');
    expect(next.ok && next.run.state).toBe('launching');
    await settle();
    expect(h.created).toHaveLength(2);
    expect(h.destroyed).toEqual([]);
  });
});
