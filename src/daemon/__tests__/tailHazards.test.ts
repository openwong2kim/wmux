import { describe, expect, it } from 'vitest';
import { TailHazardScan } from '../tailHazards';
import { OutputInterpreter } from '../OutputInterpreter';

/**
 * The hazard of a tail starting at byte `cut` of `stream` (the whole ring,
 * from lifetime offset 0), after earlier reads that ended at `reads`.
 */
function hazard(stream: string, cut: number, opts: { reads?: number[]; rows?: number; scan?: TailHazardScan } = {}) {
  const bytes = Buffer.from(stream, 'latin1');
  const scan = opts.scan ?? new TailHazardScan();
  for (const end of opts.reads ?? []) scan.check(bytes.subarray(0, end), end, Math.min(cut, end), opts.rows ?? 24);
  return scan.check(bytes, bytes.length, cut, opts.rows ?? 24).hazard;
}

describe('tail hazard scan', () => {
  it('names each state left on before the cut', () => {
    const cases: Array<[string, string]> = [
      ['\x1b[2;20r', 'margins'],
      ['\x1b[1;10r', 'margins'],
      ['\x1b[?6h', 'origin'],
      ['\x1b[?69h', 'lr-margins'],
      ['\x1b(0', 'charset'],
      ['\x1b)0\x0e', 'charset'],
      ['\x1b*0', 'charset'],
      ['\x1bn', 'charset'],
      ['\x1bH', 'tabs'],
      ['\x1b[3g', 'tabs'],
      ['\x1b[g', 'tabs'],
      ['\x1b[4h', 'insert'],
      ['\x1b[20h', 'newline'],
      ['\x1b[4;20h', 'insert'],
    ];
    for (const [sequence, name] of cases) {
      const stream = `$ x\r\n${sequence}more\r\nafter`;
      expect(hazard(stream, stream.length - 5), JSON.stringify(sequence)).toBe(name);
    }
  });

  it('says nothing for state set and cleared before the cut, or set only after it', () => {
    const before = '\x1b[2;20r\x1b[r\x1b(0\x1b(B\x1b[?6h\x1b[?6l\x1b[4h\x1b[4l\x1b)0\x0e\x0f\x1b)B';
    expect(hazard(`${before}text\r\nmore`, before.length + 6)).toBeNull();
    expect(hazard('text\r\n\x1b[2;20r\x1b(0\x1b[4h', 6)).toBeNull();
  });

  it('a margin of the whole screen is no margin, at the size read', () => {
    const stream = '\x1b[1;24rtext\r\nx';
    expect(hazard(stream, stream.length - 1, { rows: 24 })).toBeNull();
    expect(hazard(stream, stream.length - 1, { rows: 30 })).toBe('margins');
    expect(hazard('\x1b[;24r\r\nx', 8)).toBeNull();
  });

  it('a designation that only re-selects ASCII changes nothing (sgr0 sends ESC ( B)', () => {
    const stream = '\x1b(B\x1b[mprompt\x1b(B\x1b[m\r\n'.repeat(50);
    expect(hazard(stream, stream.length - 21)).toBeNull();
  });

  it('RIS clears every state hazard; DECSTR, which vte ignores, clears none', () => {
    const set = '\x1b[2;20r\x1b(0\x1bH\x1b[4h';
    expect(hazard(`${set}\x1bc\r\ntext`, set.length + 4)).toBeNull();
    expect(hazard(`${set}\x1b[!p\r\ntext`, set.length + 6)).toBe('margins');
  });

  it('a screen switch inside the tail, in any form, is a hazard; one before it is not', () => {
    for (const sequence of ['\x1b[?1049h', '\x1b[?1049l', '\x1b[?47h', '\x1b[?1047l', '\x1b[?25;1049l']) {
      const stream = `before\r\n${sequence}after`;
      const at = stream.indexOf('\x1b');
      expect(hazard(stream, at), JSON.stringify(sequence)).toBe('screen-switch');
      expect(hazard(stream, at + sequence.length)).toBeNull();
    }
  });

  it('an autowrap change inside the tail is a hazard: the preamble then leaves autowrap at its default', () => {
    const stream = 'x\r\n\x1b[?7lwide line\x1b[?7h\r\nmore';
    expect(hazard(stream, stream.indexOf('more'))).toBeNull();
    expect(hazard(stream, stream.indexOf('wide'))).toBe('autowrap');
    expect(hazard('x\r\n\x1b[?25;7h', 3)).toBe('autowrap');
  });

  it('a cursor restore inside the tail before any save there is a hazard', () => {
    for (const [save, restore] of [['\x1b7', '\x1b8'], ['\x1b[s', '\x1b[u'], ['\x1b[?1048h', '\x1b[?1048l']]) {
      const stream = `${save}status\r\nline\r\n${restore}text`;
      expect(hazard(stream, stream.indexOf('line')), JSON.stringify(restore)).toBe('saved-cursor');
      expect(hazard(`x\r\n${save}a${restore}b`, 3), JSON.stringify(save)).toBeNull();
    }
    // The kitty keyboard protocol's CSI > 1 u is not a restore.
    expect(hazard('x\r\n\x1b[>1u\x1b[<u', 3)).toBeNull();
  });

  it('a sequence split across two reads is applied once, at its first byte', () => {
    const stream = 'abc\r\n\x1b[2;20rxyz\r\n\x1b[r\r\nend';
    const split = stream.indexOf('20r');
    const reads = [split, split + 1];
    expect(hazard(stream, stream.indexOf('\x1b[2;'), { reads })).toBeNull();
    expect(hazard(stream, stream.indexOf('xyz'), { reads })).toBe('margins');
    expect(hazard(stream, stream.indexOf('end'), { reads })).toBeNull();
  });

  it('re-reading bytes already scanned does not apply them twice', () => {
    const stream = '\x1b[2;20r\x1b[r\r\nx';
    const scan = new TailHazardScan();
    expect(hazard(stream, stream.length - 1, { scan })).toBeNull();
    expect(hazard(stream, stream.length - 1, { scan })).toBeNull();
    expect(hazard(stream, 7, { scan })).toBe('margins');
  });

  it('answers a cut behind thousands of state changes from a checkpoint', () => {
    // Line drawing switched on and off on every line, as an ncurses box-drawing TUI does.
    const frame = '\x1b(0lqqk\x1b(B text\r\n';
    const stream = frame.repeat(20_000);
    const scan = new TailHazardScan();
    expect(hazard(stream, frame.length * 5, { scan, reads: [stream.length / 2] })).toBeNull();
    expect(hazard(stream, frame.length * 19_000 + 3, { scan })).toBe('charset');
    expect(hazard(stream, frame.length * 19_000, { scan })).toBeNull();
  });

  it('a ring start that moves back (a read while the ring could not wake) scans again from it', () => {
    const scan = new TailHazardScan();
    const older = `\x1b[5;20r${'x'.repeat(1000)}\r\n`;
    const newest = `${'y'.repeat(100)}\r\nz`;
    const all = Buffer.from(older + newest, 'latin1');
    // The failed wake: only the newest bytes, at their lifetime offsets.
    scan.check(Buffer.from(newest, 'latin1'), all.length, all.length - 1, 24);
    expect(scan.check(all, all.length, all.length - 1, 24).hazard).toBe('margins');
  });

  it('restarts at the ring start with defaults when bytes since the last read were dropped', () => {
    const scan = new TailHazardScan();
    scan.check(Buffer.from('\x1b[2;20rabc\r\nx', 'latin1'), 13, 12, 24);
    // 1000 bytes later the ring holds only its newest 20: the whole-ring replay starts at defaults.
    expect(scan.check(Buffer.from(`${'x'.repeat(18)}\r\n`, 'latin1'), 1013, 1013, 24).hazard).toBeNull();
  });

  it('rescans from the ring start once a hazard may come only from bytes the ring has dropped', () => {
    const scan = new TailHazardScan();
    const chunk = `${'x'.repeat(1023)}\n`;
    let ring = Buffer.from(`\x1bH\r\n${chunk}`, 'latin1');
    let written = ring.length;
    expect(scan.check(ring, written, written, 24).hazard).toBe('tabs');
    // Read every 64 KiB, so the scan never loses track and the HTS stays in its state.
    const capacity = 512 * 1024;
    let last: string | null = null;
    for (let i = 0; i < 40; i++) {
      const more = Buffer.from(chunk.repeat(64), 'latin1');
      ring = Buffer.concat([ring, more]).subarray(-capacity);
      written += more.length;
      last = scan.check(ring, written, written - 1024, 24).hazard;
      if (i === 5) expect(last).toBe('tabs'); // still within 1 MiB of the scan's start
    }
    // Over 1 MiB has dropped since the HTS: the whole-ring replay no longer has it.
    expect(last).toBeNull();
  });

  it('the mode preamble restores no hazard, so the whole-ring replay starts every hazard at its default', () => {
    // The scan starts at the ring's oldest byte with defaults because neither
    // mode tracker (JS MODE_DEFAULTS, rust output_interpreter.rs MODES)
    // replays a hazard. If one ever does, the scan must seed it from there.
    const hazards = '\x1b[?6h\x1b[?69h\x1b[4h\x1b[20h\x1b[2;20r\x1b(0\x1bH';
    for (const backend of ['node', 'rust'] as const) {
      const interpreter = new OutputInterpreter(backend);
      interpreter.feed(`${hazards}\x1b[?1h`, hazards.length + 5);
      const preamble = interpreter.modes.preamble(hazards.length + 5);
      expect(preamble, backend).toContain('\x1b[?1h');
      for (const h of ['\x1b[?6h', '\x1b[?69h', '\x1b[4h', '\x1b[20h', 'r', '\x1b(', '\x1bH']) expect(preamble, backend).not.toContain(h);
      interpreter.dispose();
    }
  });
});
