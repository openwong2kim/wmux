import { describe, expect, it } from 'vitest';
import { TailHazardScan } from '../tailHazards';

/** A scan of `stream`, fed in pieces cut at `cuts` (byte offsets), as successive ring reads would. */
function scanned(stream: string, cuts: number[] = [], ringStart = 0): { scan: TailHazardScan; end: number } {
  const bytes = Buffer.from(stream, 'latin1');
  const scan = new TailHazardScan();
  for (const cut of [...cuts, bytes.length]) scan.advance(bytes.subarray(0, cut), ringStart + cut);
  return { scan, end: ringStart + bytes.length };
}

describe('tail hazard scan', () => {
  it('names each hazard left on before the cut', () => {
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
    for (const [sequence, hazard] of cases) {
      const { scan, end } = scanned(`$ x\r\n${sequence}more\r\n`);
      expect(scan.hazardAt(end - 3, 24), JSON.stringify(sequence)).toBe(hazard);
    }
  });

  it('says nothing for a hazard set and cleared before the cut, or set only after it', () => {
    const before = '\x1b[2;20r\x1b[r\x1b(0\x1b(B\x1b[?6h\x1b[?6l\x1b[4h\x1b[4l\x1b)0\x0e\x0f\x1b)B';
    const { scan, end } = scanned(`${before}text\r\n`);
    expect(scan.hazardAt(end - 2, 24)).toBeNull();
    const after = scanned('text\r\n\x1b[2;20r\x1b(0\x1b[4h');
    expect(after.scan.hazardAt(6, 24)).toBeNull();
  });

  it('a margin of the whole screen is no margin, at the size read', () => {
    const { scan, end } = scanned('\x1b[1;24rtext\r\n');
    expect(scan.hazardAt(end, 24)).toBeNull();
    expect(scan.hazardAt(end, 30)).toBe('margins');
    expect(scanned('\x1b[;24r').scan.hazardAt(6, 24)).toBeNull();
  });

  it('a designation that only re-selects ASCII changes nothing (sgr0 sends ESC ( B)', () => {
    const { scan, end } = scanned('\x1b(B\x1b[mprompt\x1b(B\x1b[m\r\n'.repeat(50));
    expect(scan.hazardAt(end - 10, 24)).toBeNull();
  });

  it('RIS clears every hazard; DECSTR, which vte ignores, clears none', () => {
    const set = '\x1b[2;20r\x1b(0\x1bH\x1b[4h';
    expect(scanned(`${set}\x1bctext`).scan.hazardAt(set.length + 2, 24)).toBeNull();
    expect(scanned(`${set}\x1b[!ptext`).scan.hazardAt(set.length + 4, 24)).toBe('margins');
  });

  it('a screen switch at or after the cut, in any form, is a hazard; one before it is not', () => {
    for (const sequence of ['\x1b[?1049h', '\x1b[?1049l', '\x1b[?47h', '\x1b[?1047l', '\x1b[?25;1049l']) {
      const stream = `before\r\n${sequence}after`;
      const at = stream.indexOf('\x1b');
      const { scan } = scanned(stream);
      expect(scan.hazardAt(at, 24), JSON.stringify(sequence)).toBe('screen-switch');
      expect(scan.hazardAt(at + sequence.length, 24)).toBeNull();
    }
  });

  it('a sequence split across two reads is applied once, at its first byte', () => {
    const stream = 'abc\r\n\x1b[2;20rxyz\r\n\x1b[r';
    const split = stream.indexOf('20r');
    const { scan } = scanned(stream, [split, split + 1]);
    const set = stream.indexOf('\x1b[2;');
    const clear = stream.lastIndexOf('\x1b[r');
    expect(scan.hazardAt(set, 24)).toBeNull();
    expect(scan.hazardAt(set + 1, 24)).toBe('margins');
    expect(scan.hazardAt(clear, 24)).toBe('margins');
    expect(scan.hazardAt(clear + 1, 24)).toBeNull();
  });

  it('re-reading bytes already scanned does not apply them twice', () => {
    const stream = '\x1b[2;20r\x1b[r';
    const bytes = Buffer.from(stream, 'latin1');
    const scan = new TailHazardScan();
    scan.advance(bytes, bytes.length);
    scan.advance(bytes, bytes.length);
    expect(scan.hazardAt(bytes.length, 24)).toBeNull();
    expect(scan.hazardAt(3, 24)).toBe('margins');
  });

  it('restarts at the ring start with defaults when bytes since the last read were dropped', () => {
    const scan = new TailHazardScan();
    scan.advance(Buffer.from('\x1b[2;20rabc', 'latin1'), 10);
    expect(scan.hazardAt(9, 24)).toBe('margins');
    // 1000 bytes later the ring holds only its newest 20: the whole-ring replay starts at defaults.
    scan.advance(Buffer.from('x'.repeat(20), 'latin1'), 1010);
    expect(scan.hazardAt(1000, 24)).toBeNull();
  });

  it('falls back when the log no longer reaches the cut', () => {
    const toggles = '\x1b[4h\x1b[4l'.repeat(3000);
    const { scan, end } = scanned(toggles);
    expect(scan.hazardAt(end, 24)).toBeNull();
    expect(scan.hazardAt(5, 24)).toBe('hazard-history');
  });
});
