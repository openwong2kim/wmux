// The streams the tail was measured on (Fleet's preview and StallWatch's
// screen), smaller: whatever the guarded tail serves must equal the whole
// ring's answer, and it must still serve the streams it can.
import { afterAll, describe, expect, it } from 'vitest';
import { RingBuffer } from '../RingBuffer';
import { OutputModeTracker } from '../util/outputModeTracker';
import { generateTextSnapshotUnqueued, type TextSnapshotOutcome } from '../HeadlessSnapshot';
import { snapshotRingTextUnqueued } from '../nativeRingSnapshot';
import { readSessionTextReplay } from '../sessionTextReplay';
import { guardedTailRead, resetTailReadCounters, tailReadCounters, type GuardedTailSession } from '../guardedTailRead';

const KiB = 1024;
let seed = 7;
const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const word = () => Array.from({ length: 2 + rnd(9) }, () => String.fromCharCode(97 + rnd(26))).join('');
const sentence = (n: number) => Array.from({ length: n }, word).join(' ');

type Step = string | { resize: [number, number] };

function* tuiRepaint(rows: number, alt = false): Generator<Step> {
  if (alt) yield '\x1b[?1049h\x1b[H\x1b[2J';
  for (let n = 0; ; n++) {
    let out = '\x1b[H';
    for (let r = 1; r < rows; r++) out += `\x1b[${r};1H\x1b[3${r % 7}m${r % 5 === 0 ? '한글 ' : ''}item ${n}:${r} ${'x'.repeat(5 + rnd(50))}\x1b[0m\x1b[K`;
    yield `${out}\x1b[${rows};1H${'|/-\\'[n % 4]} frame ${n}\x1b[K`;
  }
}

/** Claude Code's inline renderer: ink redraws its bottom region in a synchronized update. */
function* claude(opts: { idleFrom?: number } = {}): Generator<Step> {
  let prev = 0;
  let tokens = 0;
  for (let n = 0; ; n++) {
    let out = '\x1b[?2026h' + '\x1b[2K\x1b[1A'.repeat(prev) + '\x1b[2K\x1b[G';
    if (!(opts.idleFrom !== undefined && n >= opts.idleFrom) && rnd(6) === 0) {
      for (let i = 0, lines = 1 + rnd(5); i < lines; i++) out += `${i === 0 ? '⏺ ' : '  '}${sentence(4 + rnd(30))}\r\n`;
      out += '\r\n';
    }
    tokens += 1 + rnd(40);
    const frame = [
      `${'✻✶✳✢✽'[n % 5]} Ruminating… (${Math.floor(n / 10)}s · ↓ ${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens)`,
      '', `╭${'─'.repeat(78)}╮`, `│ > ${' '.repeat(75)}│`, `╰${'─'.repeat(78)}╯`, '  ? for shortcuts',
    ];
    prev = frame.length - 1;
    yield `${out}${frame.join('\r\n')}\x1b[?2026l`;
  }
}

/** Claude Code's fullscreen renderer: one paint, then only the cells that change. */
function* claudeDiff(rows: number): Generator<Step> {
  const spin = rows - 5;
  yield '\x1b[?1049h\x1b[H\x1b[2J';
  for (let r = 1; r < spin - 1; r++) yield `\x1b[${r};1H${r === 1 ? '⏺ started' : ''}`;
  yield `\x1b[${spin};1H✻ Ruminating… (0s · ↓ 0 tokens)`;
  yield `\x1b[${spin + 2};1H╭${'─'.repeat(78)}╮\x1b[${spin + 3};1H│ > ${' '.repeat(75)}│\x1b[${spin + 4};1H╰${'─'.repeat(78)}╯`;
  let tokens = 0;
  for (let n = 1; ; n++) {
    let out = `\x1b[?2026h\x1b[${spin};1H${'✻✶✳✢✽'[n % 5]}`;
    if (rnd(3) === 0) out += `\x1b[${spin};22H${(tokens += 1 + rnd(40))} tokens)\x1b[K`;
    yield `${out}\x1b[?2026l`;
  }
}

function* scrolling(): Generator<Step> {
  for (let i = 0; ; i++) yield `[${String(i).padStart(7)}] ${sentence(3 + rnd(25))}\r\n`;
}

function* longIdleTui(rows: number): Generator<Step> {
  yield '\x1b[?1049h\x1b[H\x1b[2J';
  for (let r = 1; r <= rows; r++) yield `\x1b[${r};1H${r === 1 ? 'MONITOR' : `row ${r}: ${sentence(5 + rnd(8))}`}`;
  for (let t = 0; ; t++) yield `\x1b[1;60H${String(t).padStart(8, '0')} ${'|/-\\'[t % 4]}`;
}

