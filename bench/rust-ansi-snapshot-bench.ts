/**
 * 8 MiB ring ANSI snapshot: xterm vs Rust, as SessionPipe's attach requests it
 * (120x40, 100k rows of scrollback). Prints JSON; see rust-ansi-snapshot.md.
 *
 *   bash core/wmux-term/build-native-core.sh
 *   npx esbuild bench/rust-ansi-snapshot-bench.ts --bundle --platform=node --outfile=<dir>/bench.cjs
 *   WMUX_RUST_SNAPSHOT_MODULE="$PWD/core/wmux-term/dist/native-core/index.cjs" node <dir>/bench.cjs
 */
import { Buffer } from 'node:buffer';
import { getAnsiSnapshotBackendDiagnostics } from '../src/daemon/AnsiSnapshotBackend';
import { generateSnapshotUnqueued, MAX_SCROLLBACK, type SnapshotRequest } from '../src/daemon/HeadlessSnapshot';
import { generateRustSnapshot } from '../src/daemon/RustSnapshot';
import { CLAUDE_WRAPPED_REPLY_80x30 } from '../src/renderer/terminal/__tests__/fixtures/claudeWrappedReply';

const SIZE = 8 * 1024 * 1024;
const COLS = 120, ROWS = 40;

function fill(chunk: (i: number) => string): Buffer {
  const parts: Buffer[] = [];
  let total = 0;
  for (let i = 0; total < SIZE; i++) {
    const b = Buffer.from(chunk(i));
    parts.push(b);
    total += b.length;
  }
  return Buffer.concat(parts).subarray(0, SIZE);
}

const claude = Buffer.from(CLAUDE_WRAPPED_REPLY_80x30, 'base64').toString('utf8');
const workloads: Record<string, Buffer> = {
  // A Claude Code session: its fullscreen renderer's frames, over and over.
  'claude-frames': fill(() => claude),
  // A progress display: clear, then repaint a few colored rows.
  'redraw': fill(i => `\x1b[H\x1b[2Jprogress ${i % 100}%\r\n\x1b[3${i % 8}mstatus line ${'.'.repeat(80)}\x1b[0m`),
  // A shell: prompts, colored command output, an occasional clear.
  'shell': fill(i => `\x1b[32muser@host\x1b[0m:\x1b[34m~/src\x1b[0m$ make ${i}\r\n${
    Array.from({ length: 6 }, (_, k) => `\x1b[3${k % 8}m  CC  src/module_${i}_${k}.c\x1b[0m`).join('\r\n')}\r\n${i % 200 === 199 ? '\x1b[H\x1b[2J' : ''}`),
  // A log flood: 8 MiB of appended lines, far past what any client keeps.
  'log-flood': fill(i => `\x1b[3${i % 8}m[${String(i).padStart(7, '0')}] INFO request handled in ${i % 97} ms\x1b[0m\r\n`),
};

async function time(run: () => Promise<{ ok: boolean }>): Promise<{ ms: number; ok: boolean }> {
  const started = performance.now();
  const result = await run();
  return { ms: Math.round(performance.now() - started), ok: result.ok };
}

async function main(): Promise<void> {
  const results: Record<string, unknown> = {};
  for (const [name, initial] of Object.entries(workloads)) {
    const req: SnapshotRequest = { cols: COLS, rows: ROWS, scrollback: MAX_SCROLLBACK, initial, budgetMs: 60_000 };
    const runs: Array<Record<string, unknown>> = [];
    for (let round = 0; round < 3; round++) {
      process.env.WMUX_RUST_SNAPSHOT = 'off';
      const xterm = await time(() => generateSnapshotUnqueued(req));
      const rust = await time(() => generateRustSnapshot(req, 'ansi'));
      process.env.WMUX_RUST_SNAPSHOT = 'ansi';
      const selected = await time(() => generateSnapshotUnqueued(req));
      runs.push({ xterm, rust, selected, backend: getAnsiSnapshotBackendDiagnostics().last });
    }
    const median = (key: string) => runs.map(r => (r[key] as { ms: number }).ms).sort((a, b) => a - b)[1];
    results[name] = { bytes: initial.length, xtermMs: median('xterm'), rustMs: median('rust'), selectedMs: median('selected'),
      rustOk: (runs[0].rust as { ok: boolean }).ok, selectedBackend: runs[0].backend };
  }
  console.log(JSON.stringify(results, null, 2));
}
main().catch(err => { console.error(err); process.exitCode = 1; });
