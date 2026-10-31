// #2771 — a program's own OSC 133 marks, written while a shell command runs,
// are decided at the stream source: the ring, live data, a late attacher's
// replay and the prompt log all read the same lowercase kind for them, and
// the shell's own marks are unchanged.
//
// Runs on both engines: under vitest.rust-engine.config.ts the ring is the
// native ring and the native harness feeds real decoder chunks.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { RingBuffer } from '../RingBuffer';
import { PromptEventLog } from '../PromptEventLog';
import { loadNativeTerminalCore, type NativeOutputChunk } from '../../shared/nativeTerminalCore';

const ESC = '\x1b';
const BEL = '\x07';
const mark = (kind: string) => `${ESC}]133;${kind}${BEL}`;
const lower = (text: string) => text.replace(/\]133;([ABCD])/g, (_m, k: string) => `]133;${k.toLowerCase()}`);

type Lane = 'string' | 'native';

/** A real decoder chunk on the rust engine, else one that behaves like it. */
function chunkOf(text: string): NativeOutputChunk {
  if (process.env.WMUX_TERMINAL_CORE === 'rust') {
    const Decoder = loadNativeTerminalCore('pty-v1').NativeOutputDecoder;
    if (Decoder) return new Decoder().feed(Buffer.from(text), true);
  }
  return { text, byteLength: Buffer.byteLength(text), readBytes: () => Buffer.from(text), dispose: () => undefined };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

function rig(lane: Lane, opts: { shellMarks?: 'exec' | 'integrated' | 'plain'; prefill?: string } = {}) {
  let onString: ((data: string) => void) | undefined;
  let onNative: ((chunk: NativeOutputChunk) => void) | undefined;
  const pty = {
    onData: (cb: (data: string) => void) => { onString = cb; return { dispose: () => { onString = undefined; } }; },
    ...(lane === 'native' ? {
      onNativeData: (cb: (chunk: NativeOutputChunk) => void) => { onNative = cb; return { dispose: () => { onNative = undefined; } }; },
    } : {}),
    onExit: () => ({ dispose: () => undefined }),
    write: vi.fn(),
  } as unknown as IPty;
  const ring = new RingBuffer(65536);
  if (opts.prefill) ring.write(Buffer.from(opts.prefill));
  const log = new PromptEventLog();
  const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const bridge = new DaemonPTYBridge();
  const live: Buffer[] = [];
  bridge.on('data', (b: Buffer) => live.push(Buffer.from(b)));
  bridge.setupDataForwarding(pty, ring, 'marks', log, opts.shellMarks ?? 'integrated');
  cleanups.push(() => { bridge.cleanup(); ring.dispose(); });
  const feed = (text: string) => {
    if (lane === 'native') onNative?.(chunkOf(text));
    else onString?.(text);
  };
  return {
    bridge, ring, log, live, feed,
    types: () => log.recent(100).map((e) => e.type),
    lowered: () => logged.mock.calls.filter((c) => String(c[0]).includes('program-written OSC 133 marks lowercased')).length,
  };
}

// The shell starts a command (kimi), kimi prints its own prompt and a reply,
// then the user leaves it and the shell prompts again.
const SHELL_C = mark('C');
const KIMI = mark('A') + 'kimi> ' + mark('B') + mark('C') + 'reply text\r\n';
const BACK = mark('A') + 'more' + mark('D;0') + mark('A') + 'PS> ' + mark('B');
// What the prompt log reads from SHELL_C + KIMI + bare D + BACK when every
// mark is taken for the shell's, as on a pane with no scan.
const PLAIN_TYPES = [
  'command_start', 'prompt_start', 'prompt_end', 'command_start', 'command_end',
  'prompt_start', 'command_end', 'prompt_start', 'prompt_end',
];

for (const lane of ['string', 'native'] as const) {
  describe(`DaemonPTYBridge shell-mark ingress (${lane} output)`, () => {
    it('D1: the ring, live data and a late replay agree, and only the shell\'s marks reach the prompt log', () => {
      const h = rig(lane);
      h.feed(SHELL_C);
      h.feed(KIMI);
      h.feed(BACK);
      const expected = SHELL_C + lower(KIMI) + lower(mark('A')) + 'more' + mark('D;0') + mark('A') + 'PS> ' + mark('B');
      expect(h.ring.readAll().toString()).toBe(expected);
      expect(Buffer.concat(h.live).toString()).toBe(expected);
      // A late attacher replays the ring.
      expect(h.ring.readAll().toString()).toBe(Buffer.concat(h.live).toString());
      expect(h.types()).toEqual(['command_start', 'command_end', 'prompt_start', 'prompt_end']);
      expect(h.log.recent(100)[1]).toMatchObject({ type: 'command_end', exitCode: 0 });
      expect(h.bridge.getCommandStarts()).toBe(1);
      expect(h.lowered()).toBe(1);
    });

    it('D2: the shell\'s D;0 and A split at every byte return to the prompt at every split', () => {
      const tail = mark('D;0') + mark('A');
      for (let at = 0; at <= tail.length; at++) {
        const h = rig(lane);
        h.feed(SHELL_C);
        h.feed(KIMI);
        const first = tail.slice(0, at);
        h.feed(first);
        h.feed(tail.slice(at));
        // The A after the shell's D;0 is the shell's: back at the prompt.
        expect(h.ring.readAll().toString(), `split at ${at}`).toBe(SHELL_C + lower(KIMI) + tail);
        // The JS OSC parser drops a sequence whose ESC alone ends a read (a
        // separate, older gap); everywhere else the prompt log is exact.
        const events = first.endsWith(ESC) ? h.types().filter((t) => t !== 'command_end' && t !== 'prompt_start') : h.types();
        const want = first.endsWith(ESC) ? ['command_start'] : ['command_start', 'command_end', 'prompt_start'];
        expect(events, `split at ${at}`).toEqual(want);
        cleanups.splice(0).forEach((c) => c());
      }
    });

    it('D2: a bare D split right after its kind byte keeps its case, and the state stays running', () => {
      const h = rig(lane);
      h.feed(SHELL_C);
      h.feed(`${ESC}]133;D`);
      h.feed(BEL + mark('A'));
      // The A after it is lowercased: the state stayed running.
      expect(h.ring.readAll().toString()).toBe(SHELL_C + `${ESC}]133;D` + BEL + mark('a'));
    });

    it('a program\'s mark split at every byte across two reads, after a plain read, is still lowercased', () => {
      // Pins the chunk gate (ShellMarkIngress.wants): a read that ends in any
      // prefix of the mark must be scanned so the carry is set.
      const m = mark('A') + 'kimi> ';
      for (let at = 1; at < m.length; at++) {
        const h = rig(lane);
        h.feed(SHELL_C);
        h.feed('plain output with \x1b[32mcolor\x1b[0m\r\n');
        h.feed(m.slice(0, at));
        h.feed(m.slice(at));
        expect(h.ring.readAll().toString(), `split at ${at}`).toBe(SHELL_C + 'plain output with \x1b[32mcolor\x1b[0m\r\n' + mark('a') + 'kimi> ');
        expect(h.types(), `split at ${at}`).toEqual(['command_start']);
        cleanups.splice(0).forEach((c) => c());
      }
    });

    it('D3: a second C before the shell\'s D;<n> is the program\'s', () => {
      const h = rig(lane);
      h.feed(mark('C') + mark('C') + mark('D;0') + mark('A') + mark('B'));
      expect(h.ring.readAll().toString()).toBe(mark('C') + mark('c') + mark('D;0') + mark('A') + mark('B'));
      expect(h.types()).toEqual(['command_start', 'command_end', 'prompt_start', 'prompt_end']);
      expect(h.bridge.getCommandStarts()).toBe(1);
    });

    it('D4 (guard): ESC]1337 split at every byte is never a mark, in any state', () => {
      const seq = `${ESC}]1337;File=inline=1:QUJD${BEL}`;
      for (let at = 0; at <= seq.length; at++) {
        const h = rig(lane);
        h.feed(SHELL_C);
        h.feed(seq.slice(0, at));
        h.feed(seq.slice(at));
        expect(h.ring.readAll().toString()).toBe(SHELL_C + seq);
        expect(h.types()).toEqual(['command_start']);
        // Still running: a program's A after it is its own.
        h.feed(mark('A'));
        expect(h.ring.readAll().toString()).toBe(SHELL_C + seq + mark('a'));
        cleanups.splice(0).forEach((c) => c());
      }
    });

    it('D5: a muted recovery holds the decided bytes and replays them without a prompt event', () => {
      const h = rig(lane);
      h.feed(SHELL_C);
      h.bridge.setMuted(true);
      h.feed(mark('A') + 'kimi> ');
      h.bridge.setMuted(false, { replayHeld: true });
      expect(h.ring.readAll().toString()).toBe(SHELL_C + mark('a') + 'kimi> ');
      expect(h.types()).toEqual(['command_start']);
    });

    it('an exec unit has no shell prompt: its marks are the program\'s until a D;<n>', () => {
      const h = rig(lane, { shellMarks: 'exec' });
      h.feed(mark('A') + mark('B') + mark('C'));
      expect(h.ring.readAll().toString()).toBe(mark('a') + mark('b') + mark('c'));
      expect(h.types()).toEqual([]);
      h.feed(mark('D;0') + mark('A'));
      expect(h.ring.readAll().toString()).toBe(mark('a') + mark('b') + mark('c') + mark('D;0') + mark('A'));
    });

    it('a recovered ring ending inside a shell command does not seed the state: the new shell starts at its prompt', () => {
      // A bridge is only built for a freshly spawned process; the ring holds
      // the dead one's scrollback.
      const prefill = mark('D;0') + mark('A') + mark('B') + mark('C') + lower(KIMI);
      const h = rig(lane, { prefill });
      h.feed(mark('A') + 'PS> ' + mark('B'));
      expect(h.ring.readAll().toString()).toBe(prefill + mark('A') + 'PS> ' + mark('B'));
      expect(h.types()).toEqual(['prompt_start', 'prompt_end']);
    });

    it('a plain pane (no wmux integration) passes every mark through as it is', () => {
      const h = rig(lane, { shellMarks: 'plain' });
      const input = SHELL_C + KIMI + mark('D') + BACK;
      h.feed(SHELL_C);
      h.feed(KIMI);
      h.feed(mark('D') + BACK);
      expect(h.ring.readAll().toString()).toBe(input);
      expect(Buffer.concat(h.live).toString()).toBe(input);
      expect(h.lowered()).toBe(0);
      // Every mark is read as the shell's, as on a pane without the ingress.
      expect(h.types()).toEqual(PLAIN_TYPES);
    });
  });
}

