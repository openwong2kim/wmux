#!/usr/bin/env node
// The Rust output ring with and without `session.ringCompression`
// (core/wmux-term/src/ring_pack.rs): memory of 6 sessions × 8 MiB, sustained
// write throughput of one hot pane, and the cost of a full read.
//
//   bash core/wmux-term/build-native-core.sh
//   node bench/rust-ring-compression.mjs [corpus-file ...]
//
// Each mode runs in its own child process, so RSS is not shared between them.
// Without corpus files the corpus is this checkout's coloured `git log -p`
// plus a synthetic agent-TUI redraw stream (see `corpus`). Results go to stdout
// as JSON; bench/rust-daemon-memory.md records a run.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const modulePath = process.env.WMUX_TERMINAL_CORE_MODULE || path.join(root, 'core/wmux-term/dist/native-core/index.cjs');
const MIB = 1024 * 1024;
const SESSIONS = 6;
const RING = 8 * MIB;
const HOT_BYTES = 256 * MIB;

function corpus(files) {
  if (files.length > 0) return Buffer.concat(files.map((f) => fs.readFileSync(f)));
  const log = execFileSync('git', ['log', '-p', '--color=always', '-n', '1500'], { cwd: root, maxBuffer: 256 * MIB });
  // An agent TUI's inline redraw: cursor up, erase, a spinner and status lines.
  const frames = [];
  let x = 1;
  for (let n = 0; n < 4000; n++) {
    x = (x * 1103515245 + 12345) >>> 0;
    frames.push(`\x1b[?2026h\x1b[3A\x1b[2K\x1b[38;5;${x % 256}m✻ Thinking… (${n % 600}s · ↑ ${x % 99999} tokens)\x1b[0m\r\n`
      + `\x1b[2K\x1b[2m  ⎿  Read src/daemon/file${x % 500}.ts (${x % 900} lines)\x1b[22m\r\n\x1b[2K> \x1b[7m \x1b[27m\r\n\x1b[?2026l`);
  }
  return Buffer.concat([log.subarray(0, 24 * MIB), Buffer.from(frames.join(''))]);
}

/** `total` bytes of `data`, cut into PTY-sized writes of 4–64 KiB. */
function* writes(data, total, seed) {
  let at = (seed * 7919 * 4096) % data.length;
  let x = seed + 1;
  for (let done = 0; done < total;) {
    x = (x * 1103515245 + 12345) >>> 0;
    const n = Math.min(4096 + (x % (60 * 1024)), total - done, data.length - at);
    yield data.subarray(at, at + n);
    done += n;
    at = (at + n) % data.length;
  }
}

function child(mode, corpusFile) {
  const { NativeRing } = createRequire(modulePath)(modulePath);
  const compress = mode === 'compressed';
  const data = fs.readFileSync(corpusFile);
  globalThis.gc?.();
  const rssBefore = process.memoryUsage().rss;
  const rings = [];
  for (let s = 0; s < SESSIONS; s++) {
    const ring = new NativeRing(RING, compress);
    for (const part of writes(data, RING + 2 * MIB, s)) ring.write(part);
    rings.push(ring);
  }
  globalThis.gc?.();
  const rssFilled = process.memoryUsage().rss;
  const allocated = rings.reduce((sum, r) => sum + r.allocatedBytes, 0);
  const stored = rings.reduce((sum, r) => sum + r.size, 0);
  const readMs = [];
  const digests = [];
  for (const ring of rings) {
    const t = process.hrtime.bigint();
    const bytes = ring.readAll();
    readMs.push(Number(process.hrtime.bigint() - t) / 1e6);
    digests.push(createHash('sha256').update(bytes).digest('hex'));
  }
  for (const ring of rings) ring.dispose();
  // One hot pane: sustained output through one ring, three timed passes.
  const hot = [];
  for (let pass = 0; pass < 3; pass++) {
    const ring = new NativeRing(RING, compress);
    const parts = [...writes(data, HOT_BYTES, 100 + pass)];
    const t = process.hrtime.bigint();
    for (const part of parts) ring.write(part);
    const s = Number(process.hrtime.bigint() - t) / 1e9;
    hot.push(HOT_BYTES / MIB / s);
    ring.dispose();
  }
  hot.sort((a, b) => a - b);
  readMs.sort((a, b) => a - b);
  return {
    mode,
    sessions: SESSIONS,
    ringMiB: RING / MIB,
    storedMiB: stored / MIB,
    allocatedMiB: allocated / MIB,
    rssGrowthMiB: (rssFilled - rssBefore) / MIB,
    readAllMsMedian: readMs[Math.floor(readMs.length / 2)],
    hotPaneMiBps: { median: hot[1], min: hot[0], max: hot[2] },
    digests,
  };
}

if (process.argv[2] === '--child') {
  process.stdout.write(JSON.stringify(child(process.argv[3], process.argv[4])));
} else {
  if (!fs.existsSync(modulePath)) throw new Error(`Build the native core first: ${modulePath}`);
  const data = corpus(process.argv.slice(2));
  if (data.length === 0) throw new Error('The corpus is empty');
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || root, 'wmux-ring-bench-'));
  const corpusFile = path.join(dir, 'corpus.bin');
  fs.writeFileSync(corpusFile, data);
  const run = (mode) => {
    const r = spawnSync(process.execPath, ['--expose-gc', import.meta.filename, '--child', mode, corpusFile], { encoding: 'utf8', maxBuffer: 16 * MIB });
    if (r.status !== 0) throw new Error(`${mode} run failed: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const raw = run('raw');
  const compressed = run('compressed');
  fs.rmSync(dir, { recursive: true, force: true });
  if (raw.digests.join() !== compressed.digests.join()) throw new Error('readAll() bytes differ between modes');
  for (const r of [raw, compressed]) delete r.digests;
  console.log(JSON.stringify({
    corpusMiB: data.length / MIB,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    identicalReads: true,
    raw,
    compressed,
  }, null, 2));
}
