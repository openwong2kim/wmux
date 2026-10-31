/**
 * Rendered parity of the Rust ANSI snapshot against xterm's. Each payload is
 * replayed into a fresh @xterm/headless (the renderer's parser) and the
 * cells, cursor, modes and wrap flags are compared, then again after live
 * bytes continue the stream and after leaving the alternate screen.
 *
 * Accepted deviation: Alacritty cannot tell a printed space from an erased
 * cell, so trailing blanks replay as empty cells. A restored row may drop
 * trailing printed spaces from its copied text; it never gains any, except
 * inside a soft-wrapped paragraph, where copy and reflow ignore the edge, and
 * left of the cursor, where blanks replay as printed (a shell prompt's space).
 *
 * Runs where the native module is built (the rust-engine lane builds it).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/headless';
import { nativeCorePath } from '../../shared/nativeTerminalCore';
import { getAnsiSnapshotBackendDiagnostics } from '../AnsiSnapshotBackend';
import { generateSnapshotUnqueued, type SnapshotRequest } from '../HeadlessSnapshot';
import { generateRustSnapshot } from '../RustSnapshot';
import { snapshotTestTerminal, writeTerminal } from '../snapshotFingerprint';
import { CLAUDE_WRAPPED_REPLY_80x30 } from '../../renderer/terminal/__tests__/fixtures/claudeWrappedReply';

const modulePath = nativeCorePath();
const available = fs.existsSync(modulePath);
if (!available && process.env.WMUX_REQUIRE_RUST_CORE) throw new Error(`native core missing: ${modulePath}`);

interface Row { wrapped: boolean; text: string; cells: string }
interface State { head: string; rows: Row[]; cursorRow: number }

function capture(t: Terminal): State {
  const rows: Row[] = [];
  const head: unknown[] = [t.cols, t.rows, t.buffer.active.type, t.modes];
  let cursorRow = -1;
  for (const buffer of [t.buffer.normal, t.buffer.alternate]) {
    if (buffer.type === 'alternate' && t.buffer.active.type !== 'alternate') continue;
    if (buffer.type === t.buffer.active.type) cursorRow = rows.length + buffer.baseY + buffer.cursorY;
    head.push([buffer.type, buffer.baseY, buffer.cursorX, buffer.cursorY, buffer.length]);
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y)!;
      const cells: unknown[] = [];
      for (let x = 0; x < t.cols; x++) {
        const c = line.getCell(x)!;
        const chars = c.getChars() || ' ';
        // A blank shows its background and lines, not its foreground, weight,
        // slant or blink (reflow leaves those on xterm's empty cells at random).
        const glyph = chars.trim() ? [c.getFgColor(), c.getFgColorMode(), c.isBold(), c.isDim(), c.isItalic(), c.isBlink(), c.isInvisible()] : [];
        cells.push([chars, c.getWidth(), c.getBgColor(), c.getBgColorMode(), c.isUnderline(), c.isInverse(), c.isStrikethrough(), c.isOverline(), ...glyph]);
      }
      rows.push({ wrapped: line.isWrapped, text: line.translateToString(true), cells: JSON.stringify(cells) });
    }
  }
  return { head: JSON.stringify(head), rows, cursorRow };
}

/** The client after replaying `payload`, or with no payload the live
 * terminal: the raw stream parsed at its recorded sizes. */
async function replay(req: SnapshotRequest, payload?: Buffer): Promise<State[]> {
  const t = snapshotTestTerminal(payload ? req.cols : req.geometry?.start.cols ?? req.cols,
    payload ? req.rows : req.geometry?.start.rows ?? req.rows, req.scrollback ?? 5000);
  try {
    if (payload) await writeTerminal(t, payload);
    else {
      let offset = 0;
      for (const change of req.geometry?.changes ?? []) {
        await writeTerminal(t, req.initial.subarray(offset, change.offset));
        offset = change.offset;
        t.resize(change.cols, change.rows);
      }
      await writeTerminal(t, req.initial.subarray(offset));
      t.resize(req.cols, req.rows);
    }
    const states = [capture(t)];
    // Live bytes continue after the snapshot: wrap-pending, SGR and parser
    // state must match too. Then the saved primary screen and cursor.
    for (const probe of ['\x1b[?2026lZ한\r\n', '\x1b[?1049lX']) { await writeTerminal(t, probe); states.push(capture(t)); }
    return states;
  } finally { t.dispose(); }
}

