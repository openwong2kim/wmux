// #3393: a paste left unsubmitted in a pane's input box holds the pane for
// every writer until a turn starts after it, input reaches the pane after it,
// the agent's process exits (or a different one launches), or the session ends.
// The turn-start signal is the agent's prompt-submit hook, wired as the daemon
// wires it: a real HookIngest and DaemonPTYBridge.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { UnsentPasteHolds, deliverUnderHold, type HeldWriteEdge } from '../unsentPasteHold';
import type { DeliveryPresence } from '../../shared/deliveryPresence';
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

  it('a key typed into a picker over the box (a headless answer) keeps it; a key before that one still clears it', () => {
    paste();
    holds.record('pty-a', 'main delivery');
    // The answer's digit, counted as the daemon counts it.
    const after = bridge.noteInput('1', { selfWrite: true });
    holds.passedOver('pty-a', after, 'headless answer');
    expect(holds.held('pty-a')).toBe(true);
    expect(logs.some((l) => l.includes('kept: headless answer'))).toBe(true);

    // A person's key between the hold and the answer: the hold is cleared, and the answer does not bring it back.
    bridge.noteInput('x');
    const later = bridge.noteInput('2', { selfWrite: true });
    holds.passedOver('pty-a', later, 'headless answer');
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

  it('is taken as of the writer\'s last write: a key or a submitted prompt before the record still clears it', () => {
    paste();
    holds.wrote('pty-a');
    // The person submits the box while the writer still checks the pane: the Enter and the hook land before the record.
    vi.advanceTimersByTime(500);
    bridge.noteInput('\r');
    ingest.handle(signal('agent.user_prompt_submit'));
    holds.record('pty-a', 'scheduled prompt');
    expect(holds.held('pty-a')).toBe(false);
    // Only a submitted prompt (no key counted): cleared too.
    paste();
    holds.wrote('pty-a');
    vi.advanceTimersByTime(500);
    ingest.handle(signal('agent.user_prompt_submit'));
    holds.record('pty-a', 'main delivery');
    expect(holds.held('pty-a')).toBe(false);
  });

  it('nothing is recorded for a session that is gone', () => {
    expect(holds.record('pty-z', 'main delivery')).toBe(false);
    expect(holds.held('pty-z')).toBe(false);
  });

  describe("a daemon writer's delivery under the hold (the funnel)", () => {
    const typed: string[] = [];
    /** What the box shows at the take-back's check: exactly this paste, or not. */
    let shown: boolean;
    let presenceFails: boolean;
    /** A writer that pastes and then is refused before its Enter (a dialog, a key in the gap). */
    const pasteThenRefuse = async (onWrite: HeldWriteEdge): Promise<'sent' | 'error'> => {
      paste('SCHED 1');
      typed.push('SCHED 1');
      holds.wrote('pty-a');
      onWrite('paste');
      return 'error';
    };
    /** What the caller (a scheduler, a nudge) heard of the writes. */
    const edges: string[] = [];
    const run = (deliver: (onWrite: HeldWriteEdge) => Promise<'sent' | 'error'>, writer = 'scheduled prompt') => deliverUnderHold({
      onWrite: (stage) => { edges.push(stage); },
      holds,
      sessionId: 'pty-a',
      writer,
      text: 'SCHED 1',
      deliver,
      presence: async (check): Promise<DeliveryPresence> => {
        if (presenceFails) throw new Error('no frame');
        expect(check).toMatchObject({ phase: 'enter', shownProbe: 'SCHED 1' });
        return shown ? { tier: 'process', slug: 'claude', input: 'full', bracketedPaste: true, pasteShown: true } : { tier: 'none', reason: 'composer-busy', pasteShown: false };
      },
      eraseLine: () => { typed.push('^U'); bridge.noteInput('\x15'); return true; },
      log: (line) => logs.push(line),
    });

    beforeEach(() => { typed.length = 0; edges.length = 0; shown = true; presenceFails = false; });

    it('a paste it left is taken back while the box shows exactly it: busy (taken-back), no hold, and the next tick delivers once', async () => {
      expect(await run(pasteThenRefuse)).toBe('busy');
      expect(typed).toEqual(['SCHED 1', '^U']);
      expect(holds.held('pty-a')).toBe(false);
      expect(logs.some((line) => line.includes('taken back (Ctrl+U); not held; busy (taken-back), retried'))).toBe(true);
      // The caller never heard of a paste: nothing of it may sit in the composer.
      expect(edges).toEqual([]);
      // Its retry on the next tick: delivered once.
      let deliveries = 0;
      expect(await run(async (onWrite) => { deliveries += 1; paste('SCHED 1'); onWrite('paste'); bridge.noteInput('\r'); onWrite('submit'); return 'sent'; })).toBe('sent');
      expect(deliveries).toBe(1);
      expect(edges).toEqual(['paste', 'submit']);
    });

    it('the person typed after the paste: nothing erased, held, and the next writer is busy with nothing written', async () => {
      shown = false;
      expect(await run(pasteThenRefuse)).toBe('error');
      expect(typed).toEqual(['SCHED 1']);
      // Left in the box: the caller hears of the paste, so it never types it again.
      expect(edges).toEqual(['paste']);
      expect(holds.held('pty-a')).toBe(true);
      expect(logs.some((line) => line.includes('does not show it as its own; not erased, held'))).toBe(true);
      let delivered = false;
      expect(await run(async () => { delivered = true; return 'sent'; }, 'automation run')).toBe('busy');
      expect(delivered).toBe(false);
      expect(logs.some((line) => line.includes('automation run: busy (unsent-paste)'))).toBe(true);
    });

    it('a box that cannot be read is not erased: held', async () => {
      presenceFails = true;
      await run(pasteThenRefuse);
      expect(typed).toEqual(['SCHED 1']);
      expect(holds.held('pty-a')).toBe(true);
    });

    it('a writer that throws after its paste is handled the same; one that sent, or wrote nothing, leaves nothing', async () => {
      shown = false;
      await expect(run(async (onWrite) => { paste(); holds.wrote('pty-a'); onWrite('paste'); throw new Error('boom'); })).rejects.toThrow('boom');
      expect(holds.held('pty-a')).toBe(true);
      holds.sessionEnded('pty-a');
      expect(await run(async () => 'error')).toBe('error');
      expect(await run(async (onWrite) => { onWrite('paste'); return 'sent'; })).toBe('sent');
      expect(holds.held('pty-a')).toBe(false);
      expect(typed).toEqual([]);
    });
  });
});

