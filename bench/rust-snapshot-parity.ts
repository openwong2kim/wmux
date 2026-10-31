import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { generateRustSnapshot } from '../src/daemon/RustSnapshot';
import type { Terminal } from '@xterm/headless';
import { snapshotTestTerminal, writeTerminal } from '../src/daemon/snapshotFingerprint';
import { generateSnapshot, generateTextSnapshot, type SnapshotRequest } from '../src/daemon/HeadlessSnapshot';
import { getSnapshotShadowDiagnostics } from '../src/daemon/SnapshotShadow';

const cases = [
  ['\x1b[5mblink\x1b[25m plain', 20], ['\x1b[6mrapid\x1b[0m reset', 20],
  ['\x1b[5mA\x1b[25mB\x1b[5mC', 20], ['\x1b[5mnormal\x1b[?1049h\x1b[6malt', 20],
  ['\x1b[38;5;53mcolor', 20], ['\x1b[48;2;53;55;6mcolor', 20], ['\x1b[38:2::53:55:5mcolor', 20],
  ['', 20], ['hello\r\nworld', 20], ['abcdefgh', 8], ['abcdefghijklmno', 8],
  ['abcdefg한글😀Z', 8], ['abc🫠XYZ🩷tail', 8], ['a e\u0301 ⚠️ 👨‍👩‍👧', 12],
  ['\x1b[1;2;3;4;7;9;31;44mstyled\x1b[0m plain', 30],
  ['\x1b[38;5;123;48;5;42mpalette\x1b[0m', 20],
  ['\x1b[38;2;11;22;33;48;2;44;55;66mrgb', 20],
  ['one\r\ntwo\x1b[1;2HZ', 20], ['abc\r\x1b[44m\x1b[2K', 20],
  ['normal\r\nscroll\x1b[?1049h\x1b[Halt', 20],
  ['normal\x1b[?1049hOTHER\x1b[?1049l', 20],
  ['\x1b[?1h\x1b[?2004h\x1b[?1002h\x1b[?1006hready', 20],
  ['\x1b[4habc', 20], ['\x1b[?7labcdefghijkl', 8],
  ['\x1b[?2026hhello\x1b[?2026l', 20],
  ['\x1b[?2026hhello', 20],
  ['normal\x1b[?1049h\x1b[31malt\x1b[0m', 20],
  ['hello\x1b[31;', 20],
  [Array.from({ length: 50 }, (_, i) => `\x1b[3${i % 8}mline${i}\x1b[0m`).join('\r\n'), 20],
] as const;

/** Modes, cursors and every cell as shown: a blank's foreground, weight,
 * slant and blink are invisible, and xterm's reflow leaves them at random. */
function visibleFingerprint(t: Terminal): string {
  const out: unknown[] = [t.cols, t.rows, t.buffer.active.type, t.modes];
  for (const buffer of [t.buffer.normal, t.buffer.alternate]) {
    if (buffer.type === 'alternate' && t.buffer.active.type !== 'alternate') continue;
    out.push([buffer.type, buffer.baseY, buffer.cursorX, buffer.cursorY]);
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y)!;
      out.push(line.isWrapped);
      for (let x = 0; x < t.cols; x++) {
        const c = line.getCell(x)!;
        const chars = c.getChars() || ' ';
        out.push([chars, c.getWidth(), c.getBgColor(), c.isBgRGB(), c.isBgPalette(), c.isUnderline(), c.isInverse(), c.isStrikethrough(), c.isOverline(),
          ...chars.trim() ? [c.getFgColor(), c.isFgRGB(), c.isFgPalette(), c.isBold(), c.isDim(), c.isItalic(), c.isBlink(), c.isInvisible()] : []]);
      }
    }
  }
  return JSON.stringify(out);
}
const terminalFingerprint = visibleFingerprint;

