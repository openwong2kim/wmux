/**
 * A second ring flush of a session (a racing reattach, a late retry, a
 * reconnect after a daemon restart) must repaint the pane, not be appended to
 * what it already shows. The gate leads exactly the first chunk of every
 * replay after a forwarded flush marker with a terminal reset.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createReplayResetGate, REPLAY_RESET } from '../replayResetGate';

describe('replay reset gate', () => {
  it("a session's first replay goes out as it is", () => {
    const gate = createReplayResetGate(() => undefined);
    expect(gate.replayText('s', 'PS> ')).toBe('PS> ');
    expect(gate.replayText('s', 'more')).toBe('more');
  });

  it('after a flush marker, only the first chunk of the next replay is reset-led', () => {
    const log = vi.fn();
    const gate = createReplayResetGate(log);
    gate.replayText('s', 'PS> ');
    gate.flushed('s');
    expect(gate.replayText('s', 'PS> echo a\r\n')).toBe(`${REPLAY_RESET}PS> echo a\r\n`);
    expect(gate.replayText('s', 'a\r\nPS> ')).toBe('a\r\nPS> ');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[lifecycle] pty.replay id=s reset=1');
  });

  it('every later flush marker arms it again', () => {
    const gate = createReplayResetGate(() => undefined);
    gate.flushed('s');
    expect(gate.replayText('s', 'one')).toBe(`${REPLAY_RESET}one`);
    gate.flushed('s');
    expect(gate.replayText('s', 'two')).toBe(`${REPLAY_RESET}two`);
  });

  it('a session that ended or restarted starts over: its next flush is appended', () => {
    const gate = createReplayResetGate(() => undefined);
    gate.flushed('s');
    gate.forget('s');
    expect(gate.replayText('s', 'NEW> ')).toBe('NEW> ');
  });

  it('sessions are kept apart', () => {
    const gate = createReplayResetGate(() => undefined);
    gate.flushed('a');
    expect(gate.replayText('b', 'b-replay')).toBe('b-replay');
    expect(gate.replayText('a', 'a-replay')).toBe(`${REPLAY_RESET}a-replay`);
  });
});

/**
 * pty.handler is coupled to electron and the daemon client, so its wiring of
 * the gate is pinned at the source level, like the other pty.handler locks.
 */
describe('pty.handler feeds the gate (source-level lock)', () => {
  const src = readFileSync(path.resolve(process.cwd(), 'src/main/ipc/handlers/pty.handler.ts'), 'utf8');

  it('one gate for the main process, outside the handler registration', () => {
    expect(src.indexOf('const replayResetGate = createReplayResetGate();')).toBeGreaterThan(-1);
    expect(src.indexOf('const replayResetGate = createReplayResetGate();')).toBeLessThan(src.indexOf('export function registerPTYHandlers('));
  });

  it('arms it once a flush marker went to the renderer', () => {
    expect(src).toMatch(/IPC\.PTY_FLUSH_COMPLETE,\s*\n\s*payload\.sessionId,\s*\n\s*payload\.recoveredBytes,\s*\n\s*\);\s*\n\s*replayResetGate\.flushed\(payload\.sessionId\);/);
  });

  it('passes every replay chunk of the create and reconnect listeners through it', () => {
    const pushes = src.match(/dataBatcher\.push\((\w+), payload\.replay \? replayResetGate\.replayText\(\1, text\) : text, payload\.replay\);/g) ?? [];
    expect(pushes).toHaveLength(2);
    expect(src).not.toMatch(/dataBatcher\.push\(\w+, text, payload\.replay\)/);
  });

  it('forgets a session that ended, restarted or was disposed', () => {
    expect(src).toMatch(/function forgetCreateState\(sessionId: string\): void \{[^}]*replayResetGate\.forget\(sessionId\);/);
  });
});
