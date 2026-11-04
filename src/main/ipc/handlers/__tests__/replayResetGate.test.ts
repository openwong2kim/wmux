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
import {
  createReplayResetGate, KITTY_POP_ALL, KITTY_POP_ALL_ALT, LEAVE_ALT_SCREEN, REPLAY_CLEAR, screenAfter,
} from '../replayResetGate';

// What pty.handler forwards: live and replay chunks through the gate, in order.
const live = (gate: ReturnType<typeof createReplayResetGate>, text: string) => gate.outgoing('s', text, false);
const replay = (gate: ReturnType<typeof createReplayResetGate>, text: string) => gate.outgoing('s', text, true);

describe('replay reset gate', () => {
  it("a session's first replay goes out as it is", () => {
    const gate = createReplayResetGate(() => undefined);
    expect(replay(gate, 'PS> ')).toBe('PS> ');
    expect(replay(gate, 'more')).toBe('more');
  });

  it('after a flush marker, only the first chunk of the next replay is clear-led', () => {
    const log = vi.fn();
    const gate = createReplayResetGate(log);
    replay(gate, 'PS> ');
    gate.flushed('s');
    expect(live(gate, 'echo a\r\n')).toBe('echo a\r\n');
    expect(replay(gate, 'PS> echo a\r\n')).toBe(`${REPLAY_CLEAR}PS> echo a\r\n`);
    expect(replay(gate, 'a\r\nPS> ')).toBe('a\r\nPS> ');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[lifecycle] pty.replay id=s reset=1');
  });

  it('leaves the alternate screen first when the pane is on it', () => {
    const log = vi.fn();
    const gate = createReplayResetGate(log);
    replay(gate, 'shell$ vim\r\n');
    gate.flushed('s');
    live(gate, '\x1b[?1049h\x1b[Hvim');
    const snapshot = 'shell$ vim\r\n\x1b[?1049h\x1b[Hvim';
    expect(replay(gate, snapshot)).toBe(`${LEAVE_ALT_SCREEN}${REPLAY_CLEAR}${snapshot}`);
    expect(log).toHaveBeenCalledWith('[lifecycle] pty.replay id=s reset=1 alt=1');
  });

  it('stays on the main screen when the pane is there, wherever the replay ends', () => {
    // The pane missed the switch to the alternate screen (a pipe gap).
    const gate = createReplayResetGate(() => undefined);
    replay(gate, 'shell$ claude\r\n\x1b[>1u');
    gate.flushed('s');
    const snapshot = 'shell$ claude\r\n\x1b[?1049h\x1b[Halt view';
    expect(replay(gate, snapshot)).toBe(`${REPLAY_CLEAR}${snapshot}`);
  });

  it('empties the alternate stack when the full-screen app quit while the pane was away', () => {
    const gate = createReplayResetGate(() => undefined);
    replay(gate, '\x1b[?1049h\x1b[>1uvim');
    gate.flushed('s');
    const snapshot = 'shell$ after\r\nshell$ ';
    expect(replay(gate, snapshot)).toBe(`${LEAVE_ALT_SCREEN}${KITTY_POP_ALL_ALT}${REPLAY_CLEAR}${snapshot}`);
  });

  it('counts its own lead: a replay it took back to the main screen leaves the pane there', () => {
    const gate = createReplayResetGate(() => undefined);
    replay(gate, '\x1b[?1049hvim');
    gate.flushed('s');
    // A ring that wrapped past vim's exit carries no screen switch of its own.
    expect(replay(gate, 'shell$ ').startsWith(LEAVE_ALT_SCREEN)).toBe(true);
    gate.flushed('s');
    // Another 1049l now would swap xterm's kitty flags of the two screens.
    expect(replay(gate, 'shell$ ')).toBe(`${REPLAY_CLEAR}shell$ `);
  });

  it('follows a screen switch split across chunks', () => {
    const gate = createReplayResetGate(() => undefined);
    replay(gate, 'PS> ');
    gate.flushed('s');
    live(gate, 'vim\r\n\x1b[?10');
    live(gate, '49h\x1b[Hvim');
    expect(replay(gate, 'x').startsWith(LEAVE_ALT_SCREEN)).toBe(true);
  });

  it('empties the kitty stacks when the replay pushes again', () => {
    const log = vi.fn();
    const gate = createReplayResetGate(log);
    const ring = 'shell$ claude\r\n\x1b[>1u> prompt';
    replay(gate, ring);
    gate.flushed('s');
    expect(replay(gate, ring)).toBe(`${KITTY_POP_ALL}${KITTY_POP_ALL_ALT}${REPLAY_CLEAR}${ring}`);
    expect(log).toHaveBeenCalledWith('[lifecycle] pty.replay id=s reset=1 kitty=1');
  });

  it('leaves a live re-flush, which opens with its own RIS, as it is, and follows its reset', () => {
    const gate = createReplayResetGate(() => undefined);
    replay(gate, '\x1b[?1049hvim');
    gate.flushed('s');
    expect(replay(gate, '\x1bcPS> ')).toBe('\x1bcPS> ');
    // ...the RIS took the pane to the main screen, and the next marker arms it again.
    gate.flushed('s');
    expect(replay(gate, 'PS> ')).toBe(`${REPLAY_CLEAR}PS> `);
  });

  it('every later flush marker arms it again', () => {
    const gate = createReplayResetGate(() => undefined);
    gate.flushed('s');
    expect(replay(gate, 'one')).toBe(`${REPLAY_CLEAR}one`);
    gate.flushed('s');
    expect(replay(gate, 'two')).toBe(`${REPLAY_CLEAR}two`);
  });

  it('a session that ended or restarted starts over: its next flush is appended, its screen forgotten', () => {
    const gate = createReplayResetGate(() => undefined);
    live(gate, '\x1b[?1049h');
    gate.flushed('s');
    gate.forget('s');
    expect(replay(gate, 'NEW> ')).toBe('NEW> ');
    gate.flushed('s');
    expect(replay(gate, 'NEW> ')).toBe(`${REPLAY_CLEAR}NEW> `);
  });

  it('sessions are kept apart', () => {
    const gate = createReplayResetGate(() => undefined);
    gate.flushed('a');
    gate.outgoing('b', '\x1b[?1049h', false);
    expect(gate.outgoing('b', 'b-replay', true)).toBe('b-replay');
    expect(gate.outgoing('a', 'a-replay', true)).toBe(`${REPLAY_CLEAR}a-replay`);
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
  // once a reconnect replaced the pipe (replacingPipe, after the old socket's
  // last chunk and before the new one's first).
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
    expect(replay(gate, decode(decoders, 's', Buffer.from('hello\r\n')))).toBe(`${REPLAY_CLEAR}hello\r\n`);
  });

  it('would, with the decoder kept', () => {
    const decoders = new Map<string, StringDecoder>();
    decode(decoders, 's', han.subarray(0, 2));
    expect(decode(decoders, 's', Buffer.from('hello')).startsWith('�')).toBe(true);
  });
});

describe('screenAfter', () => {
  it('follows the last screen switch', () => {
    expect(screenAfter('plain text', false)).toBe(false);
    expect(screenAfter('plain text', true)).toBe(true);
    expect(screenAfter('a\x1b[?1049hb', false)).toBe(true);
    expect(screenAfter('a\x1b[?1049hb\x1b[?1049lc', false)).toBe(false);
    expect(screenAfter('\x1b[?47h', false)).toBe(true);
    expect(screenAfter('\x1b[?1047h', false)).toBe(true);
    expect(screenAfter('\x1b[?25;1049h', false)).toBe(true);
    expect(screenAfter('\x1b[?1049h\x1bc', false)).toBe(false);
    expect(screenAfter('\x1b[?2004h\x1b[?1h', true)).toBe(true);
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

  it('passes every chunk of the create and reconnect listeners through it', () => {
    const pushes = src.match(/dataBatcher\.push\((\w+), replayResetGate\.outgoing\(\1, text, payload\.replay\), payload\.replay\);/g) ?? [];
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