/**
 * Rust must match xterm's payload, or, where xterm's own payload loses
 * something (a colored erase below the last written row, a link), the live
 * terminal: never less faithful than xterm.
 */
async function parity(req: SnapshotRequest, rust: Buffer, xterm: Buffer): Promise<string | undefined> {
  const restored = await replay(req, rust);
  const fromXterm = difference(restored, await replay(req, xterm));
  return fromXterm && difference(restored, await replay(req)) && fromXterm;
}

/** First difference, or undefined. Trailing printed spaces may be dropped. */
function difference(rust: State[], ref: State[]): string | undefined {
  for (let i = 0; i < ref.length; i++) {
    if (rust[i].head !== ref[i].head) return `state ${i}: ${rust[i].head} != ${ref[i].head}`;
    for (let y = 0; y < ref[i].rows.length; y++) {
      const a = rust[i].rows[y], b = ref[i].rows[y];
      // A soft-wrapped row is copied and reflowed with its full width, so
      // its trailing blanks are unobservable either way.
      const continued = ref[i].rows[y + 1]?.wrapped && rust[i].rows[y + 1]?.wrapped;
      // Blanks left of the cursor replay as printed (a prompt's space).
      const cursor = y === ref[i].cursorRow;
      const text = a.text === b.text || (continued || cursor ? a.text.trimEnd() === b.text.trimEnd()
        : b.text.startsWith(a.text) && b.text.slice(a.text.length).trim() === '');
      if (a.wrapped !== b.wrapped || a.cells !== b.cells || !text) {
        return `state ${i} row ${y}: ${JSON.stringify([a.wrapped, a.text])} != ${JSON.stringify([b.wrapped, b.text])}`;
      }
    }
  }
  return undefined;
}

type Case = { name: string; req: SnapshotRequest; backend: 'rust' | 'xterm' };
const synthetic = (name: string, text: string, backend: 'rust' | 'xterm' = 'rust', cols = 20): Case =>
  ({ name, backend, req: { cols, rows: 6, scrollback: 100, initial: Buffer.from(text) } });

