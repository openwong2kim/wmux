// Tests for the `agent.lifecycle` EventBus tee fired from PTYBridge when
// AgentDetector emits a 'waiting' or 'complete' status. The tee runs
// alongside the existing sendNotification / METADATA_UPDATE wiring;
// regressions on those paths are covered by PTYBridge.notify.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  toastManager: { show: vi.fn() },
  broadcastMetadataUpdate: vi.fn(),
  sendNotification: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: class {},
}));

vi.mock('../../pipe/handlers/notify.rpc', () => ({
  toastManager: mocks.toastManager,
}));

vi.mock('../../ipc/handlers/metadata.handler', () => ({
  updateCwd: vi.fn(),
  removeCwd: vi.fn(),
  updateBranch: vi.fn(),
  removeBranch: vi.fn(),
  broadcastMetadataUpdate: mocks.broadcastMetadataUpdate,
  // #935 direction 3: PTYBridge imports these from the real module; this
  // suite does not exercise the deferral logic, so no-op stubs are enough
  // to keep the import from throwing.
  getLastBroadcastAgentStatus: () => undefined,
  clearLastBroadcastAgentStatus: () => { /* no-op stub */ },
}));

vi.mock('../../notification/sendNotification', () => ({
  sendNotification: mocks.sendNotification,
}));

// dispatchNotification's real implementation runs in this file (only its
// sendNotification/toastManager dependencies are mocked above) — without
// this, its renderer-readiness gate defaults to false and every call falls
// through to the unmocked real ToastManager.show(), which crashes on
// BrowserWindow.getFocusedWindow() not existing on the bare `class {}` electron
// stub. These tests are about detector/hook dispatch, not the readiness gate
// itself (that has dedicated coverage in dispatchNotification.test.ts).
vi.mock('../../notification/rendererNotificationReadiness', () => ({
  isRendererNotificationListenerReady: () => true,
}));

import { PTYBridge } from '../PTYBridge';
import type { PTYManager, PTYInstance } from '../PTYManager';
import type { HookSignalRouter } from '../../hooks/HookSignalRouter';
import { eventBus } from '../../events/EventBus';
import { markResize, clearPty as clearSuppression, RESIZE_REDRAW_GUARD_MS } from '../../notification/idleSuppression';

interface MockProcess {
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (info: { exitCode: number }) => void) => void;
  emitData: (data: string) => void;
  emitExit: (code: number) => void;
}

function makeMockProcess(): MockProcess {
  let dataCb: ((data: string) => void) | null = null;
  let exitCb: ((info: { exitCode: number }) => void) | null = null;
  return {
    onData: (cb) => { dataCb = cb; },
    onExit: (cb) => { exitCb = cb; },
    emitData: (d) => { dataCb?.(d); },
    emitExit: (c) => { exitCb?.({ exitCode: c }); },
  };
}

function makeMockManager(instance: PTYInstance) {
  return {
    get: vi.fn(() => instance),
    remove: vi.fn(),
    onDispose: vi.fn(),
  } as unknown as PTYManager;
}

function makeBridge(opts: { workspaceId?: string; hookRouter?: HookSignalRouter | null } = {}) {
  const proc = makeMockProcess();
  const instance: PTYInstance = {
    id: 'pty-1',
    process: proc as unknown as PTYInstance['process'],
    shell: 'bash',
    // workspaceId is optional on PTYInstance — set per test.
    ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
  } as PTYInstance;
  const manager = makeMockManager(instance);
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
  const routerForClosure = opts.hookRouter;
  const getHookRouter = routerForClosure !== undefined ? () => routerForClosure : undefined;
  const bridge = new PTYBridge(manager, () => win as never, getHookRouter);
  bridge.setupDataForwarding('pty-1');
  return { bridge, proc };
}