function* withResize(): Generator<Step> {
  const first = claude();
  for (let i = 0; i < 1500; i++) yield first.next().value as Step;
  yield { resize: [80, 24] };
  yield* claude();
}

const fixtures: Array<{ name: string; capacity: number; target: number; steps: () => Generator<Step>; serves?: boolean }> = [
  { name: 'tui-repaint', capacity: 1024 * KiB, target: 640 * KiB, steps: () => tuiRepaint(30), serves: true },
  { name: 'claude-sync', capacity: 1024 * KiB, target: 640 * KiB, steps: () => claude(), serves: true },
  { name: 'plain-scroll', capacity: 1024 * KiB, target: 640 * KiB, steps: scrolling, serves: true },
  { name: 'long-idle-tui', capacity: 1024 * KiB, target: 640 * KiB, steps: () => longIdleTui(30) },
  { name: 'long-idle-claude', capacity: 1024 * KiB, target: 640 * KiB, steps: () => claude({ idleFrom: 400 }) },
  { name: 'alt-screen-early', capacity: 1024 * KiB, target: 640 * KiB, steps: () => tuiRepaint(30, true), serves: true },
  { name: 'resize-before-tail', capacity: 1024 * KiB, target: 640 * KiB, steps: withResize },
  { name: 'claude-fullscreen-diff', capacity: 1024 * KiB, target: 640 * KiB, steps: () => claudeDiff(30) },
  { name: 'wrapped-ring', capacity: 512 * KiB, target: 1536 * KiB, steps: () => claude(), serves: true },
];

const SAMPLES = 4;
const rowsOf = (o: TextSnapshotOutcome) => (o.ok ? o.rows : null);

afterAll(() => resetTailReadCounters());

describe('guarded tail on the measured streams', () => {
  for (const fx of fixtures) {
    it(`${fx.name}: every served answer equals the whole ring's`, { timeout: 120_000 }, async () => {
      seed = 7;
      resetTailReadCounters();
      const ringBuffer = new RingBuffer(fx.capacity);
      const outputModes = new OutputModeTracker();
      const meta = { cols: 100, rows: 30 };
      ringBuffer.noteGeometry(meta.cols, meta.rows);
      const s: GuardedTailSession = { meta, ringBuffer, bridge: { outputModes } };
      const gen = fx.steps();
      let written = 0;
      let next = fx.target / SAMPLES;
      let served = 0;
      while (written < fx.target) {
        const step = gen.next().value as Step;
        if (typeof step !== 'string') {
          [meta.cols, meta.rows] = step.resize;
          ringBuffer.noteGeometry(meta.cols, meta.rows);
          continue;
        }
        ringBuffer.write(Buffer.from(step, 'utf8'));
        written += Buffer.byteLength(step, 'utf8');
        outputModes.feed(step, ringBuffer.totalBytesWritten);
        if (written < next) continue;
        next += fx.target / SAMPLES;
        const { cols, rows } = meta;
        // Today's answers: StallWatch's screen and Fleet's text read.
        const fullScreen = await generateTextSnapshotUnqueued({ cols, rows, scrollback: 0, initial: readSessionTextReplay(ringBuffer, outputModes) });
        const fullText = await snapshotRingTextUnqueued(ringBuffer as RingBuffer, outputModes, { cols, rows, scrollback: 80 });
        const screen = await guardedTailRead(s, { site: 'stallwatch', parse: (initial) => generateTextSnapshotUnqueued({ cols, rows, scrollback: 0, initial }) });
        const text = await guardedTailRead(s, { site: 'fleet', parse: (initial) => generateTextSnapshotUnqueued({ cols, rows, scrollback: 80, initial }) });
        expect(rowsOf(screen), `${fx.name} screen via ${screen.via}`).toEqual(rowsOf(fullScreen));
        expect(rowsOf(text), `${fx.name} text via ${text.via}`).toEqual(rowsOf(fullText));
        if (screen.via === 'tail') served++;
      }
      const counters = tailReadCounters();
      // The real-data check ran on the first served read of each site and found nothing.
      for (const c of Object.values(counters)) expect(c.mismatches).toEqual({});
      if (fx.serves) expect(served, `${fx.name} should be served from the tail`).toBeGreaterThan(0);
    });
  }
});