// One or more cases per control class the selector used to refuse wholesale.
const accepted: Case[] = [
  // OSC: not screen state (xterm's path drops it too) except OSC 8, restored.
  synthetic('osc-title-bel', '\x1b]0;title\x07hello'),
  synthetic('osc-title-st', '\x1b]2;t\x1b\\x'),
  synthetic('osc-133', '\x1b]133;A\x07$ ls\r\nout\x1b]133;D;0\x07'),
  synthetic('osc-query', '\x1b]11;?\x07x'),
  synthetic('osc-palette', '\x1b]4;1;rgb:ff/00/00\x07\x1b[31mred'),
  synthetic('osc-52', '\x1b]52;c;aGk=\x07x'),
  synthetic('osc-partial-tail', 'hi\x1b]0;tit'),
  synthetic('osc-esc-abort', '\x1b]0;a\x1b[31mred'),
  synthetic('osc-can', '\x1b]0;a\x18text'),
  synthetic('osc-utf8', '\x1b]0;✳ Claude\x07ok'),
  synthetic('osc8-link', '\x1b]8;;https://e.com\x07link\x1b]8;;\x07 after'),
  synthetic('osc8-styles', '\x1b]8;;http://x\x07\x1b[1mbold\x1b[0mplain\x1b]8;;\x07 no'),
  synthetic('osc8-open-tail', 'a\x1b]8;id=k;http://y\x07open'),
  synthetic('osc8-alt', '\x1b]8;;http://n\x07nn\x1b[?1049h\x1b]8;;http://a\x07aa'),
  // SO/SI and ASCII designation: with only ASCII designated, shifts are no-ops.
  synthetic('so-si', '\x0eabc\x0fdef'),
  synthetic('designate-ascii', '\x1b(B\x1b)Babc\x0e\x1b[mx\x0f'),
  // DECSC/DECRC and SCOSC/SCORC: parsed alike; neither path restores the slot.
  synthetic('decsc', 'ab\x1b7cd\r\n\x1b8X'),
  synthetic('decrc-unsaved', 'abc\r\n\x1b8X'),
  synthetic('decsc-attrs', '\x1b[31m\x1b7\x1b[0m\x1b8X'),
  synthetic('decsc-alt', 'n\x1b7\x1b[?1049ha\x1b7b\x1b[?1049l\x1b8X'),
  synthetic('scosc', 'ab\x1b[scd\x1b[uX'),
  // Kitty keyboard flags: input state, restored by neither path.
  synthetic('kitty-push-pop', '\x1b[>1uhello\x1b[<u'),
  synthetic('kitty-query', '\x1b[?uhi'),
  synthetic('kitty-set', '\x1b[=1;1uhi'),
  // Tab stops (HTS, TBC): parsed alike, restored by neither path.
  synthetic('hts', '\x1b[1;5H\x1bH\r\ta\tb'),
  synthetic('tbc-all', '\x1b[3g\tX'),
  synthetic('tbc-one', '\x1b[1;9H\x1b[g\r\tX'),
  synthetic('tab-plain', 'a\tb\tc\r\nxx\t\ty'),
  synthetic('tab-at-wrap', 'abcdefgh\tX', 'rust', 8),
  // CSI q family: cursor style, LEDs, protection and version query.
  synthetic('decscusr', '\x1b[5 qhi'),
  synthetic('xtversion', '\x1b[>0qhi'),
  synthetic('decll', '\x1b[1qhi'),
  synthetic('decsca', '\x1b[1"qhi\x1b[0"q'),
  synthetic('sgr-no-overline', 'a\x1b[55mb'),
  // Rows and blanks.
  synthetic('trailing-printed-space', 'ab   \r\ncd'),
  synthetic('erase-bg', 'abc\x1b[44m\x1b[K\x1b[0m\r\nx\x1b[41m  \x1b[0m'),
  synthetic('erase-bg-middle', '\x1b[44m\x1b[2K\x1b[0m\x1b[1;5Hmid'),
  synthetic('wide-wrap', 'abcdefg中X', 'rust', 8),
  synthetic('modes', '\x1b[?1h\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b=\x1b[4hready'),
  synthetic('mode-sgr-pixels', '\x1b[?1000h\x1b[?1016hx'),
  synthetic('mode-sync-open', '\x1b[?2026hx'),
  // A fullwidth glyph erased by half: xterm erases it whole.
  synthetic('wide-ech-first-half', 'a\u4e2db\x1b[1;2H\x1b[X'),
  synthetic('wide-el0-second-half', 'a\u4e2db\x1b[1;3H\x1b[K'),
  synthetic('wide-el1-first-half', 'a\u4e2db\x1b[1;2H\x1b[1K'),
  synthetic('wide-ed0-second-half', 'a\u4e2db\x1b[1;3H\x1b[J'),
  synthetic('wide-ed1-first-half', 'x\r\na\u4e2db\x1b[2;2H\x1b[1J'),
  synthetic('wide-ech-colored', 'a\x1b[42m\u4e2d\x1b[0mb\x1b[44m\x1b[1;3H\x1b[X\x1b[0m'),
  // Mouse protocol and encoding with xterm's semantics.
  synthetic('mouse-reset-by-other', '\x1b[?1002h\x1b[?1006h\x1b[?1000lx'),
  synthetic('mouse-1005-keeps-sgr', '\x1b[?1000h\x1b[?1006h\x1b[?1005hx'),
  synthetic('mouse-last-set-wins', '\x1b[?1003;1000h\x1b[?1016hx'),
  synthetic('rep-after-print', 'ab\x1b[3bc'),
  // ICH, DCH and ECH drop a pending wrap in xterm (the live probe then prints Z).
  synthetic('ech-at-pending-wrap', 'abcdefghij\x1b[X', 'rust', 10),
  synthetic('dch-at-pending-wrap', 'abcdefghij\x1b[P', 'rust', 10),
  synthetic('ich-at-pending-wrap', 'abcdefghij\x1b[@', 'rust', 10),
  // Mode spellings xterm reads by number.
  synthetic('mouse-embedded-c0', '\x1b[?100\r0hx'),
  synthetic('mouse-leading-zeros', '\x1b[?01002;01006hx'),
  synthetic('colon-rgb-colorspace', '\x1b[38:2::10:20:30mx\x1b[48:5:3my'),
];

