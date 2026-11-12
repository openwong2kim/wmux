/**
 * Rendered parity of the Rust ANSI snapshot against xterm's, shared by the
 * parity suites (RustAnsiParity.test.ts and each reason's own suite). Each
 * payload is replayed into a fresh @xterm/headless (the renderer's parser) and
 * the cells, cursor, modes and wrap flags are compared, then again after live
 * bytes continue the stream and after leaving the alternate screen.
 *
 * Accepted deviation: Alacritty cannot tell a printed space from an erased
 * cell, so trailing blanks replay as empty cells. A restored row may drop
 * trailing printed spaces from its copied text; it never gains any, except
 * inside a soft-wrapped paragraph, where copy and reflow ignore the edge, and
 * left of the cursor, where blanks replay as printed (a shell prompt's space).
 *
 * The checks stub WMUX_RUST_SNAPSHOT; a suite stubs WMUX_RUST_SNAPSHOT_MODULE
 * to `modulePath` and skips unless `available`.
 */
import fs from 'node:fs';
import { expect, vi } from 'vitest';
import type { Terminal } from '@xterm/headless';
import { nativeCorePath } from '../../shared/nativeTerminalCore';
import { getAnsiSnapshotBackendDiagnostics } from '../AnsiSnapshotBackend';
import { generateSnapshotUnqueued, type SnapshotRequest } from '../HeadlessSnapshot';
import { generateRustSnapshot } from '../RustSnapshot';
import { snapshotTestTerminal, writeTerminal } from '../snapshotTestTerminal';

export const modulePath = nativeCorePath();
export const available = fs.existsSync(modulePath);
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
export async function parity(req: SnapshotRequest, rust: Buffer, xterm: Buffer): Promise<string | undefined> {
  const restored = await replay(req, rust);
  const fromXterm = difference(restored, await replay(req, xterm));
  return fromXterm && difference(restored, await replay(req)) && fromXterm;
}

/**
 * How `payload` restores against the live terminal: the stream parsed at
 * `req.geometry`'s sizes, then resized to `req.cols`x`req.rows`. The first
 * difference, or undefined.
 */
export async function liveDifference(req: SnapshotRequest, payload: Buffer): Promise<string | undefined> {
  return difference(await replay(req, payload), await replay(req));
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

/** A stream and the backend that must answer it: `rust` natively, `xterm` by a refusal. */
export type Case = { name: string; req: SnapshotRequest; backend: 'rust' | 'xterm' };

export const synthetic = (name: string, text: string, backend: 'rust' | 'xterm' = 'rust', cols = 20): Case =>
  ({ name, backend, req: { cols, rows: 6, scrollback: 100, initial: Buffer.from(text) } });

/** Written at `from` columns, then the pane resized to `to`. */
export const resized = (name: string, text: string, from: [number, number], to: [number, number], backend: 'rust' | 'xterm' = 'rust'): Case => {
  const initial = Buffer.from(text);
  return { name, backend, req: { cols: to[0], rows: to[1], scrollback: 100, initial,
    geometry: { start: { cols: from[0], rows: from[1] }, changes: [{ offset: initial.length, cols: to[0], rows: to[1] }] } } };
};

/** The selected backend answers as `backend` says, and its payload replays like xterm's. */
export async function expectParity({ req, backend }: Case): Promise<void> {
  vi.stubEnv('WMUX_RUST_SNAPSHOT', 'off');
  const reference = await generateSnapshotUnqueued(req);
  vi.stubEnv('WMUX_RUST_SNAPSHOT', 'ansi');
  const selected = await generateSnapshotUnqueued(req);
  expect(reference.ok && selected.ok, JSON.stringify([reference, selected])).toBe(true);
  if (!reference.ok || !selected.ok) return;
  expect(getAnsiSnapshotBackendDiagnostics().last?.backend).toBe(backend);
  expect(await parity(req, selected.payload, reference.payload)).toBeUndefined();
}

/** Evidence for a refusal: Rust alone either refuses or diverges from xterm. */
export async function expectRustAloneDiverges({ req }: Case): Promise<void> {
  vi.stubEnv('WMUX_RUST_SNAPSHOT', 'off');
  const reference = await generateSnapshotUnqueued(req);
  const native = await generateRustSnapshot(req, 'ansi');
  if (!reference.ok) throw new Error('reference failed');
  if (!native.ok) return void expect(native.detail).toMatch(/^unsupported-/);
  expect(await parity(req, native.payload, reference.payload)).toBeDefined();
}
