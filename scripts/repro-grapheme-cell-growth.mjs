// Standalone reproduction: one grapheme cluster can make a single cell hold
// unbounded text, so a scrollback limit expressed in ROWS stops bounding the
// buffer's memory.
//
// This file deliberately has ZERO dependencies on the wmux source tree. Copy it
// anywhere with the packages below installed and run it:
//
//   npm i @xterm/headless@6 @xterm/addon-unicode-graphemes@0.4.0 @xterm/addon-unicode11@0.9.0
//   node --expose-gc repro-grapheme-cell-growth.mjs
//
// --expose-gc is optional. Without it the retained-heap column is omitted
// rather than reported unreliably.
//
// ── What this measures, and what it does NOT claim ──────────────────────────
//
// The primary evidence is CHARACTER COUNT, not heap:
//
//   • how many chars a single cell holds,
//   • how many chars the whole buffer holds versus how many cells it has,
//   • that both survive scrollback trimming, because trimming evicts rows and
//     this is one row.
//
// Those numbers are exact and platform-independent. Heap is reported only as a
// secondary signal: it is sensitive to the V8 version, GC timing and the
// platform, so it should not carry the argument.
//
// This is NOT a claim that the buffer grows without ever freeing anything. Row
// eviction still works — push the row far enough back and it is released. The
// claim is narrower and, we think, the one that matters: the memory a terminal
// buffer can hold is normally bounded by `rows × cols × O(1) per cell`, and
// grapheme clustering removes the `O(1) per cell` term. A buffer holding its
// configured number of rows can hold arbitrarily more than that bound implies.
//
// Whether that is a bug or correct-per-UAX-#29 behaviour is exactly the
// question for upstream: an unbounded ZWJ chain IS a single grapheme cluster by
// spec, so storing it in one cell is a faithful implementation. The observation
// here is only that the result is unbounded per cell and that the addon offers
// the embedder no way to bound it.

import { createRequire } from 'node:module';
import headless from '@xterm/headless';
import graphemes from '@xterm/addon-unicode-graphemes';
import unicode11 from '@xterm/addon-unicode11';

const require = createRequire(import.meta.url);
/** Resolve the installed version so the environment record is measured, not asserted. */
function installedVersion(pkg) {
  try {
    return require(`${pkg}/package.json`).version;
  } catch {
    return 'unknown';
  }
}

const { Terminal } = headless;
const { UnicodeGraphemesAddon } = graphemes;
const { Unicode11Addon } = unicode11;

const COLS = 80;
const ROWS = 24;
const SCROLLBACK = 50;
/** Emoji joined pairwise by ZWJ. By UAX #29 the whole run is one cluster. */
const CHAIN_LENGTH = 500_000;
const ZWJ = '‍';

const write = (term, data) => new Promise((resolve) => term.write(data, resolve));

function makeTerminal(kind) {
  const term = new Terminal({
    cols: COLS,
    rows: ROWS,
    scrollback: SCROLLBACK,
    allowProposedApi: true,
    logLevel: 'off',
  });
  if (kind === 'unicode11') {
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
  } else {
    term.loadAddon(new UnicodeGraphemesAddon());
    term.unicode.activeVersion = '15-graphemes';
  }
  return term;
}

/** Exact character census of every cell currently in the buffer. */
function censusBuffer(term) {
  const buffer = term.buffer.active;
  let cells = 0;
  let totalChars = 0;
  let maxCellChars = 0;
  const rowCount = buffer.length;
  for (let y = 0; y < rowCount; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    for (let x = 0; x < line.length; x++) {
      cells++;
      const chars = line.getCell(x)?.getChars() ?? '';
      totalChars += chars.length;
      if (chars.length > maxCellChars) maxCellChars = chars.length;
    }
  }
  return { rowCount, cells, totalChars, maxCellChars };
}

function retainedHeapBytes() {
  if (typeof global.gc !== 'function') return null;
  global.gc();
  global.gc();
  return process.memoryUsage().heapUsed;
}