// Classes that stay on xterm because Alacritty parses them differently.
const refused: Case[] = [
  // Half a fullwidth glyph next to content (DCH pulls the second half left).
  synthetic('wide-dch-first-half', 'a\u4e2db\x1b[1;2H\x1b[P', 'xterm'),
  synthetic('sync-mixed-params', 'a\x1b[?2026hb\x1b[?2026;1lc', 'xterm'),
  synthetic('deccolm', 'abc\x1b[?3hd', 'xterm'),
  synthetic('colon-rgb-no-colorspace', '\x1b[38:2:10:20:30mx', 'xterm'),
  synthetic('colon-indexed-no-operand', '\x1b[31m\x1b[38:5mx', 'xterm'),
  synthetic('colon-rgb-short', '\x1b[38:2::10:20mx', 'xterm'),
  // A DCH orphan: xterm fills it with the erase attribute.
  synthetic('wide-dch-second-half-blank', ' \u4e2db\x1b[44m\x1b[1;2H\x1b[P', 'xterm'),
  synthetic('alt-1047-leading-zero', 'n\x1b[?01047ha', 'xterm'),
  synthetic('rep-after-control', 'X\r\x1b[3b', 'xterm'),
  synthetic('rep-after-sgr', 'X\x1b[31m\x1b[3b', 'xterm'),
  synthetic('decaln', 'ab\x1b[2;3H\x1b#8', 'xterm'),
  synthetic('sd-caret', '1\r\n2\r\n3\x1b[1^x', 'xterm'),
  synthetic('ed2-embedded-c0', '1\r\n2\r\n3\x1b[2\x00Jx', 'xterm'),
  synthetic('designate-dec', '\x1b(0' + Array.from({ length: 32 }, (_, i) => String.fromCharCode(0x5f + i)).join('') + '\x1b(B', 'xterm', 40),
  synthetic('designate-uk', '\x1b(A#x\x1b(B#', 'xterm'),
  synthetic('designate-g2', '\x1b*0\x1bnlq\x1b(Bz', 'xterm'),
  synthetic('so-dec-decsc', '\x1b)0\x0e\x1b7\x0fq\x1b8q', 'xterm'),
  synthetic('overline', '\x1b[53mover\x1b[55mno', 'xterm'),
  synthetic('sgr-21', '\x1b[21mx\x1b[24my', 'xterm'),
  synthetic('c1', 'a\u009b31mred', 'xterm'),
  synthetic('decsed', 'abc\r\ndef\x1b[?2J', 'xterm'),
  synthetic('decsel', 'abcdef\x1b[1;3H\x1b[?K', 'xterm'),
  synthetic('sl', 'abcdef\x1b[2 @', 'xterm'),
  synthetic('decic', 'abcdef\x1b[1;2H\x1b[2\'}', 'xterm'),
  synthetic('decstr', 'ab\x1b[4h\x1b[!pcd', 'xterm'),
  synthetic('su', '1\r\n2\r\n3\x1b[2S\x1b[1T', 'xterm'),
  synthetic('ed2-spelled-02', '1\r\n2\r\n3\x1b[02Jx', 'xterm'),
  synthetic('lnm', '\x1b[20ha\nb', 'xterm'),
  synthetic('mode-x10', '\x1b[?9hx', 'xterm'),
  synthetic('mode-reverse-wrap', '\x1b[?45hx', 'xterm'),
  synthetic('mode-decnkm', '\x1b[?66hx', 'xterm'),
  synthetic('alt-47', 'n\x1b[?47ha', 'xterm'),
  synthetic('alt-1047', 'n\x1b[?1047ha\x1b[?1047lb', 'xterm'),
  synthetic('save-1048', 'ab\x1b[?1048hcd\r\n\x1b[?1048lX', 'xterm'),
  // Refused by the serializer: xterm drops a saved pending wrap.
  synthetic('decsc-wrap-pending', 'abcdefgh\x1b7\x1b[H\x1b8X', 'xterm', 8),
  synthetic('alt-save-at-wrap', 'abcdefgh\x1b[?1049h\x1b[?1049lX', 'xterm', 8),
];

