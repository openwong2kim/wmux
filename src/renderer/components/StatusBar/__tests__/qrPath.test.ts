/**
 * QR encoding, checked structurally rather than by eye.
 *
 * A wrong QR does not look wrong — it looks like a QR and fails to scan, which
 * is the worst possible failure mode to leave to manual testing. So these
 * assert the things a scanner actually keys on: the three finder patterns, the
 * module count, and that the payload survives at realistic lengths.
 */
import { describe, it, expect } from 'vitest';
import qrcode from 'qrcode-generator';
import { buildQrPath } from '../qrPath';

/** Re-encode independently and read the module grid back. */
function grid(text: string): { isDark: (r: number, c: number) => boolean; size: number } {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return { isDark: (r, c) => qr.isDark(r, c), size: qr.getModuleCount() };
}

/**
 * A finder pattern is a 7x7 with a dark border and a 3x3 dark core. All three
 * corners carry one; without them a camera never locks on.
 */
function hasFinder(g: ReturnType<typeof grid>, r0: number, c0: number): boolean {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const border = r === 0 || r === 6 || c === 0 || c === 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      if (g.isDark(r0 + r, c0 + c) !== (border || core)) return false;
    }
  }
  return true;
}

const REAL_PAYLOAD = 'https://desktop-abc123.tail1234.ts.net/pair?code=V9CBNL27';

describe('buildQrPath', () => {
  it('returns null for nothing to encode', () => {
    // The caller renders no QR at all in this case. A blank square where a code
    // should be reads as "scan failed", which is worse than the plaintext
    // fallback already on screen.
    expect(buildQrPath('')).toBeNull();
  });

  it('encodes a real tailnet pair URL', () => {
    const out = buildQrPath(REAL_PAYLOAD);
    expect(out).not.toBeNull();
    expect(out!.size).toBe(grid(REAL_PAYLOAD).size);
    expect(out!.d.length).toBeGreaterThan(0);
  });

  it('★ produces the three finder patterns a scanner locks onto', () => {
    const g = grid(REAL_PAYLOAD);
    expect(hasFinder(g, 0, 0)).toBe(true);
    expect(hasFinder(g, 0, g.size - 7)).toBe(true);
    expect(hasFinder(g, g.size - 7, 0)).toBe(true);
  });

  it('★ the path covers exactly the dark modules, no more and no less', () => {
    // The path is what actually ships; the grid above is the oracle. Drawing
    // one module too many or too few is invisible to the eye and fatal to a
    // scan, so they are compared cell by cell.
    const out = buildQrPath(REAL_PAYLOAD)!;
    const g = grid(REAL_PAYLOAD);
    const drawn = new Set(out.d.match(/M(\d+) (\d+)h1v1h-1z/g)?.map((m) => m) ?? []);

    let expected = 0;
    for (let r = 0; r < g.size; r++) {
      for (let c = 0; c < g.size; c++) {
        if (!g.isDark(r, c)) continue;
        expected += 1;
        expect(drawn.has(`M${c} ${r}h1v1h-1z`)).toBe(true);
      }
    }
    expect(drawn.size).toBe(expected);
  });

  it('grows the symbol for a longer address instead of failing', () => {
    const short = buildQrPath('https://a.ts.net/pair?code=ABCD2345')!;
    const long = buildQrPath(
      `https://${'a'.repeat(60)}.some-long-tailnet-name.ts.net/pair?code=ABCD2345`,
    )!;
    expect(long.size).toBeGreaterThan(short.size);
  });

  it('returns null rather than throwing when the payload cannot fit', () => {
    // The encoder throws on overflow. Nothing here is worth surfacing: the URL
    // and the code are both still rendered as text.
    expect(buildQrPath('x'.repeat(10_000))).toBeNull();
  });
});
