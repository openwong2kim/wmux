// V4b — wasm skeleton feed throughput microbench.
// Gate ≥75MB/s (50% of budget 150). Hard to load web-target wasm in Node, so we also
// build the wasm-bindgen nodejs target for measurement (decision doc V4b allowance).
// nodejs and web targets share the same .wasm binary (wmux_term_bg.wasm) — glue differs.
const path = require('node:path');
const { WmuxTerm } = require(path.join(__dirname, '..', 'dist', 'wasm-node', 'wmux_term.js'));

// V4a uses the same synthetic stream (fair comparison).
function synthStream(targetBytes) {
  const block = Buffer.from(
    '\x1b[31mERROR\x1b[0m build failed at \x1b[1msrc/main.rs:42\x1b[0m: ' +
    'expected `;` \x1b[2mnote: consider adding\x1b[0m\r\n' +
    '\x1b[32m  Compiling\x1b[0m wmux-term v0.0.0 (units 1/1)\r\n',
    'latin1'
  );
  const parts = [];
  let len = 0;
  while (len < targetBytes) { parts.push(block); len += block.length; }
  return Buffer.concat(parts).subarray(0, targetBytes);
}

const TOTAL = 64 * 1024 * 1024; // 64MB
const CHUNK = 16 * 1024;
const stream = synthStream(TOTAL);

// Warmup — 3MB (JIT + wasm instance stabilization).
{
  const g = new WmuxTerm(80, 24);
  const warm = stream.subarray(0, 3 * 1024 * 1024);
  for (let off = 0; off < warm.length; off += CHUNK) {
    g.feed(warm.subarray(off, off + CHUNK));
  }
}

// Measurement.
const g = new WmuxTerm(80, 24);
const t0 = process.hrtime.bigint();
let accDirty = 0;
for (let off = 0; off < stream.length; off += CHUNK) {
  const r = g.feed(stream.subarray(off, off + CHUNK));
  accDirty += r.dirty_rows;
}
const t1 = process.hrtime.bigint();

const secs = Number(t1 - t0) / 1e9;
const mb = TOTAL / (1024 * 1024);
const mbps = mb / secs;

console.log('[V4b] wasm skeleton feed throughput (nodejs target — same .wasm as web)');
console.log(`  node ${process.version}`);
console.log(`  bytes    = ${mb} MB`);
console.log(`  elapsed  = ${secs.toFixed(4)} s`);
console.log(`  throughput = ${mbps.toFixed(1)} MB/s`);
console.log(`  gate     = 75 MB/s (50% of 150 budget)`);
console.log(`  (accDirty=${accDirty} — prevent optimization)`);
if (mbps >= 75.0) {
  console.log('  RESULT   = PASS');
  process.exit(0);
} else {
  console.log('  RESULT   = BELOW GATE (design review trigger data)');
  process.exit(2);
}