function stubHookRouter(
  decision: 'emit' | 'dedup',
  opts: { governed?: boolean; runningGoverned?: boolean } = {},
): HookSignalRouter {
  const governed = opts.governed ?? false;
  return {
    recordDetector: vi.fn().mockReturnValue(decision),
    recordHook: vi.fn().mockReturnValue('emit'),
    touchAuthority: vi.fn(),
    noteHookTurnStart: vi.fn(),
    isGovernedFor: vi.fn().mockReturnValue(governed),
    // Independent of `governed`: a bridge can be alive on a pane and still
    // never report a turn start (an older plugin, an integration that only
    // wires turn ends), and only the turn-start evidence mutes the byte-rate
    // heuristic. See HookSignalRouter.governsRunningState.
    governsRunningState: vi.fn().mockReturnValue(opts.runningGoverned ?? false),
    // Mirrors the real predicate: only the two statuses the Stop hook speaks
    // for, and only on a governed pane. Stubbing it as a flat `governed`
    // would wrongly withhold 'awaiting_input' too.
    governsDetectorStatus: vi.fn(
      (_ptyId: string, slug: string | null | undefined, status: string) =>
        governed && !!slug && (status === 'waiting' || status === 'complete'),
    ),
  } as unknown as HookSignalRouter;
}

function pollLifecycle() {
  return eventBus.poll(0, { types: ['agent.lifecycle'] }).events;
}