// Controls the selector never refused, rechecked now that Rust is the default.
const others: Case[] = [
  synthetic('ris', 'abc\x1b[31m\x1bcdef'),
  synthetic('ind-nel-ri', 'a\x1bDb\x1bEc\x1bMd'),
  synthetic('cht-cbt', 'a\x1b[2Ib\x1b[Zc'),
  synthetic('cnl-cpl', 'a\r\nb\x1b[Fc\x1b[2Ed'),
  synthetic('hpa-vpa', '\x1b[5`a\x1b[3db'),
  synthetic('ich-dch-ech', 'abcdef\x1b[1;2H\x1b[2@\x1b[1P\x1b[2X'),
  synthetic('il-dl', '1\r\n2\r\n3\x1b[2;1H\x1b[L\x1b[2M'),
  synthetic('ed3', '1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7\r\n8\x1b[3J'),
  // ED 2 erases in place in xterm; Alacritty scrolls the screen into history.
  synthetic('ed2-primary', '1\r\n2\r\n3\x1b[2Jx'),
  synthetic('ed2-repeated', Array.from({ length: 20 }, (_, i) => `\x1b[H\x1b[2Jframe ${i}\r\n\x1b[3${i % 8}mstatus`).join('')),
  synthetic('ed2-bg', 'abc\r\ndef\x1b[44m\x1b[2J\x1b[0mx'),
  synthetic('ed2-in-sync', 'a\r\nb\x1b[?2026h\x1b[2Jc\x1b[?2026ld'),
  synthetic('ed2-sync-open', 'a\r\nb\x1b[?2026h\x1b[2Jc'),
  synthetic('ed2-osc-abort', 'a\r\nb\x1b]0;title\x1b[2Jc'),
  synthetic('ed2-alt', 'n\x1b[?1049ha\r\nb\x1b[2Jc'),
  synthetic('ed1-second-row', 'aaa\r\nbbb\x1b[1J'),
  synthetic('ed1-third-row', 'aaa\r\nbbb\r\nccc\x1b[1J'),
  synthetic('ed0', 'aaa\r\nbbb\x1b[1;2H\x1b[J'),
  synthetic('sgr', '\x1b[1;2;3;4;5;7;8;9;31;44mstyled\x1b[22;23;24;25;27;28;29mplain\x1b[4:3;58:2::1:2:3mcurl\x1b[91;102mbright'),
  synthetic('sgr-color-operands', '\x1b[38;5;53mx\x1b[48;2;53;55;6my\x1b[38:2::53:55:5mz'),
  synthetic('emoji-cjk', 'abc한\u{1F600}Z é \u{1F468}‍\u{1F469}', 'rust', 12),
  synthetic('dcs-apc', 'a\x1bP1$r0m\x1b\\b\x1b_x\x1b\\c'),
  synthetic('partial-sgr', 'hello\x1b[31;'),
  synthetic('scroll-history', Array.from({ length: 50 }, (_, i) => `\x1b[3${i % 8}mline${i}\x1b[0m`).join('\r\n')),
];

