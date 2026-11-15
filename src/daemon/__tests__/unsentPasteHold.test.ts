// #3393: a paste left unsubmitted in a pane's input box holds the pane for
// every writer until a turn starts after it, input reaches the pane after it,
// the agent's process exits (or a different one launches), or the session ends.
// The turn-start signal is the agent's prompt-submit hook, wired as the daemon
// wires it: a real HookIngest and DaemonPTYBridge.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { UnsentPasteHolds } from '../unsentPasteHold';
import { HookIngest } from '../hooks/HookIngest';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { PromptEventLog } from '../PromptEventLog';
import { RingBuffer } from '../RingBuffer';
import type { AgentSignal } from '../../shared/hooks/signal-types';

const fakePty = (): IPty => ({ onData: () => ({ dispose: () => undefined }), onExit: () => ({ dispose: () => undefined }) }) as unknown as IPty;

describe('UnsentPasteHolds', () => {
  let bridge: DaemonPTYBridge;
  let ingest: HookIngest;
  let pid: Record<string, number | undefined>;
  let logs: string[];
  let holds: UnsentPasteHolds;

  const signal = (kind: AgentSignal['kind']): AgentSignal => ({ kind, agent: 'claude', cwd: '/repo', ptyId: 'pty-a', payload: {}, ts: Date.now() });
  /** A writer's paste, counted the way the daemon counts a write. */
  const paste = (text = 'SCHED 1'): void => { bridge.noteInput(`\x1b[200~${text}\x1b[201~`); };

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = new DaemonPTYBridge();
    bridge.setupDataForwarding(fakePty(), new RingBuffer(65536), 'pty-a', new PromptEventLog());
    ingest = new HookIngest({
      listLiveSessions: () => [{ id: 'pty-a', cwd: '/repo', env: { WMUX_WORKSPACE_ID: 'ws-1' }, lastActivity: '2026-01-01T00:00:00.000Z' }],
      emitAgentEvent: () => undefined,
      applyResumeBinding: () => undefined,
      log: () => undefined,
    });
    pid = { 'pty-a': 4242 };
    logs = [];
    holds = new UnsentPasteHolds({
      keyRevision: (id) => (id === 'pty-a' || id === 'pty-b' ? bridge.getKeyInputRevision() : undefined),
      promptSubmittedAt: (id) => ingest.promptSubmittedAt(id),
      agentPid: (id) => pid[id],
      log: (line) => logs.push(line),
    });
  });

  afterEach(() => {
    ingest.dispose();
    bridge.cleanup();
    vi.useRealTimers();
  });

  it('holds from the writer\'s last write: its own paste is not input after it; another session is not held', () => {
    paste();
    holds.record('pty-a', 'scheduled prompt');
    expect(holds.held('pty-a')).toBe(true);
    expect(holds.held('pty-b')).toBe(false);
  });

  it('a tool hook during a running turn does not clear it; a prompt submitted after it does', () => {
    ingest.handle(signal('agent.user_prompt_submit'));
    vi.advanceTimersByTime(1_000);
    paste();
    holds.record('pty-a', 'scheduled prompt');
    vi.advanceTimersByTime(1_000);
    ingest.handle(signal('agent.tool_started'));
    ingest.handle(signal('agent.activity'));
    expect(holds.held('pty-a')).toBe(true);
    // The turn's end does not clear it either.
    ingest.handle(signal('agent.stop'));
    expect(holds.held('pty-a')).toBe(true);
    vi.advanceTimersByTime(1_000);
    ingest.handle(signal('agent.user_prompt_submit'));
    expect(holds.held('pty-a')).toBe(false);
  });

  it('input after it (a person\'s key, any other writer) clears it', () => {
    paste();
    holds.record('pty-a', 'main delivery');
    bridge.noteInput('\x15');
    expect(holds.held('pty-a')).toBe(false);
  });

  it("the agent's exit clears it: an agent restarted in the same pane starts with a clear pane", () => {
    paste();
    holds.record('pty-a', 'automation run');
    holds.agentState('pty-a', false);
    pid['pty-a'] = 5151;
    holds.agentState('pty-a', true);
    expect(holds.held('pty-a')).toBe(false);
  });

  it('a launch edge naming a different process clears it; the same process still running does not', () => {
    paste();
    holds.record('pty-a', 'caller nudge');
    holds.agentState('pty-a', true);
    expect(holds.held('pty-a')).toBe(true);
    // A successor replaced the watched process (no death edge).
    pid['pty-a'] = 5151;
    holds.agentState('pty-a', true);
    expect(holds.held('pty-a')).toBe(false);
  });

  it('with no process known when it was left, a launch edge does not clear it; the death edge does', () => {
    pid['pty-a'] = undefined;
    paste();
    holds.record('pty-a', 'chat send');
    pid['pty-a'] = 5151;
    holds.agentState('pty-a', true);
    expect(holds.held('pty-a')).toBe(true);
    holds.agentState('pty-a', false);
    expect(holds.held('pty-a')).toBe(false);
  });

  it('the session ending clears it', () => {
    paste();
    holds.record('pty-a', 'main delivery');
    holds.sessionEnded('pty-a');
    expect(holds.held('pty-a')).toBe(false);
  });

  it('each writer refused while it stands logs once, with the reason', () => {
    paste();
    holds.record('pty-a', 'main delivery');
    expect(holds.heldFor('pty-a', 'scheduled prompt')).toBe(true);
    expect(holds.heldFor('pty-a', 'scheduled prompt')).toBe(true);
    expect(holds.heldFor('pty-a', 'channel wake nudge')).toBe(true);
    const busy = logs.filter((line) => line.includes('busy (unsent-paste)'));
    expect(busy).toHaveLength(2);
    expect(busy[0]).toContain('scheduled prompt');
  });

  it('nothing is recorded for a session that is gone', () => {
    expect(holds.record('pty-z', 'main delivery')).toBe(false);
    expect(holds.held('pty-z')).toBe(false);
  });
});
