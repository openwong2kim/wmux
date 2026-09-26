// Where HookIngest records the agent's own terminal dialog as a
// `terminal_prompt`: Claude Code's PermissionRequest hook, and detector
// attention that survived its confirmation window.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  HookIngest,
  type DetectorHeldEventData,
  type HookAgentEventData,
  type HookIngestDeps,
  type HookIngestSession,
} from '../HookIngest';
import { DEFAULT_ALARM_WINDOW_MS } from '../../../shared/hooks/CompletionAlarm';
import { ENV_KEYS } from '../../../shared/constants';
import type { AgentSignal } from '../../../shared/hooks/signal-types';

type TerminalPromptInput = { sessionId: string; agent: string; workspaceId?: string; toolName?: string; summary?: string };

function makeSignal(overrides: Partial<AgentSignal> = {}): AgentSignal {
  return { kind: 'agent.awaiting_input', agent: 'claude', cwd: '/repo', payload: {}, ts: 1_000, ptyId: 'pty-a', ...overrides };
}

const PERMISSION_REQUEST = {
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf build/cache', description: 'Remove the build cache' },
};

function makeIngest(opts: {
  sessions?: HookIngestSession[];
  emitDetector?: (sessionId: string, data: DetectorHeldEventData) => boolean | void;
} = {}) {
  const sessions = opts.sessions ?? [{ id: 'pty-a', cwd: '/repo', env: { WMUX_WORKSPACE_ID: 'ws-1' } }];
  const terminalPrompts: TerminalPromptInput[] = [];
  const awaitingInput: string[] = [];
  const emitted: HookAgentEventData[] = [];
  const detectorEmitted: DetectorHeldEventData[] = [];
  let clock = 10_000;
  const deps: HookIngestDeps = {
    listLiveSessions: () => sessions,
    emitAgentEvent: (_id, data) => { emitted.push(data); },
    emitDetectorEvent: (id, data) => {
      detectorEmitted.push(data);
      return opts.emitDetector?.(id, data);
    },
    applyResumeBinding: () => undefined,
    approvals: {
      noteHookAwaitingInput: (input) => { awaitingInput.push(input.sessionId); },
      noteGateAwaiting: () => 'gate-id',
      noteTerminalPrompt: (input) => { terminalPrompts.push(input); },
      expireForSession: () => undefined,
    },
    log: () => undefined,
    now: () => clock,
  };
  const ingest = new HookIngest(deps);
  return { ingest, terminalPrompts, awaitingInput, emitted, detectorEmitted, advance: (ms: number) => { clock += ms; } };
}

const AWAITING = { agent: 'Claude Code', status: 'awaiting_input', message: 'Approval requested' };

