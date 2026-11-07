/**
 * DECSTBM parity: every spelling xterm reads as "the full screen" replays
 * natively, while a real partial region still skips the snapshot on both
 * paths (xterm's serializer drops margins, so the replay would lose them).
 *
 * xterm's setScrollRegion: top defaults to 1, bottom to the row count, a 0
 * reads as the default, a bottom past the screen is the screen, and a region
 * whose bottom is not below its top is ignored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSnapshotUnqueued } from '../HeadlessSnapshot';
import { available, expectParity, modulePath, synthetic, type Case } from './_rustParity';

// A partial region, then a full-screen reset, then output that scrolls.
const afterRegion = (reset: string): string => `a\r\nb\r\n\x1b[2;5r${reset}top\r\n1\r\n2\r\n3\r\n4\r\n5\r\n6\r\nend`;

const fullScreen: Case[] = [
  synthetic('reset-0;0', afterRegion('\x1b[0;0r')),
  synthetic('reset-bare', afterRegion('\x1b[r')),
  synthetic('reset-semicolon', afterRegion('\x1b[;r')),
  synthetic('reset-0', afterRegion('\x1b[0r')),
  synthetic('reset-1', afterRegion('\x1b[1r')),
  synthetic('reset-;rows', afterRegion('\x1b[;6r')),
  synthetic('reset-1;rows', afterRegion('\x1b[1;6r')),
  synthetic('reset-1;past-rows', afterRegion('\x1b[1;99r')),
  synthetic('reset-1;rows;extra', afterRegion('\x1b[1;6;3r')),
  // Ignored by xterm: the screen keeps the full region it had.
  synthetic('ignored-inverted', 'ab\x1b[5;3rcd\r\n1\r\n2\r\n3\r\n4\r\n5\r\nend'),
  synthetic('ignored-single-row', 'ab\x1b[4;4rcd\r\n1\r\n2\r\n3\r\n4\r\n5\r\nend'),
];

// xterm ignores these (top at or past the last row), Alacritty applies them.
const divergent: Case[] = [
  synthetic('top-at-last-row', 'ab\x1b[6;99rcd\r\n1\r\n2\r\nend', 'xterm'),
  synthetic('top-past-screen', 'ab\x1b[7;99rcd\r\n1\r\n2\r\nend', 'xterm'),
];

// xterm drops the alternate screen's region on leaving it. Alacritty keeps
// one region for both screens, so ?1049 answers on xterm; ?47 and ?1047 do
// already (Alacritty does not switch on them).
const altRegion = (mode: string): string => `ab\x1b[?${mode}hx\x1b[2;5ry\x1b[?${mode}l\x1b[Hc\r\n1\r\n2\r\n3\r\n4\r\n5\r\nend`;
const leftAlt: Case[] = ['1049', '47', '1047'].map((mode) => synthetic(`alt-region-left-${mode}`, altRegion(mode), 'xterm'));

// A region narrower than the screen: both paths keep refusing.
const partial: Array<[string, string]> = [
  ['top-and-bottom', 'a\x1b[2;5rb'],
  ['bottom-only', 'a\x1b[1;5rb'],
  ['top-only', 'a\x1b[2rb'],
  ['top-with-past-rows', 'a\x1b[2;99rb'],
  ['then-ignored', 'a\x1b[2;5rb\x1b[5;3rc'],
  ['reset-then-again', 'a\x1b[2;5r\x1b[r\x1b[3;4rb'],
  // The main screen's region outlives an alternate screen that resets its own.
  ...['1049', '47', '1047'].flatMap((mode): Array<[string, string]> => [
    [`main-region-across-${mode}`, `a\x1b[2;5r\x1b[?${mode}hb\x1b[r\x1b[?${mode}lc`],
    [`main-region-across-${mode}-decstr`, `a\x1b[2;5r\x1b[?${mode}hb\x1b[!p\x1b[?${mode}lc`],
  ]),
  ['main-region-under-alt', 'a\x1b[2;5r\x1b[?1049hb\x1b[r'],
];

describe.skipIf(!available)('Rust DECSTBM parity', { timeout: 30_000 }, () => {
  beforeEach(() => vi.stubEnv('WMUX_RUST_SNAPSHOT_MODULE', modulePath));
  afterEach(() => vi.unstubAllEnvs());

  it.each([...fullScreen, ...divergent, ...leftAlt].map(c => [c.name, c] as const))('%s', async (_name, c) => {
    await expectParity(c);
  });

  it.each(partial)('a partial region still skips the snapshot: %s', async (_name, text) => {
    const req = synthetic('partial', text).req;
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'off');
    const reference = await generateSnapshotUnqueued(req);
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'ansi');
    const selected = await generateSnapshotUnqueued(req);
    expect(reference).toEqual({ ok: false, reason: 'margins' });
    expect(selected).toEqual({ ok: false, reason: 'margins' });
  });
});