describe('PTYBridge — agent.lifecycle EventBus tee (detector source)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    eventBus.reset();
    mocks.broadcastMetadataUpdate.mockReset();
    mocks.sendNotification.mockReset();
    mocks.toastManager.show.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function flush() {
    // PTYBridge.BATCH_INTERVAL_MS (8ms) — advance enough so AgentDetector
    // middleware runs.
    vi.advanceTimersByTime(50);
  }

  it('emits agent.lifecycle when AgentDetector classifies output as "waiting"', () => {
    const { proc } = makeBridge({ workspaceId: 'ws-a' });

    // AgentDetector recognizes Claude Code via its gate phrase, then the
    // 'shift+tab to cycle' line classifies as 'waiting'.
    proc.emitData('Claude Code starting up\n');
    proc.emitData('  shift+tab to cycle\n');
    flush();

    const events = pollLifecycle();
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]).toMatchObject({
      type: 'agent.lifecycle',
      ptyId: 'pty-1',
      workspaceId: 'ws-a',
      kind: 'agent.stop',
      source: 'detector',
      agent: 'claude',
      decision: 'emit',
    });
  });

  it('does NOT emit when the PTY has no workspaceId (CLI/test PTY)', () => {
    const { proc } = makeBridge({}); // no workspaceId

    proc.emitData('Claude Code starting up\n');
    proc.emitData('  shift+tab to cycle\n');
    flush();

    // Existing notification flow still fires — only the EventBus tee is
    // gated on workspaceId.
    expect(mocks.sendNotification).toHaveBeenCalled();
    expect(pollLifecycle()).toHaveLength(0);
  });

  it('does NOT emit for "running" status (would overflow ring)', () => {
    const { proc } = makeBridge({ workspaceId: 'ws-a' });

    // Activity-only burst: large chunk triggers ActivityMonitor 'running'
    // but no 'waiting'/'complete' prompt yet.
    proc.emitData('x'.repeat(3000));
    flush();

    expect(pollLifecycle()).toHaveLength(0);
  });

  it('REGRESSION: sendNotification still fires alongside the tee; direct main toast is gone (renderer decides)', () => {
    const { proc } = makeBridge({ workspaceId: 'ws-a' });

    proc.emitData('Claude Code\n');
    proc.emitData('  bypass permissions on\n');
    proc.emitData('  shift+tab to cycle\n');
    flush();

    // dispatchNotification → sendNotification (window alive). The OS toast
    // is now a renderer policy decision (osToast action → IPC), so the
    // legacy direct toastManager.show call must NOT happen here.
    expect(mocks.sendNotification).toHaveBeenCalled();
    expect(mocks.toastManager.show).not.toHaveBeenCalled();
    // And tee emitted.
    expect(pollLifecycle().length).toBeGreaterThanOrEqual(1);
  });

  it('hook-authority veto: governed (ptyId, slug) suppresses detector notification, ledger write and tee', () => {
    // While the pane's hook bridge is fresh for the SAME agent, the
    // detector's footer heuristics must go fully silent on the
    // notification path: no sendNotification, no recordDetector (a ledger
    // write here would make the REAL Stop hook land as 'dedup' → silent
    // completion), no lifecycle tee (the hook path emits the canonical one).
    const router = stubHookRouter('emit', { governed: true });
    const { proc } = makeBridge({ workspaceId: 'ws-a', hookRouter: router });

    proc.emitData('Claude Code\n');
    proc.emitData('  bypass permissions on\n');
    proc.emitData('  shift+tab to cycle\n');
    flush();

    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(router.recordDetector).not.toHaveBeenCalled();
    expect(pollLifecycle()).toHaveLength(0);
  });

  it('#935 REGRESSION: a governed pane never gets a detector "waiting" onto agentStatus — Claude\'s bypass footer is on screen the WHOLE turn', () => {
    // The bug: the status broadcast ran BEFORE the veto and was deliberately
    // ungated, so `bypass permissions on` — permanent chrome in
    // bypass-permissions mode, not a turn boundary — wrote 'waiting' onto a
    // working pane's roster row. selectors/fleet.ts counts 'waiting' toward
    // the "N need you" chip, so every mid-turn repaint became a false
    // attention badge. The hook's Stop signal owns lifecycle on this pane;
    // the detector must not contradict it on the status either.
    const router = stubHookRouter('emit', { governed: true });
    const { proc } = makeBridge({ workspaceId: 'ws-a', hookRouter: router });

    proc.emitData('Claude Code\n');
    proc.emitData('  bypass permissions on\n');
    proc.emitData('  shift+tab to cycle\n');
    flush();

    expect(router.governsDetectorStatus).toHaveBeenCalledWith('pty-1', 'claude', 'waiting');
    const statusCalls = mocks.broadcastMetadataUpdate.mock.calls.filter(
      (c) => (c[1] as { agentStatus?: string }).agentStatus === 'waiting',
    );
    expect(statusCalls).toHaveLength(0);
    // Identity still rides the same broadcast — withholding the status must
    // not cost the pane its `(Claude Code)` auto-name.
    expect(mocks.broadcastMetadataUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ptyId: 'pty-1', agentName: 'Claude Code', agentSlug: 'claude' }),
    );
  });

  it('#935: an UNGOVERNED pane keeps the detector status — no hook bridge means the detector is still the backstop', () => {
    const router = stubHookRouter('emit', { governed: false });
    const { proc } = makeBridge({ workspaceId: 'ws-a', hookRouter: router });

    proc.emitData('Claude Code\n');
    proc.emitData('  shift+tab to cycle\n');
    flush();

    expect(mocks.broadcastMetadataUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ptyId: 'pty-1', agentStatus: 'waiting' }),
    );
  });

  it('codex review catch (round 2): the veto does NOT cover awaiting_input — approval prompts must still notify even when governed', () => {
    // Claude's hooks.json wires PreToolUse ONLY for the AskUserQuestion
    // tool. The far more common approval prompts ("Do you want to
    // proceed?", "Allow tool use for Bash") have NO hook at all —
    // AgentDetector's regex is the ONLY signal source for those. Vetoing
    // 'awaiting_input' the same way as 'waiting'/'complete' would leave an
    // agent blocked on a real approval prompt completely silent for the
    // full 30-minute authority TTL — a governed pane must still notify.
    const router = stubHookRouter('emit', { governed: true });
    const { proc } = makeBridge({ workspaceId: 'ws-a', hookRouter: router });

    proc.emitData('Claude Code\n');
    proc.emitData('  bypass permissions on\n'); // #850: compound gate needs prompt evidence
    proc.emitData('Do you want to proceed?\n');
    flush();

    // The point of this test is that awaiting_input is NOT vetoed by hook
    // governance. Asserting only that SOMETHING notified would pass even when
    // it IS vetoed, because opening the gate emits 'running' on its own — so
    // assert the approval notification specifically. `category: 'approval'` is
    // what PTYBridge tags an awaiting_input notification with; every other
    // status uses 'agent-turn'.
    const approvals = mocks.sendNotification.mock.calls.filter(
      ([, , payload]) => payload?.category === 'approval',
    );
    expect(approvals.length).toBeGreaterThan(0);
    const events = pollLifecycle();
    const awaiting = events.find((e) => e.type === 'agent.lifecycle' && e.kind === 'agent.awaiting_input');
    expect(awaiting).toBeDefined();
    expect(awaiting).toMatchObject({ decision: 'emit' });
  });

  it('resize-redraw guard: a burst within 3s of a resize does not reset emission dedup (no stale re-fire)', () => {
    const { proc } = makeBridge({ workspaceId: 'ws-a' });

    // Turn 1: gate + waiting prompt → notifications fire.
    proc.emitData('Claude Code\n');
    proc.emitData('  bypass permissions on\n');
    proc.emitData('  shift+tab to cycle\n');
    flush();
    // Reset count after gate-opening notifications to test resize dedup from here.
    const baseCount = mocks.sendNotification.mock.calls.length;
    expect(baseCount).toBeGreaterThanOrEqual(1);

    // Workspace switch refits xterm → pty:resize → multi-KB TUI repaint.
    // The repaint burst trips ActivityMonitor.onActive, but within the
    // guard window the emission dedup must survive, so the unchanged
    // footer re-match stays silent.
    markResize('pty-1');
    proc.emitData('x'.repeat(3000));
    flush();
    proc.emitData('  shift+tab to cycle\n');
    flush();
    expect(mocks.sendNotification).toHaveBeenCalledTimes(baseCount); // unchanged

    // Control: a burst well past the guard window resets dedup as before,
    // so the next genuine turn's identical footer CAN notify again.
    vi.advanceTimersByTime(10_000);
    proc.emitData('y'.repeat(3000));
    flush();
    proc.emitData('  shift+tab to cycle\n');
    flush();
    expect(mocks.sendNotification).toHaveBeenCalledTimes(baseCount + 1);

    clearSuppression('pty-1');
  });

  it('codex review catch: a real completion inside the SAME active cycle as the resize still notifies once the guard window elapses, even though onActive never fires a second time', () => {
    // ActivityMonitor.onActive fires EXACTLY ONCE per active-to-idle cycle
    // (re-armed only when the cycle goes idle). The original fix skipped
    // the emission-dedup reset outright when onActive fired inside the
    // guard window — correct for the resize repaint itself, but if a
    // genuinely new turn's real output continues streaming within the SAME
    // cycle (no 5s idle gap between the repaint and the real response),
    // onActive never fires again for the rest of this cycle, so the reset
    // would have been skipped FOREVER — silently dropping that turn's
    // completion. The fix defers the reset to fire on its own timer
    // instead of skipping it, so it still happens even with no second
    // onActive call.
    const { proc } = makeBridge({ workspaceId: 'ws-a' });

    proc.emitData('Claude Code\n');
    proc.emitData('  bypass permissions on\n');
    proc.emitData('  shift+tab to cycle\n');
    flush();
    const baseCount2 = mocks.sendNotification.mock.calls.length;
    expect(baseCount2).toBeGreaterThanOrEqual(1);

    // Resize → repaint burst → the ONE onActive call for this whole cycle.
    markResize('pty-1');
    proc.emitData('x'.repeat(3000));
    flush();

    // Still inside the guard window: the identical footer must NOT re-fire
    // (this is the resize repaint itself, not a real new turn).
    proc.emitData('  shift+tab to cycle\n');
    flush();
    expect(mocks.sendNotification).toHaveBeenCalledTimes(baseCount2);

    // The guard window elapses. Deliberately do NOT feed another
    // >2000-byte burst here — the point is that no second onActive call
    // occurs, only the deferred timer firing on its own.
    vi.advanceTimersByTime(RESIZE_REDRAW_GUARD_MS + 100);

    // The real turn's own completion arrives — same active cycle (from
    // ActivityMonitor's perspective), no second onActive, but the deferred
    // reset already ran. This MUST notify: it's a genuinely new turn.
    proc.emitData('  shift+tab to cycle\n');
    flush();
    expect(mocks.sendNotification).toHaveBeenCalledTimes(baseCount2 + 1);

    clearSuppression('pty-1');
  });

  it('honors HookSignalRouter dedup — detector after hook returns decision:"dedup"', () => {
    // Codex P2 catch: without recordDetector, hook+detector pairs both emit
    // with decision:'emit' and orchestrators filtering on emit run follow-up
    // twice. Stub the router to simulate "hook already fired" → recordDetector
    // returns 'dedup' → emitted event carries that decision through.
    const router = stubHookRouter('dedup');
    const { proc } = makeBridge({ workspaceId: 'ws-a', hookRouter: router });

    proc.emitData('Claude Code\n');
    proc.emitData('  bypass permissions on\n');
    proc.emitData('  shift+tab to cycle\n');
    flush();

    const events = pollLifecycle();
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]).toMatchObject({
      type: 'agent.lifecycle',
      source: 'detector',
      decision: 'dedup',
    });
    expect(router.recordDetector).toHaveBeenCalledWith('claude', 'agent.stop', 'pty-1');
  });

  it('honors HookSignalRouter — detector wins when no recent hook returns decision:"emit"', () => {
    const router = stubHookRouter('emit');
    const { proc } = makeBridge({ workspaceId: 'ws-a', hookRouter: router });

    proc.emitData('Claude Code\n');
    proc.emitData('  bypass permissions on\n');
    proc.emitData('  shift+tab to cycle\n');
    flush();

    const events = pollLifecycle();
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]).toMatchObject({ source: 'detector', decision: 'emit' });
  });

  it('emits agent.lifecycle source:"awaiting_input" when AgentDetector matches an approval prompt', () => {
    const { proc } = makeBridge({ workspaceId: 'ws-a' });

    proc.emitData('Claude Code\n');
    proc.emitData('  bypass permissions on\n');
    proc.emitData('Do you want to proceed?\n');
    flush();

    const events = pollLifecycle();
    const awaiting = events.find((e) => e.type === 'agent.lifecycle' && e.kind === 'agent.awaiting_input');
    expect(awaiting).toBeDefined();
    expect(awaiting).toMatchObject({
      type: 'agent.lifecycle',
      ptyId: 'pty-1',
      workspaceId: 'ws-a',
      kind: 'agent.awaiting_input',
      source: 'detector',
      agent: 'claude',
      decision: 'emit',
    });
  });

  it('does NOT emit awaiting_input for conversational "Do you want to proceed?" mentions', () => {
    // Codex round-2 P2 catch — the phrase embedded in a longer sentence
    // (e.g. Claude documenting how an approval gate looks) must not fire
    // awaiting_input. The line-end anchor on the regex ensures only the
    // real prompt line matches.
    const { proc } = makeBridge({ workspaceId: 'ws-a' });

    proc.emitData('Claude Code\n');
    proc.emitData('  bypass permissions on\n');
    proc.emitData('If the CLI asks "Do you want to proceed?", choose no\n');
    flush();

    const awaiting = pollLifecycle().find(
      (e) => e.type === 'agent.lifecycle' && e.kind === 'agent.awaiting_input',
    );
    expect(awaiting).toBeUndefined();
  });

  it('still matches a real approval line wrapped in Claude box-drawing chars', () => {
    // Realistic Claude TUI line: `│ Do you want to proceed?   │`
    const { proc } = makeBridge({ workspaceId: 'ws-a' });

    proc.emitData('Claude Code\n');
    proc.emitData('  bypass permissions on\n');
    proc.emitData('│ Do you want to proceed?   │\n');
    flush();

    const awaiting = pollLifecycle().find(
      (e) => e.type === 'agent.lifecycle' && e.kind === 'agent.awaiting_input',
    );
    expect(awaiting).toBeDefined();
  });

  it('does NOT emit awaiting_input for conversational "Allow tool use for X" mentions mid-sentence', () => {
    const { proc } = makeBridge({ workspaceId: 'ws-a' });

    proc.emitData('Claude Code\n');
    proc.emitData('  bypass permissions on\n');
    proc.emitData('click Allow tool use for Bash to enable git push\n');
    flush();

    const awaiting = pollLifecycle().find(
      (e) => e.type === 'agent.lifecycle' && e.kind === 'agent.awaiting_input',
    );
    expect(awaiting).toBeUndefined();
  });

  it('matches approval prompt lines that end with box corner glyphs (╮/╯)', () => {
    // Codex round-3 P2 — Claude's TUI sometimes terminates a boxed prompt
    // line with a corner glyph instead of a vertical edge. Without these
    // in the trailing whitelist, real approval prompts go unrecognized.
    const { proc } = makeBridge({ workspaceId: 'ws-a' });

    proc.emitData('Claude Code\n');
    proc.emitData('  bypass permissions on\n');
    proc.emitData('│ Do you want to proceed? ╮\n');
    flush();

    const awaiting = pollLifecycle().find(
      (e) => e.type === 'agent.lifecycle' && e.kind === 'agent.awaiting_input',
    );
    expect(awaiting).toBeDefined();
  });

  it('matches "Allow tool use for <MCP tool name>" with double-underscore namespace', () => {
    // Codex round-3 P2 — MCP tools are named like
    // `mcp__github__create_issue`. The original [A-Z][A-Za-z]+ class
    // rejected them, so approval prompts for MCP tools fired no
    // awaiting_input event. Pattern now covers the namespaced form.
    const { proc } = makeBridge({ workspaceId: 'ws-a' });

    proc.emitData('Claude Code\n');
    proc.emitData('  bypass permissions on\n');
    proc.emitData('Allow tool use for mcp__github__create_issue?\n');
    flush();

    const awaiting = pollLifecycle().find(
      (e) => e.type === 'agent.lifecycle' && e.kind === 'agent.awaiting_input',
    );
    expect(awaiting).toBeDefined();
  });

  it('matches boxed prompt lines that use light-horizontal border (─)', () => {
    // Codex round-4 P2 — `╭─ Do you want to proceed? ─╮` is a real Claude
    // approval prompt variant. The U+2500 light-horizontal glyph must be
    // in the trailing whitelist.
    const { proc } = makeBridge({ workspaceId: 'ws-a' });

    proc.emitData('Claude Code\n');
    proc.emitData('  bypass permissions on\n');
    proc.emitData('╭─ Do you want to proceed? ─╮\n');
    flush();

    const awaiting = pollLifecycle().find(
      (e) => e.type === 'agent.lifecycle' && e.kind === 'agent.awaiting_input',
    );
    expect(awaiting).toBeDefined();
  });

  it('does NOT emit awaiting_input for "Allow tool use for Bash_command" with single-underscore tail', () => {
    // Codex round-4 P2 — the round-3 broadening accepted single-underscore
    // identifiers, which let conversational text like `Please click Allow
    // tool use for Bash_command │` slip back through. The split
    // alternation (capitalized built-in OR mcp__ prefix) now rejects this
    // shape.
    const { proc } = makeBridge({ workspaceId: 'ws-a' });

    proc.emitData('Claude Code\n');
    proc.emitData('  bypass permissions on\n');
    proc.emitData('Please click Allow tool use for Bash_command │\n');
    flush();

    const awaiting = pollLifecycle().find(
      (e) => e.type === 'agent.lifecycle' && e.kind === 'agent.awaiting_input',
    );
    expect(awaiting).toBeUndefined();
  });

  it('does NOT emit awaiting_input when a leading conversational phrase precedes "Allow tool use for X"', () => {
    // Codex round-5 P2 — the suffix anchor passed `Please click Allow
    // tool use for Bash` because nothing constrained what came before
    // the phrase. The leading anchor now requires whitespace/box-frame
    // glyphs as prefix.
    const { proc } = makeBridge({ workspaceId: 'ws-a' });

    proc.emitData('Claude Code\n');
    proc.emitData('  bypass permissions on\n');
    proc.emitData('Please click Allow tool use for Bash\n');
    flush();

    const awaiting = pollLifecycle().find(
      (e) => e.type === 'agent.lifecycle' && e.kind === 'agent.awaiting_input',
    );
    expect(awaiting).toBeUndefined();
  });

  it('does NOT emit awaiting_input when a leading conversational phrase precedes "Do you want to proceed?"', () => {
    const { proc } = makeBridge({ workspaceId: 'ws-a' });

    proc.emitData('Claude Code\n');
    proc.emitData('  bypass permissions on\n');
    proc.emitData('Answer Do you want to proceed?\n');
    flush();

    const awaiting = pollLifecycle().find(
      (e) => e.type === 'agent.lifecycle' && e.kind === 'agent.awaiting_input',
    );
    expect(awaiting).toBeUndefined();
  });

  it('matches canonical MCP tool names with hyphens (mcp__server__tool-with-hyphens)', () => {
    // Codex round-5 P2 — the prior `mcp__[A-Za-z0-9_]+` regex rejected
    // hyphenated MCP tool names like `mcp__context7__get-library-docs`.
    const { proc } = makeBridge({ workspaceId: 'ws-a' });

    proc.emitData('Claude Code\n');
    proc.emitData('  bypass permissions on\n');
    proc.emitData('Allow tool use for mcp__context7__get-library-docs?\n');
    flush();

    const awaiting = pollLifecycle().find(
      (e) => e.type === 'agent.lifecycle' && e.kind === 'agent.awaiting_input',
    );
    expect(awaiting).toBeDefined();
  });

  it('rejects non-canonical MCP tool names with a single underscore segment', () => {
    // Codex round-5 P2 — `mcp__github_create_issue` (single `__`, then
    // single `_`) is not the canonical `mcp__<server>__<tool>` form;
    // the regex now requires two `__` separators.
    const { proc } = makeBridge({ workspaceId: 'ws-a' });

    proc.emitData('Claude Code\n');
    proc.emitData('  bypass permissions on\n');
    proc.emitData('Allow tool use for mcp__github_create_issue?\n');
    flush();

    const awaiting = pollLifecycle().find(
      (e) => e.type === 'agent.lifecycle' && e.kind === 'agent.awaiting_input',
    );
    expect(awaiting).toBeUndefined();
  });

  it('matches Claude built-in tool labels with longer PascalCase (TodoWrite, ExitPlanMode)', () => {
    const { proc } = makeBridge({ workspaceId: 'ws-a' });

    proc.emitData('Claude Code\n');
    proc.emitData('  bypass permissions on\n');
    proc.emitData('Allow tool use for TodoWrite?\n');
    flush();

    const awaiting = pollLifecycle().find(
      (e) => e.type === 'agent.lifecycle' && e.kind === 'agent.awaiting_input',
    );
    expect(awaiting).toBeDefined();
  });
});