/** Written at `from` columns, then the pane resized to `to`. */
const resized = (name: string, text: string, from: [number, number], to: [number, number], backend: 'rust' | 'xterm' = 'rust'): Case => {
  const initial = Buffer.from(text);
  return { name, backend, req: { cols: to[0], rows: to[1], scrollback: 100, initial,
    geometry: { start: { cols: from[0], rows: from[1] }, changes: [{ offset: initial.length, cols: to[0], rows: to[1] }] } } };
};
const box = Array.from({ length: 3 }, (_, k) => `${`[frame ${k}]`.padEnd(70, '=')}\r\n${`[body ${k}]`.padEnd(70, '.')}\r\n${k < 2 ? '\x1b[2A\r' : ''}`).join('');
const many = Array.from({ length: 30 }, (_, i) => `row ${i} ${'x'.repeat(i % 50)}`).join('\r\n');
const resizes: Case[] = [
  // vte holds bytes inside a synchronized update; xterm parsed them at 80.
  resized('resize-in-sync-update', '\x1b[?2026h\x1b[1;70HX', [80, 12], [40, 12]),
  // Refused by the native terminal: Alacritty's reflow scrolls rows above the
  // cursor into history where xterm moves the cursor down.
  resized('narrow-cursor-high', `line before the box\r\n${box}`, [80, 12], [40, 12], 'xterm'),
  resized('narrow-cursor-low', many, [80, 12], [40, 12]),
  resized('widen-after-wrap', many, [40, 12], [80, 12]),
  resized('fewer-rows', many, [80, 12], [80, 6]),
  resized('more-rows', many, [80, 6], [80, 12]),
  resized('more-rows-short', 'a\r\nb', [80, 6], [80, 12]),
  resized('narrow-alt', `n\x1b[?1049h${box}`, [80, 12], [40, 12]),
  resized('widen-cursor-high', `top\r\n${'y'.repeat(70)}\r\nend`, [40, 12], [80, 12]),
  resized('fewer-rows-cursor-high', 'a\r\nb\r\nc\r\nd\x1b[2;1H', [80, 12], [80, 3]),
  resized('narrow-history-cursor-top', `${many}\x1b[H`, [80, 12], [40, 12]),
  resized('narrow-no-wrap', 'short\r\nlines\r\nonly', [80, 12], [40, 12]),
  // Colored CJK paragraphs reflowed to 9..20 columns (bench/rust-snapshot-parity.ts).
  ...Array.from({ length: 24 }, (_, i) => i + 1).filter(seed => seed !== 14).map(seed => resized(`reflow-seed-${seed}`,
    Array.from({ length: seed }, (_, i) => `\x1b[3${i % 8}m${'abc\ud55c'.repeat(1 + i % 5)}\x1b[0m`).join('\r\n'),
    [12, 6], [8 + seed % 13, 6])),
];

function corpus(): Case[] {
  const root = path.join(process.cwd(), 'core/harness/corpus');
  return fs.readdirSync(root).map(name => {
    const dir = path.join(root, name);
    const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const changes = events.filter(e => e.type === 'resize').map(e => ({ offset: e.byteOffset, ...e.geometry }));
    const start = events[0].geometry;
    const end = changes.at(-1) ?? start;
    return { name: `corpus/${name}`, backend: 'rust' as const,
      req: { cols: end.cols, rows: end.rows, scrollback: 5000, initial: fs.readFileSync(path.join(dir, 'recording.bin')), geometry: { start, changes } } };
  });
}

const claude: Case = { name: 'claude-code-capture', backend: 'rust',
  req: { cols: 80, rows: 30, scrollback: 1000, initial: Buffer.from(CLAUDE_WRAPPED_REPLY_80x30, 'base64') } };

