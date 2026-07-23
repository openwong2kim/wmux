// V1 — require .node addon in plain Node → new/feed/snapshot_row round-trip.
// Success: round-trip results match expectations + exit 0.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const addon = require(path.join(here, '..', 'dist', 'napi', 'index.cjs'));

const { WmuxTerm } = addon;

let fail = 0;
function check(name, cond, got) {
  if (cond) {
    console.log(`  PASS ${name}`);
  } else {
    console.error(`  FAIL ${name} — got: ${JSON.stringify(got)}`);
    fail++;
  }
}

console.log('[V1] pure Node + napi .node round trip');
console.log(`  node ${process.version}`);

const term = new WmuxTerm(10, 3);
check('cols getter', term.cols === 10, term.cols);
check('rows getter', term.rows === 3, term.rows);

const enc = new TextEncoder();
const r1 = term.feed(enc.encode('hi'));
check('feed dirtyRows=1', r1.dirtyRows === 1, r1);
check('feed writebackLen=0 (skeleton constant)', r1.writebackLen === 0, r1);
check('snapshot_row(0) = "hi" + spaces', term.snapshotRow(0) === 'hi        ', JSON.stringify(term.snapshotRow(0)));

const r2 = term.feed(enc.encode('\r\ncd'));
check('after CRLF snapshot_row(1) = "cd"', term.snapshotRow(1) === 'cd        ', JSON.stringify(term.snapshotRow(1)));

// SGR sequences must not leak into cells (parser swallows them).
term.reset();
term.feed(enc.encode('\x1b[31mred\x1b[0m'));
check('reset + CSI swallow → "red" only', term.snapshotRow(0) === 'red       ', JSON.stringify(term.snapshotRow(0)));

if (fail === 0) {
  console.log('[V1] OK — full round trip passed');
  process.exit(0);
} else {
  console.error(`[V1] FAIL — ${fail} case(s)`);
  process.exit(1);
}