describe('PTYBridge — agent.lifecycle EventBus tee (osc133 source)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    eventBus.reset();
    mocks.broadcastMetadataUpdate.mockReset();
    mocks.sendNotification.mockReset();
    mocks.toastManager.show.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function flush() {
    vi.advanceTimersByTime(50);
  }

  // OSC 133 wire format: ESC ] 133 ; <subcmd> [; <args>] BEL
  const OSC_133_D_OK = '\x1b]133;D;0\x07';
  const OSC_133_D_FAIL = '\x1b]133;D;1\x07';
  const OSC_133_D_NO_EXIT = '\x1b]133;D\x07';
  const OSC_133_A = '\x1b]133;A\x07';

  it('emits source:"osc133" with parsed exitCode on OSC 133 D;<exitCode>', () => {
    const { proc } = makeBridge({ workspaceId: 'ws-a' });

    proc.emitData(OSC_133_D_OK);
    flush();

    const events = pollLifecycle();
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      type: 'agent.lifecycle',
      ptyId: 'pty-1',
      workspaceId: 'ws-a',
      kind: 'agent.stop',
      source: 'osc133',
      agent: null,
      decision: 'emit',
      exitCode: 0,
    });
  });

  it('emits exitCode null when OSC 133 D carries no exit code suffix', () => {
    const { proc } = makeBridge({ workspaceId: 'ws-a' });

    proc.emitData(OSC_133_D_NO_EXIT);
    flush();

    const events = pollLifecycle();
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ source: 'osc133', exitCode: null });
  });

  it('does NOT emit for non-D subcommands (A/B/C)', () => {
    const { proc } = makeBridge({ workspaceId: 'ws-a' });

    proc.emitData(OSC_133_A);
    flush();

    expect(pollLifecycle()).toHaveLength(0);
  });

  it('does NOT emit when workspaceId is unknown', () => {
    const { proc } = makeBridge({});

    proc.emitData(OSC_133_D_OK);
    flush();

    expect(pollLifecycle()).toHaveLength(0);
  });

  it('sets agent to the detector last-known slug when a gated agent is active', () => {
    const { proc } = makeBridge({ workspaceId: 'ws-a' });

    // Gate the Claude Code detector first so getLastAgent() returns 'Claude Code'.
    proc.emitData('Claude Code\n');
    proc.emitData('  bypass permissions on\n');
    proc.emitData('  shift+tab to cycle\n');
    flush();
    // Drain the detector-source lifecycle event so the next poll sees only osc133.
    eventBus.reset();

    proc.emitData(OSC_133_D_FAIL);
    flush();

    const events = pollLifecycle();
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      source: 'osc133',
      agent: 'claude',
      exitCode: 1,
    });
  });

  it('osc133 events bypass HookSignalRouter dedup (always decision:"emit")', () => {
    const router = stubHookRouter('dedup');
    const { proc } = makeBridge({ workspaceId: 'ws-a', hookRouter: router });

    proc.emitData(OSC_133_D_OK);
    flush();

    const events = pollLifecycle();
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ source: 'osc133', decision: 'emit' });
    expect(router.recordDetector).not.toHaveBeenCalled();
  });
});
