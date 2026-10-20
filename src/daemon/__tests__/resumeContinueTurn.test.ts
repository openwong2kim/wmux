// A pane whose agent was mid-turn when the daemon died is resumed with a
// prompt that continues the turn. The bridge reports the agent's turn edges
// ('agentTurn'), the session manager keeps them on meta.turnRunningSince (so
// they are persisted), and recovery reads the OLD record's mark into a
// one-shot `resumeWasRunning` on daemon.listSessions.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { PromptEventLog } from '../PromptEventLog';
import { RingBuffer } from '../RingBuffer';
import { RESUME_CONTINUE_MAX_QUIET_MS, recordWasMidTurn, recordedTurnStillOpen } from '../recoveryHint';
import { transcriptTurnState } from '../transcript/chatAgentStatus';
import { parseTranscriptLineDetailed } from '../transcript/parseEntry';
import { parseCodexLineDetailed } from '../transcript/parseCodexEntry';
import type { TurnEvent } from '../../shared/transcript/turnEvents';

function makeFakePty(): IPty {
  return {
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as IPty;
}

describe('transcriptTurnState — the agent\'s own transcript says whether its last turn is open', () => {
  const ts = '2026-10-20T12:00:00.000Z';
  const claude = (lines: object[]): TurnEvent[] => lines.flatMap((l, i) => parseTranscriptLineDetailed(JSON.stringify({ timestamp: ts, uuid: `u${i}`, ...l }), i).events);
  const codex = (lines: object[]): TurnEvent[] => lines.flatMap((l, i) => parseCodexLineDetailed(JSON.stringify({ timestamp: ts, ...l }), i).events);
  const prompt = { type: 'user', message: { role: 'user', content: 'fix the build' } };
  const toolUse = { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } };
  const toolResult = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } };
  const endTurn = { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } };
  const interrupted = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } };

  it('a Claude turn mid-tool, or a prompt with no reply yet, is open', () => {
    expect(transcriptTurnState(claude([prompt, toolUse]))).toBe('open');
    expect(transcriptTurnState(claude([prompt, toolUse, toolResult]))).toBe('open');
    expect(transcriptTurnState(claude([endTurn, prompt]))).toBe('open');
  });

  it('a Claude turn the user interrupted, or one that finished, has ended', () => {
    expect(transcriptTurnState(claude([prompt, toolUse, interrupted]))).toBe('ended');
    expect(transcriptTurnState(claude([prompt, toolUse, toolResult, endTurn]))).toBe('ended');
  });

  it('subagent rows after a finished reply do not reopen it, however many', () => {
    const side = { type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent task' } };
    expect(transcriptTurnState(claude([prompt, endTurn, ...Array.from({ length: 60 }, () => side)]))).toBe('ended');
  });

  it('Codex: turn_aborted and task_complete end the turn, task_started opens one', () => {
    const ev = (type: string) => ({ type: 'event_msg', payload: { type, turn_id: 'turn-1' } });
    expect(transcriptTurnState(codex([ev('task_started')]))).toBe('open');
    expect(transcriptTurnState(codex([ev('task_started'), ev('turn_aborted')]))).toBe('ended');
    expect(transcriptTurnState(codex([ev('task_started'), ev('task_complete')]))).toBe('ended');
  });

  it('an empty or unreadable tail is unknown', () => {
    expect(transcriptTurnState([])).toBe('unknown');
    expect(transcriptTurnState(undefined)).toBe('unknown');
  });

  it('recovery continues nothing without a transcript it can read', () => {
    expect(recordedTurnStillOpen(undefined)).toBe(false);
    expect(recordedTurnStillOpen({ agent: 'claude', sessionId: 's', cwd: '/tmp', ts: 0 })).toBe(false);
    expect(recordedTurnStillOpen({ agent: 'claude', sessionId: '0d9c1b52-1e6a-4b8e-9f0a-1c2d3e4f5a6b', cwd: '/tmp', ts: 0, transcriptPath: '/nonexistent/x.jsonl' })).toBe(false);
  });
});