describe('HookIngest — terminal_prompt records', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  describe('from the PermissionRequest hook', () => {
    it('records the dialog with its tool and input summary, and no answerable card', () => {
      const f = makeIngest();
      f.ingest.handle(makeSignal({ payload: PERMISSION_REQUEST }));
      expect(f.terminalPrompts).toEqual([{
        sessionId: 'pty-a',
        agent: 'claude',
        workspaceId: 'ws-1',
        toolName: 'Bash',
        summary: 'rm -rf build/cache',
        // The hook's own tool input: a binding when the transcript has none.
        toolInput: { command: 'rm -rf build/cache', description: 'Remove the build cache' },
        source: 'hook',
      }]);
      expect(f.awaitingInput).toEqual([]);
    });

    it('covers the whole Claude family', () => {
      const f = makeIngest();
      f.ingest.handle(makeSignal({ agent: 'openclaude', payload: PERMISSION_REQUEST }));
      expect(f.terminalPrompts).toMatchObject([{ agent: 'openclaude', toolName: 'Bash' }]);
      expect(f.awaitingInput).toEqual([]);
    });

    it('records nothing for the orchestrator brain pane', () => {
      const f = makeIngest({ sessions: [{ id: 'pty-a', cwd: '/repo', env: { [ENV_KEYS.BRAIN_PTY]: '1' } }] });
      f.ingest.handle(makeSignal({ payload: PERMISSION_REQUEST }));
      expect(f.terminalPrompts).toEqual([]);
      expect(f.awaitingInput).toEqual([]);
    });

    it('leaves a Codex PermissionRequest on its existing card path', () => {
      const f = makeIngest();
      f.ingest.handle(makeSignal({ agent: 'codex', payload: PERMISSION_REQUEST }));
      expect(f.terminalPrompts).toEqual([]);
      expect(f.awaitingInput).toEqual(['pty-a']);
    });

    it('is recorded once when the detector reports the same dialog (a firm window)', () => {
      for (const detectorFirst of [false, true]) {
        const f = makeIngest();
        if (detectorFirst) f.ingest.arbitrateDetector('pty-a', AWAITING);
        f.ingest.handle(makeSignal({ payload: PERMISSION_REQUEST }));
        if (!detectorFirst) f.ingest.arbitrateDetector('pty-a', AWAITING);
        vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS * 2);
        expect(f.terminalPrompts, `detector first: ${detectorFirst}`).toHaveLength(1);
        expect(f.terminalPrompts[0]?.toolName).toBe('Bash');
      }
    });
  });

  it('a sink whose record creation rejects never leaves an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    vi.useRealTimers();
    try {
      const logs: string[] = [];
      const ingest = new HookIngest({
        listLiveSessions: () => [{ id: 'pty-a', cwd: '/repo', env: {} }],
        emitAgentEvent: () => undefined,
        applyResumeBinding: () => undefined,
        approvals: {
          noteHookAwaitingInput: () => undefined,
          noteGateAwaiting: () => 'gate-id',
          noteTerminalPrompt: async () => { throw new Error('registry exploded'); },
          expireForSession: () => undefined,
        },
        log: (_level, message) => { logs.push(message); },
      });
      ingest.handle(makeSignal({ payload: PERMISSION_REQUEST }));
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
      expect(logs.some((l) => l.includes('terminal prompt record failed'))).toBe(true);
      ingest.dispose();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  describe('from confirmed detector attention', () => {
    it('records a question-less dialog once the window confirms', () => {
      const f = makeIngest();
      expect(f.ingest.arbitrateDetector('pty-a', AWAITING).decision).toBe('pending');
      expect(f.terminalPrompts).toEqual([]);
      vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
      expect(f.detectorEmitted).toHaveLength(1);
      expect(f.terminalPrompts).toEqual([{ sessionId: 'pty-a', agent: 'claude', workspaceId: 'ws-1', source: 'detector' }]);
    });

    it('records nothing when the answer lands inside the window', () => {
      const f = makeIngest();
      f.ingest.arbitrateDetector('pty-a', AWAITING);
      vi.advanceTimersByTime(300);
      f.ingest.noteAnswered('pty-a', 'claude');
      vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS * 2);
      expect(f.terminalPrompts).toEqual([]);
    });

    it('records nothing when the daemon withheld the broadcast (#919 suppression)', () => {
      const f = makeIngest({ emitDetector: () => false });
      f.ingest.arbitrateDetector('pty-a', AWAITING);
      vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
      expect(f.terminalPrompts).toEqual([]);
    });

    it('records nothing for the brain pane, a non-Claude agent, or a pane that is gone', () => {
      const brain = makeIngest({ sessions: [{ id: 'pty-a', cwd: '/repo', env: { [ENV_KEYS.BRAIN_PTY]: '1' } }] });
      brain.ingest.arbitrateDetector('pty-a', AWAITING);
      const codex = makeIngest();
      codex.ingest.arbitrateDetector('pty-a', { ...AWAITING, agent: 'Codex CLI' });
      const gone = makeIngest({ sessions: [] });
      gone.ingest.arbitrateDetector('pty-a', AWAITING);
      vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
      expect(brain.terminalPrompts).toEqual([]);
      expect(codex.terminalPrompts).toEqual([]);
      expect(gone.terminalPrompts).toEqual([]);
    });

    it('a confirmed completion window records nothing', () => {
      const f = makeIngest();
      f.ingest.arbitrateDetector('pty-a', { agent: 'Claude Code', status: 'running', message: '' });
      f.ingest.arbitrateDetector('pty-a', { agent: 'Claude Code', status: 'complete', message: 'Task finished' });
      vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
      expect(f.detectorEmitted.map((d) => d.status)).toEqual(['complete']);
      expect(f.terminalPrompts).toEqual([]);
    });
  });
});
