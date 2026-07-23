// V5 — record memory order when creating 3 wasm instances concurrently (each 80×24 + 1MB feed).
// The nodejs-target wasm-bindgen module is a single wasm instance (shared module), so
// "instance" here means 3 WmuxTerm objects (each with its own grid + Vec allocation in linear memory).
// Measure RSS · external · wasm linear memory (ArrayBuffer bytes) order via process.memoryUsage().
const path = require('node:path');
const wasm = require(path.join(__dirname, '..', 'dist', 'wasm-node', 'wmux_term.js'));
const { WmuxTerm } = wasm;

function synth1MB() {
  const block = Buffer.from(
    '\x1b[32m  Compiling\x1b[0m module \x1b[1msome/path.rs\x1b[0m ok\r\n',
    'latin1'
  );
  const parts = [];
  let len = 0;
  const target = 1024 * 1024;
  while (len < target) { parts.push(block); len += block.length; }
  return Buffer.concat(parts).subarray(0, target);
}

// Wasm linear memory bytes — memory.buffer exposed by wasm-bindgen.
function wasmMemBytes() {
  // nodejs glue holds exports in the `wasm` symbol. Access the memory export.
  try {
    // wasm-bindgen nodejs output uses wasm.memory internally — not in d.ts but
    // present in runtime exports. Probe memory only, without __wbindgen symbols.
    const mod = require(path.join(__dirname, '..', 'dist', 'wasm-node', 'wmux_term_bg.js'));
    // bg.js may be absent (single-file output) — fallback.
    return mod && mod.memory ? mod.memory.buffer.byteLength : null;
  } catch {
    return null;
  }
}

function snap(label) {
  const m = process.memoryUsage();
  return {
    label,
    rssMB: (m.rss / 1048576).toFixed(2),
    externalMB: (m.external / 1048576).toFixed(2),
    arrayBuffersMB: (m.arrayBuffers / 1048576).toFixed(2),
  };
}

// Review feedback: this is NOT three WebAssembly.Instance objects — nodejs glue uses one
// instance per module; below are three WmuxTerm objects sharing that linear memory.
// Per-pane independent Instance (each with its own linear memory) is deferred to E2 (multiple web glue loads).
console.log('[V5] three WmuxTerm objects in one wasm module — memory order');
console.log(`  node ${process.version}`);

const stream = synth1MB();
const rows = [];
rows.push(snap('baseline (after module load)'));

const terms = [];
for (let i = 0; i < 3; i++) {
  const t = new WmuxTerm(80, 24);
  t.feed(stream); // 1MB feed.
  terms.push(t);
  rows.push(snap(`after instance ${i + 1} create + 1MB feed`));
}

// Keep alive (prevent GC).
let checksum = 0;
for (const t of terms) checksum += t.snapshot_row(0).length;

const memBytes = wasmMemBytes();

console.log('  --- process.memoryUsage() order ---');
for (const r of rows) {
  console.log(`  ${r.label.padEnd(30)} rss=${r.rssMB}MB external=${r.externalMB}MB arrayBuffers=${r.arrayBuffersMB}MB`);
}
if (memBytes != null) {
  console.log(`  wasm linear memory (shared instance) = ${(memBytes / 1048576).toFixed(2)} MB`);
} else {
  console.log('  wasm linear memory = (nodejs single-file output — memory export not exposed; using RSS order instead)');
}
console.log(`  (checksum=${checksum})`);

// Memory order check: 3 instances must not explode RSS (each grid is 80*24 char ≈ ~7.7KB).
// This validation records order only — not a pass/fail gate (decision doc V5 = record).
console.log('[V5] OK — order recorded (not a gate; pre-E2 SharedArrayBuffer unmeasured)');
process.exit(0);
