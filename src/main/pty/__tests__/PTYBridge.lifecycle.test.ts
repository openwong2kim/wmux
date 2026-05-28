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
}));

vi.mock('../../notification/sendNotification', () => ({
  sendNotification: mocks.sendNotification,
}));

import { PTYBridge } from '../PTYBridge';
import type { PTYManager, PTYInstance } from '../PTYManager';
import type { HookSignalRouter } from '../../hooks/HookSignalRouter';
import { eventBus } from '../../events/EventBus';

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

function stubHookRouter(decision: 'emit' | 'dedup'): HookSignalRouter {
  return {
    recordDetector: vi.fn().mockReturnValue(decision),
    recordHook: vi.fn().mockReturnValue('emit'),
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

  it('REGRESSION: existing sendNotification + toast still fire alongside the tee', () => {
    const { proc } = makeBridge({ workspaceId: 'ws-a' });

    proc.emitData('Claude Code\n');
    proc.emitData('  shift+tab to cycle\n');
    flush();

    expect(mocks.sendNotification).toHaveBeenCalled();
    expect(mocks.toastManager.show).toHaveBeenCalled();
    // And tee emitted.
    expect(pollLifecycle().length).toBeGreaterThanOrEqual(1);
  });

  it('honors HookSignalRouter dedup — detector after hook returns decision:"dedup"', () => {
    // Codex P2 catch: without recordDetector, hook+detector pairs both emit
    // with decision:'emit' and orchestrators filtering on emit run follow-up
    // twice. Stub the router to simulate "hook already fired" → recordDetector
    // returns 'dedup' → emitted event carries that decision through.
    const router = stubHookRouter('dedup');
    const { proc } = makeBridge({ workspaceId: 'ws-a', hookRouter: router });

    proc.emitData('Claude Code\n');
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
    proc.emitData('  shift+tab to cycle\n');
    flush();

    const events = pollLifecycle();
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]).toMatchObject({ source: 'detector', decision: 'emit' });
  });

  it('emits agent.lifecycle source:"awaiting_input" when AgentDetector matches an approval prompt', () => {
    const { proc } = makeBridge({ workspaceId: 'ws-a' });

    proc.emitData('Claude Code\n');
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
