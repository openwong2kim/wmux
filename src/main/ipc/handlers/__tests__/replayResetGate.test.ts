/**
 * A second ring flush of a session (a racing reattach, a late retry, a
 * reconnect after a daemon restart) must repaint the pane, not be appended to
 * what it already shows. The gate leads exactly the first chunk of every
 * replay after a forwarded flush marker with a clear of the screen and the
 * scrollback (what that clear does to a real xterm is pinned in
 * src/renderer/terminal/__tests__/secondReplayClear.test.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { describe, expect, it, vi } from 'vitest';
import { createReplayResetGate, endsOnAltScreen, LEAVE_ALT_SCREEN, REPLAY_CLEAR } from '../replayResetGate';

describe('replay reset gate', () => {
  it("a session's first replay goes out as it is", () => {
    const gate = createReplayResetGate(() => undefined);
    expect(gate.replayText('s', 'PS> ')).toBe('PS> ');
    expect(gate.replayText('s', 'more')).toBe('more');
  });

  it('after a flush marker, only the first chunk of the next replay is clear-led', () => {
    const log = vi.fn();
    const gate = createReplayResetGate(log);
    gate.replayText('s', 'PS> ');
    gate.flushed('s');
    expect(gate.replayText('s', 'PS> echo a\r\n')).toBe(`${REPLAY_CLEAR}PS> echo a\r\n`);
    expect(gate.replayText('s', 'a\r\nPS> ')).toBe('a\r\nPS> ');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[lifecycle] pty.replay id=s reset=1');
  });

  it('leaves the alternate screen first when the replay ends on it', () => {
    const log = vi.fn();
    const gate = createReplayResetGate(log);
    gate.flushed('s');
    const snapshot = 'shell$ vim\r\n\x1b[?1049h\x1b[Hvim';
    expect(gate.replayText('s', snapshot)).toBe(`${LEAVE_ALT_SCREEN}${REPLAY_CLEAR}${snapshot}`);
    expect(log).toHaveBeenCalledWith('[lifecycle] pty.replay id=s reset=1 alt=1');
  });

  it('leaves a live re-flush, which opens with its own RIS, as it is', () => {
    const gate = createReplayResetGate(() => undefined);
    gate.flushed('s');
    expect(gate.replayText('s', '\x1bcPS> ')).toBe('\x1bcPS> ');
    // ...and the next marker arms it again.
    gate.flushed('s');
    expect(gate.replayText('s', 'PS> ')).toBe(`${REPLAY_CLEAR}PS> `);
  });

  it('every later flush marker arms it again', () => {
    const gate = createReplayResetGate(() => undefined);
    gate.flushed('s');
    expect(gate.replayText('s', 'one')).toBe(`${REPLAY_CLEAR}one`);
    gate.flushed('s');
    expect(gate.replayText('s', 'two')).toBe(`${REPLAY_CLEAR}two`);
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
    expect(gate.replayText('a', 'a-replay')).toBe(`${REPLAY_CLEAR}a-replay`);
  });

  it('the clear resets no mode the app negotiated, and erases the screen and the scrollback', () => {
    // Not RIS (it drops kitty flags and a DEC 2026 hold), no 1049 switch (xterm
    // swaps kitty flags on every one), no mouse, paste, focus or 2026 mode.
    expect(REPLAY_CLEAR).not.toContain('\x1bc');
    // eslint-disable-next-line no-control-regex
    expect(REPLAY_CLEAR).not.toMatch(/\x1b\[\?(?:1049|1047|47|1000|1002|1003|1004|1006|2004|2026)[hl]/);
    expect(REPLAY_CLEAR.endsWith('\x1b[H\x1b[2J\x1b[3J')).toBe(true);
  });
});

describe("a replaced pipe's half code point", () => {
  // pty.handler decodes per session (decodeSessionData) and drops the decoder
  // when a reconnect replaces the pipe (replacingPipe).
  const decode = (decoders: Map<string, StringDecoder>, id: string, bytes: Buffer) => {
    let d = decoders.get(id);
    if (!d) { d = new StringDecoder('utf8'); decoders.set(id, d); }
    return d.write(bytes);
  };
  const han = Buffer.from('한');

  it('does not reach the repainted screen once the decoder is dropped', () => {
    const decoders = new Map<string, StringDecoder>();
    const gate = createReplayResetGate(() => undefined);
    gate.flushed('s');
    // The old pipe's last live chunk ends inside a 3-byte code point; the rest
    // went with the forceFresh-destroyed socket.
    expect(decode(decoders, 's', Buffer.concat([Buffer.from('live '), han.subarray(0, 2)]))).toBe('live ');
    decoders.delete('s');
    const replay = gate.replayText('s', decode(decoders, 's', Buffer.from('hello\r\n')));
    expect(replay).toBe(`${REPLAY_CLEAR}hello\r\n`);
  });

  it('would, with the decoder kept', () => {
    const decoders = new Map<string, StringDecoder>();
    decode(decoders, 's', han.subarray(0, 2));
    expect(decode(decoders, 's', Buffer.from('hello')).startsWith('\ufffd')).toBe(true);
  });
});

describe('endsOnAltScreen', () => {
  it('follows the last screen switch', () => {
    expect(endsOnAltScreen('plain text')).toBe(false);
    expect(endsOnAltScreen('a\x1b[?1049hb')).toBe(true);
    expect(endsOnAltScreen('a\x1b[?1049hb\x1b[?1049lc')).toBe(false);
    expect(endsOnAltScreen('\x1b[?47h')).toBe(true);
    expect(endsOnAltScreen('\x1b[?1047h')).toBe(true);
    expect(endsOnAltScreen('\x1b[?25;1049h')).toBe(true);
    expect(endsOnAltScreen('\x1b[?1049h\x1bc')).toBe(false);
    expect(endsOnAltScreen('\x1b[?2004h\x1b[?1h')).toBe(false);
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

  it("drops the session's decoder when a reconnect replaces its pipe", () => {
    expect(src).toMatch(/replacingPipe: \(\) => sessionDecoders\.delete\(id\),/);
  });
});