describe('DaemonPTYBridge — agentTurn edges', () => {
  let bridge: DaemonPTYBridge;
  let edges: Array<number | null>;

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = new DaemonPTYBridge();
    bridge.setupDataForwarding(makeFakePty(), new RingBuffer(65536), 'sess-1', new PromptEventLog());
    edges = [];
    bridge.on('agentTurn', (p: { sessionId: string; runningSince: number | null }) => {
      expect(p.sessionId).toBe('sess-1');
      edges.push(p.runningSince);
    });
  });

  afterEach(() => {
    bridge.cleanup();
    vi.useRealTimers();
  });

  it('a hook turn reports its start and its end, once each', () => {
    bridge.noteInput('fix the build\r');
    bridge.noteAgentStatus('running', true); // UserPromptSubmit
    bridge.noteAgentStatus('running', true); // a tool hook inside the same turn
    expect(edges).toHaveLength(1);
    expect(typeof edges[0]).toBe('number');
    expect(bridge.isAgentMidTurn()).toBe(true);
    bridge.noteAgentStatus('complete', true); // Stop
    expect(edges).toEqual([edges[0], null]);
    expect(bridge.isAgentMidTurn()).toBe(false);
  });

  it('a submit into a plain shell is not an agent turn', () => {
    bridge.noteInput('git status\r');
    expect(bridge.isTurnOpen()).toBe(true);
    expect(bridge.isAgentMidTurn()).toBe(false);
    expect(edges).toEqual([]);
  });

  it('the launch Enter alone (a boot episode) is not a turn to continue', () => {
    bridge.noteInput('codex\r');
    bridge.noteAgentProcess({ slug: 'codex', alive: true });
    expect(bridge.isTurnOpen()).toBe(true);
    expect(bridge.isAgentMidTurn()).toBe(false);
    expect(edges).toEqual([]);
  });

  it('a hookless agent counts once its process is tracked, and ends with it', () => {
    bridge.noteInput('codex\r'); // the launch, inside the boot window
    bridge.noteAgentProcess({ slug: 'codex', alive: true });
    bridge.noteInput('refactor the parser\r');
    expect(edges).toHaveLength(1);
    expect(typeof edges[0]).toBe('number');
    bridge.noteAgentEnded();
    expect(edges[1]).toBeNull();
    expect(bridge.isAgentMidTurn()).toBe(false);
  });

  it('an open turn becomes an agent turn when the agent process is attributed', () => {
    bridge.noteInput('claude\r');
    bridge.noteInput('do it\r');
    expect(edges).toEqual([]);
    bridge.noteAgentProcess({ slug: 'claude', alive: true });
    expect(edges).toHaveLength(1);
    expect(typeof edges[0]).toBe('number');
  });

  it('a SessionStart outside a turn leaves no turn reported', () => {
    bridge.noteSessionStart(Date.now(), 'startup');
    expect(bridge.isAgentMidTurn()).toBe(false);
    expect(edges.at(-1) ?? null).toBeNull();
  });
});

describe('recordWasMidTurn — the old record says the agent was mid-turn', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const recent = new Date(now - 5_000).toISOString();

  it('true for a record with a running turn and recent output', () => {
    expect(recordWasMidTurn({ turnRunningSince: now - 60_000, lastActivity: recent }, now)).toBe(true);
  });

  it('false without a mark, or with a malformed one', () => {
    expect(recordWasMidTurn({ lastActivity: recent }, now)).toBe(false);
    expect(recordWasMidTurn({ turnRunningSince: 'soon', lastActivity: recent }, now)).toBe(false);
    expect(recordWasMidTurn({ turnRunningSince: Number.NaN, lastActivity: recent }, now)).toBe(false);
    expect(recordWasMidTurn({ turnRunningSince: 0, lastActivity: recent }, now)).toBe(false);
  });

  it('true for a continue an earlier recovery still owed (a second death before the resume)', () => {
    expect(recordWasMidTurn({ resumeContinuePending: true, lastActivity: recent }, now)).toBe(true);
    expect(recordWasMidTurn({ resumeContinuePending: 'yes', lastActivity: recent }, now)).toBe(false);
  });

  it('false when the pane was quiet for longer than the bound', () => {
    const stale = new Date(now - RESUME_CONTINUE_MAX_QUIET_MS - 1).toISOString();
    expect(recordWasMidTurn({ turnRunningSince: now - RESUME_CONTINUE_MAX_QUIET_MS - 60_000, lastActivity: stale }, now)).toBe(false);
    expect(recordWasMidTurn({ turnRunningSince: now - 60_000, lastActivity: 'not a date' }, now)).toBe(false);
  });
});