describe.skipIf(!available)('Rust ANSI snapshot rendered parity', { timeout: 30_000 }, () => {
  beforeEach(() => vi.stubEnv('WMUX_RUST_SNAPSHOT_MODULE', modulePath));
  afterEach(() => vi.unstubAllEnvs());

  it.each([...accepted, ...refused, ...others, ...resizes, ...corpus(), claude].map(c => [c.name, c] as const))('%s', async (_name, { req, backend }) => {
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'off');
    const reference = await generateSnapshotUnqueued(req);
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'ansi');
    const selected = await generateSnapshotUnqueued(req);
    expect(reference.ok && selected.ok, JSON.stringify([reference, selected])).toBe(true);
    if (!reference.ok || !selected.ok) return;
    expect(getAnsiSnapshotBackendDiagnostics().last?.backend).toBe(backend);
    expect(await parity(req, selected.payload, reference.payload)).toBeUndefined();
  });

  it('takes an attach-sized request and refuses a history past the native cap', async () => {
    const lines = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => `l${i}`).join('\r\n'));
    // 4M cells / 1000 columns leave 3999 history rows next to one screen row.
    const fits: SnapshotRequest = { cols: 1000, rows: 1, scrollback: 100000, initial: lines(50) };
    const overflows: SnapshotRequest = { ...fits, initial: lines(5000) };
    expect(await generateRustSnapshot(overflows, 'ansi')).toMatchObject({ ok: false, detail: expect.stringMatching(/^unsupported-history-limit/) });
    for (const [req, backend] of [[fits, 'rust'], [overflows, 'xterm']] as const) {
      vi.stubEnv('WMUX_RUST_SNAPSHOT', 'off');
      const reference = await generateSnapshotUnqueued(req);
      vi.stubEnv('WMUX_RUST_SNAPSHOT', 'ansi');
      const selected = await generateSnapshotUnqueued(req);
      if (!reference.ok || !selected.ok) throw new Error('snapshot failed');
      expect(getAnsiSnapshotBackendDiagnostics().last?.backend).toBe(backend);
      // The fallback is xterm's own payload; replaying 4M cells adds nothing.
      if (backend === 'xterm') expect(selected.payload.equals(reference.payload)).toBe(true);
      else expect(await parity(req, selected.payload, reference.payload)).toBeUndefined();
    }
  });

  it('refuses a divergent control that arrives on the live tee, split from the history', async () => {
    const tee = () => { const queue = [[Buffer.from('0lqk')], [Buffer.from('\x1b(Bok')]]; return () => queue.shift() ?? []; };
    const req: SnapshotRequest = { cols: 20, rows: 6, scrollback: 100, initial: Buffer.from('hello\x1b(') };
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'off');
    const reference = await generateSnapshotUnqueued({ ...req, drainQueue: tee() });
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'ansi');
    const selected = await generateSnapshotUnqueued({ ...req, drainQueue: tee() });
    if (!reference.ok || !selected.ok) throw new Error('snapshot failed');
    expect(getAnsiSnapshotBackendDiagnostics().last).toEqual({ backend: 'xterm', reason: 'state' });
    expect(selected.payload.equals(reference.payload)).toBe(true);
  });

  // xterm's public modes do not expose the mouse encoding, so capture() cannot
  // compare it: check the restored ?1016 directly.
  it.each(['\x1b[?1003;1016hx', '\x1b[?1002;1006;1016hx', '\x1b[?1016hx', '\x1b[?1000;1016h\x1b[?1016lx', '\x1b[?1000;1016h\x1bcx'])('restores the pixel mouse encoding as xterm does: %j', async (stream) => {
    const req: SnapshotRequest = { cols: 20, rows: 4, scrollback: 100, initial: Buffer.from(stream) };
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'off');
    const reference = await generateSnapshotUnqueued(req);
    const native = await generateRustSnapshot(req, 'ansi');
    if (!reference.ok || !native.ok) throw new Error('snapshot failed');
    const pixels = (payload: Buffer) => payload.toString('latin1').includes('\x1b[?1016h');
    expect(pixels(native.payload as Buffer)).toBe(pixels(reference.payload));
  });

  // Evidence for each refusal: without it the Rust payload would diverge.
  it.each(refused.map(c => [c.name, c] as const))('Rust alone diverges on %s', async (_name, { req }) => {
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'off');
    const reference = await generateSnapshotUnqueued(req);
    const native = await generateRustSnapshot(req, 'ansi');
    if (!reference.ok) throw new Error('reference failed');
    if (!native.ok) return expect(native.detail).toMatch(/^unsupported-/);
    expect(await parity(req, native.payload, reference.payload)).toBeDefined();
  });
});