async function main() {
  const results = [];
  const requests: Array<{ name: string; req: SnapshotRequest }> = cases.map(([text, cols], i) => ({ name: `case-${i}`, req: { cols, rows: 6, scrollback: 100, initial: Buffer.from(text) } }));
  const corpus = path.join(process.cwd(), 'core/harness/corpus');
  for (const name of readdirSync(corpus)) {
    const dir = path.join(corpus, name);
    const events = readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const changes = events.filter(e => e.type === 'resize').map(e => ({ offset: e.byteOffset, ...e.geometry }));
    const start = events[0].geometry;
    const end = changes.at(-1) ?? start;
    requests.push({ name: `corpus/${name}`, req: { cols: end.cols, rows: end.rows, initial: readFileSync(path.join(dir, 'recording.bin')), scrollback: 5000, geometry: { start, changes } } });
  }
  // Deterministic varied cursor paragraphs, history, and width changes.
  for (let seed = 1; seed <= 24; seed++) {
    const text = Array.from({ length: seed }, (_, i) => `\x1b[3${i % 8}m${'abc한'.repeat(1 + i % 5)}\x1b[0m`).join('\r\n');
    const initial = Buffer.from(text);
    const cols = 8 + seed % 13;
    requests.push({ name: `resize-seed-${seed}`, req: { cols, rows: 6, scrollback: 100, initial,
      geometry: { start: { cols: 12, rows: 6 }, changes: [{ offset: initial.length, cols, rows: 6 }] } } });
  }
  requests.push({ name: 'partial-utf8', req: { cols: 20, rows: 6, initial: Buffer.concat([Buffer.from('ready'), Buffer.from([0xf0, 0x9f])]) } });
  for (const { name, req } of requests) {
    const text = req.initial.toString();
    const cols = req.cols;
    const candidate = await generateRustSnapshot(req, 'ansi');
    if (name === 'resize-seed-14') {
      assert(!candidate.ok && candidate.reason === 'error' && candidate.detail?.includes('unsupported-wide-edge'));
      results.push({ name, supported: false, fallbackVerified: true });
      continue;
    }
    assert(candidate.ok, JSON.stringify(candidate));
    const ref = snapshotTestTerminal(req.geometry?.start.cols ?? cols, req.geometry?.start.rows ?? req.rows, req.scrollback ?? 5000);
    const restored = snapshotTestTerminal(cols, req.rows, req.scrollback ?? 5000);
    try {
      let offset = 0;
      for (const change of req.geometry?.changes ?? []) {
        await writeTerminal(ref, req.initial.subarray(offset, change.offset)); offset = change.offset;
        ref.resize(change.cols, change.rows);
      }
      await writeTerminal(ref, req.initial.subarray(offset)); ref.resize(req.cols, req.rows);
      await writeTerminal(restored, candidate.payload);
      const initial = terminalFingerprint(ref) === terminalFingerprint(restored);
      const differences: unknown[] = [];
      if (!initial) {
        for (const key of ['normal', 'alternate'] as const) {
          const a = ref.buffer[key], b = restored.buffer[key];
          differences.push({ key, a: [a.baseY, a.cursorX, a.cursorY, a.length], b: [b.baseY, b.cursorX, b.cursorY, b.length] });
          for (let y = 0; y < a.length && differences.length < 8; y++) {
            const la = a.getLine(y), lb = b.getLine(y);
            const cells = (l: typeof la) => Array.from({ length: cols }, (_, x) => { const c = l?.getCell(x); return c && [c.getChars() || ' ', c.getWidth(), c.getFgColor(), c.getBgColor()]; });
            if (JSON.stringify(cells(la)) !== JSON.stringify(cells(lb)) || la?.isWrapped !== lb?.isWrapped) differences.push({ y, a: la?.translateToString(true), b: lb?.translateToString(true), wa: la?.isWrapped, wb: lb?.isWrapped, ca: cells(la), cb: cells(lb) });
          }
        }
      }
      const tail = name === 'partial-utf8' ? Buffer.from([0x98, 0x80, 0x21]) : text.endsWith('\x1b[31;') ? '44mTAIL\x1b[0m' : '\x1b[?2026lZ한\r\nnext';
      await writeTerminal(ref, tail); await writeTerminal(restored, tail);
      const continued = terminalFingerprint(ref) === terminalFingerprint(restored);
      // Exiting alternate screen also validates the saved normal grid/cursor.
      if (ref.buffer.active.type === 'alternate') {
        await writeTerminal(ref, '\x1b[?1049lX'); await writeTerminal(restored, '\x1b[?1049lX');
      }
      const returned = terminalFingerprint(ref) === terminalFingerprint(restored);
      results.push({ name, supported: true, cols, initial, continued, returned, differences,
        ...initial && continued ? {} : { reference: ref.buffer.active.getLine(ref.buffer.active.baseY)?.translateToString(true),
          restored: restored.buffer.active.getLine(restored.buffer.active.baseY)?.translateToString(true),
          cursors: [[ref.buffer.active.cursorX, ref.buffer.active.cursorY], [restored.buffer.active.cursorX, restored.buffer.active.cursorY]], payload: candidate.payload.toString() } });
    } finally { ref.dispose(); restored.dispose(); }
  }
  const margins = await generateRustSnapshot({ cols: 20, rows: 6, initial: Buffer.from('\x1b[2;4rhello') }, 'ansi');
  assert.deepEqual(margins, { ok: false, reason: 'margins' });
  // Keep the existing fallback contract as the reference, too.
  assert.equal((await generateSnapshot({ cols: 20, rows: 6, initial: Buffer.from('ready') })).ok, true);
  const shadowBefore = getSnapshotShadowDiagnostics();
  const originalModule = process.env.WMUX_RUST_SNAPSHOT_MODULE;
  process.env.WMUX_RUST_SNAPSHOT = 'shadow';
  try {
    const ordinary = await generateSnapshot({ cols: 20, rows: 6, initial: Buffer.from('\x1b[31mready') });
    assert(ordinary.ok);
    assert.equal(getSnapshotShadowDiagnostics().last?.status, 'matched');
    let drains = 0;
    const text = await generateTextSnapshot({ cols: 20, rows: 6, initial: Buffer.from('hello'),
      drainQueue: () => ++drains === 1 ? [Buffer.from(' world')] : [] });
    assert(text.ok && text.rows[0].text === 'hello world');
    assert.equal(drains, 2);
    assert.equal(getSnapshotShadowDiagnostics().last?.status, 'matched');
    // The native compatibility fork now retains blink in cells and cursor state.
    const blink = await generateSnapshot({ cols: 20, rows: 6, initial: Buffer.from('\x1b[5mblink') });
    assert(blink.ok);
    assert.equal(getSnapshotShadowDiagnostics().last?.status, 'matched');
    const restored = snapshotTestTerminal(20, 6);
    try { await writeTerminal(restored, blink.payload); assert(restored.buffer.active.getLine(0)?.getCell(0)?.isBlink()); }
    finally { restored.dispose(); }
    process.env.WMUX_RUST_SNAPSHOT_MODULE = '/definitely/missing/wmux-native.node';
    assert((await generateSnapshot({ cols: 20, rows: 6, initial: Buffer.from('still works') })).ok);
    assert.equal(getSnapshotShadowDiagnostics().last?.status, 'error');
  } finally {
    delete process.env.WMUX_RUST_SNAPSHOT;
    process.env.WMUX_RUST_SNAPSHOT_MODULE = originalModule;
  }
  const shadowAfter = getSnapshotShadowDiagnostics();
  console.log(JSON.stringify({ passed: results.filter(r => 'initial' in r ? r.initial && r.continued && r.returned : r.fallbackVerified).length,
    supported: results.filter(r => r.supported).length, total: results.length, shadowBefore, shadowAfter, results }));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