async function run(kind) {
  const heapBefore = retainedHeapBytes();
  const term = makeTerminal(kind);

  // One cluster: CHAIN_LENGTH emoji joined by ZWJ, written at home.
  const chain = Array.from({ length: CHAIN_LENGTH }, () => '\u{1F468}').join(ZWJ);
  const inputChars = chain.length;
  const inputUtf8Bytes = Buffer.byteLength(chain, 'utf8');
  await write(term, `\x1b[H${chain}`);

  const afterWrite = censusBuffer(term);

  // Now drive scrollback trimming: emit more rows than the scrollback holds
  // minus a margin, so eviction is actively running, but keep the cluster row
  // inside the retained window. This is what "survives trimming" means here —
  // not that the row is un-evictable, but that trimming is row-based and does
  // not look at how much a row costs.
  const filler = Array.from({ length: SCROLLBACK - 2 }, (_, i) => `filler ${i}`).join('\r\n');
  await write(term, `\r\n${filler}`);

  const afterTrim = censusBuffer(term);
  const heapAfter = retainedHeapBytes();
  const retained = heapBefore !== null && heapAfter !== null ? heapAfter - heapBefore : null;

  term.dispose();
  return { kind, inputChars, inputUtf8Bytes, afterWrite, afterTrim, retained };
}

const fmt = (n) => n.toLocaleString('en-US');
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

console.log('grapheme cell growth — standalone reproduction');
console.log('='.repeat(78));
console.log(`node            ${process.version}`);
console.log(`platform        ${process.platform} ${process.arch}`);
console.log(`@xterm/headless                  ${installedVersion('@xterm/headless')}`);
console.log(`@xterm/addon-unicode-graphemes   ${installedVersion('@xterm/addon-unicode-graphemes')}`);
console.log(`@xterm/addon-unicode11           ${installedVersion('@xterm/addon-unicode11')}`);
console.log(`terminal        cols=${COLS} rows=${ROWS} scrollback=${SCROLLBACK}`);
console.log(`input           ${fmt(CHAIN_LENGTH)} emoji joined by ZWJ (one cluster per UAX #29)`);
console.log(`retained heap   ${typeof global.gc === 'function' ? 'measured after two forced GCs' : 'NOT MEASURED (re-run with --expose-gc)'}`);
console.log('='.repeat(78));

for (const kind of ['unicode11', 'graphemes']) {
  const r = await run(kind);
  const cap = r.afterTrim.cells;
  console.log('');
  console.log(`── ${kind} ${'─'.repeat(72 - kind.length)}`);
  console.log(`  input                       ${fmt(r.inputChars)} chars / ${mb(r.inputUtf8Bytes)} utf8`);
  console.log(`  PRIMARY  max chars in ONE cell        ${fmt(r.afterTrim.maxCellChars)}`);
  console.log(`  PRIMARY  buffer cells                 ${fmt(cap)}  (${r.afterTrim.rowCount} rows x ${COLS} cols)`);
  console.log(`  PRIMARY  chars held by those cells    ${fmt(r.afterTrim.totalChars)}`);
  console.log(`  PRIMARY  chars per cell               ${(r.afterTrim.totalChars / cap).toFixed(1)}   <- expected ~1 for an O(1)-per-cell buffer`);
  console.log(`  max cell chars before -> after trim    ${fmt(r.afterWrite.maxCellChars)} -> ${fmt(r.afterTrim.maxCellChars)}  (row eviction does not weigh rows)`);
  console.log(`  secondary  cluster utf16 bytes        ~${mb(r.afterTrim.maxCellChars * 2)} (chars x 2)`);
  console.log(`  secondary  retained heap              ${r.retained === null ? 'n/a' : mb(r.retained)}`);
}

console.log('');
console.log('='.repeat(78));
console.log('Read the PRIMARY lines. Under unicode11 every cell holds O(1) chars and the');
console.log('row/cell count bounds the buffer. Under grapheme clustering one cell holds the');
console.log('entire run, so "scrollback = N rows" no longer implies a memory bound — and the');
console.log('addon exposes no way for an embedder to cap it.');
console.log('');
console.log('The gap between cluster utf16 bytes and retained heap is NOT analysed here.');
console.log('It may be V8 cons-string (rope) retention from repeated concatenation rather');
console.log('than the cluster itself. That is a separate question; the PRIMARY lines stand');
console.log('regardless of how it resolves.');