// The manager wiring and the recovery/listSessions code live in closures that
// need a real PTY or main(); their contracts are locked at the source, like
// x6ResumeDurability.test.ts does for the other recovery markers.
describe('turnRunningSince wiring', () => {
  const read = (file: string): string => fs.readFileSync(path.join(__dirname, '..', file), 'utf-8');

  it('the session manager mirrors agentTurn onto meta and re-emits it', () => {
    const src = read('DaemonSessionManager.ts');
    const at = src.indexOf("bridge.on('agentTurn'");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 400);
    expect(body).toMatch(/if \(payload\.runningSince === null\) delete meta\.turnRunningSince;\s*else meta\.turnRunningSince = payload\.runningSince;/);
    expect(body).toMatch(/this\.emit\('session:agentTurn', payload\)/);
  });

  it('the daemon persists an edge within a second, not on the 30 s debounce', () => {
    const src = read('index.ts');
    const at = src.indexOf("sessionManager.on('session:agentTurn'");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 400);
    expect(body).toMatch(/stateWriter\.saveAsap\(buildState\(sessionManager\)\)/);
    expect(body).not.toMatch(/saveDebounced/);
    expect(src).toMatch(/const AGENT_TURN_SAVE_DELAY_MS = 1_000;/);
  });

  it('recovery reads the mark off the persisted record, never the recovered meta', () => {
    const src = read('index.ts');
    const rec = src.slice(src.indexOf('for (const recoveredId of recoveredIds) {'));
    expect(rec).toMatch(/if \(m\.resumeContinuePending && recordedTurnStillOpen\(recoveredResumeBindings\.get\(recoveredId\) \?\? m\.resumeBinding, m\.env\)\) \{\s*recoveredWasRunning\.add\(recoveredId\);\s*\} else delete m\.resumeContinuePending;/);
    // The carry-forward reads the OLD record into the owed continue, before
    // the merged recovery save, and never copies the raw mark onto the new meta.
    const carry = src.slice(src.indexOf('for (const persisted of state.sessions) {'), src.indexOf('diskOnlySessions = state.sessions.filter('));
    expect(carry).not.toMatch(/turnRunningSince/);
    expect(carry).toMatch(/if \(recordWasMidTurn\(persisted, Date\.now\(\)\)\) managed\.meta\.resumeContinuePending = true;/);
  });

  it('an owed continue lives on the meta, so every save keeps it until spent, and never reaches clients', () => {
    const src = read('index.ts');
    const spend = src.slice(src.indexOf('function spendContinue('), src.indexOf('function spendContinue(') + 600);
    expect(spend).toMatch(/recoveredWasRunning\.delete\(id\);/);
    expect(spend).toMatch(/delete meta\.resumeContinuePending;\s*void stateWriter\.saveAsap\(buildState\(sessionManager\)\);/);
    // No other path forgets the in-memory mark without the record.
    expect(src.match(/recoveredWasRunning\.delete\(/g)).toHaveLength(1);
    const at = src.indexOf("pipeServer.onRpc('daemon.listSessions'");
    expect(src.slice(at, at + 9000)).toMatch(/delete base\.resumeContinuePending;/);
  });

  it('listSessions strips the raw field and surfaces the one-shot mark with the offer only', () => {
    const src = read('index.ts');
    const at = src.indexOf("pipeServer.onRpc('daemon.listSessions'");
    const body = src.slice(at, src.indexOf("pipeServer.onRpc('daemon.promoteSession'", at) > 0 ? src.indexOf("pipeServer.onRpc('daemon.promoteSession'", at) : at + 9000);
    expect(body).toMatch(/delete base\.turnRunningSince;/);
    expect(body).toMatch(/if \(!resumeAgent\) spendContinue\(sessionManager, stateWriter, s\.id\);/);
    const withAgent = body.slice(body.indexOf('const withAgent = resumeAgent'), body.indexOf(': withRuntime;'));
    expect(withAgent).toMatch(/recoveredWasRunning\.has\(s\.id\) \? \{ resumeWasRunning: true as const \}/);
  });

  it('the mark is spent wherever the offer is, and by the first submit', () => {
    const src = read('index.ts');
    // Every place that drops a recovered binding drops the mark with it.
    const bindingDeletes = src.match(/recoveredResumeBindings\.delete\(([\w.]+)\);[^\n]*\n\s*spendContinue\(sessionManager, stateWriter, \1\);/g) ?? [];
    expect(bindingDeletes).toHaveLength(5);
    const at = src.indexOf("sessionManager.on('session:inputSubmitted', (payload: { sessionId: string }) => {");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 200)).toMatch(/spendContinue\(sessionManager, stateWriter, payload\.sessionId\);/);
  });
});
