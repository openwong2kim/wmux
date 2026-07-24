// =============================================================================
// recover-scrollback.mjs — one-shot recovery for v2.8.x → v2.9.0 migration
// =============================================================================
//
// Invoked via `node scripts/recover-scrollback.mjs` (no shebang). Importing
// a shebang'd ESM module is unreliable under vitest on Windows — the
// shebang is left in place and Node's ESM parser fails with
// `SyntaxError: Invalid or unexpected token`. Keep the entry point
// node-prefixed so the file stays import-safe.
//
// Background
// ----------
// In wmux v2.8.x the renderer's `serializeTerminalBuffer` could dump the
// xterm buffer while a FitAddon collapse had reflowed cols to ~2 (hidden
// container, minimize, layout teardown). The on-disk dump captured that
// state as a column of single characters separated by CRLF:
//
//     PS\r\n C\r\n:\\\r\nUs\r\ner\r\ns\\\r\nri\r\nzz\r\n>
//
// v2.9.0 ships a fix that prevents new corruption AND moves any
// already-corrupt files into `<userData>/wmux/scrollback/corrupted/`
// on first launch (with full backup chain preserved) so the user does
// not lose access to the raw bytes. This tool reads those quarantined
// files and reverse-reflows them back into human-readable text.
//
// Heuristic
// ---------
// 1. Skip files whose content does NOT match the cols-collapse signature
//    (median non-empty line length ≤ 3 chars AND CRLF byte ratio ≥ 0.3).
//    Recovering a non-corrupt file would produce nonsense.
// 2. For corrupt files:
//      - Split on `\r\n` into physical rows.
//      - Empty / whitespace-only rows are paragraph boundaries (they
//        were genuinely blank rows in xterm).
//      - Non-empty rows concatenate (no separator — the CRLF between
//        them was a wrap point, not a real newline).
//      - Output paragraphs joined with `\n`.
//
// Limits
// ------
//   - Real newlines that the user typed are mostly recovered if they
//     happened to leave a blank row between commands; otherwise they
//     fuse with the following line. The character content is preserved
//     losslessly; only the exact wrap structure is approximate.
//   - This tool is read-only against the source dir. It writes to a
//     separate output dir (default: ~/<exe>-recovered-<date>). The
//     quarantined originals are never modified.
//
// CLI
// ---
//     node scripts/recover-scrollback.mjs [options]
//
// Options:
//     -i, --input <dir>     Source dir of quarantined files
//                           (default: %APPDATA%/<productName>/scrollback/corrupted/)
//     -o, --output <dir>    Output dir for recovered .txt files
//                           (default: ~/<exe>-recovered-YYYY-MM-DD)
//     -n, --dry-run         Analyze and report without writing
//     -v, --verbose         Per-file stats + preview
//     -h, --help            Show this help
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { EXECUTABLE_NAME, PRODUCT_NAME } from './helpers/packaged-app.mjs';

// ── Tunables (mirror corruption.ts) ────────────────────────────────────────

/** Files below this byte count are too small to reliably classify. */
const MIN_CONTENT_BYTES_TO_JUDGE = 256;
/** Need at least this many non-empty lines for a stable median. */
const MIN_NONEMPTY_LINES_TO_JUDGE = 20;
/** Median non-empty line length at or below this triggers the corrupt verdict. */
const MAX_MEDIAN_NONEMPTY_LEN_FOR_CORRUPT = 3;
/** CRLF byte ratio at or above this triggers the corrupt verdict. */
const MIN_CRLF_BYTE_RATIO_FOR_CORRUPT = 0.3;

const CR = 0x0d;
const LF = 0x0a;

// ── Pure functions (testable) ──────────────────────────────────────────────

/** Single-pass scan returning the stats the verdict heuristic needs. */
export function scanContent(content) {
  const totalBytes = content.length;
  let crlfBytes = 0;
  const nonEmptyLengths = [];
  let lineStart = 0;
  for (let i = 0; i < totalBytes; i++) {
    const c = content.charCodeAt(i);
    if (c === CR && i + 1 < totalBytes && content.charCodeAt(i + 1) === LF) {
      const lineLen = i - lineStart;
      if (lineLen > 0) nonEmptyLengths.push(lineLen);
      crlfBytes += 2;
      i += 1;
      lineStart = i + 1;
    } else if (c === LF) {
      const lineLen = i - lineStart;
      if (lineLen > 0) nonEmptyLengths.push(lineLen);
      crlfBytes += 1;
      lineStart = i + 1;
    }
  }
  if (lineStart < totalBytes) nonEmptyLengths.push(totalBytes - lineStart);
  return { totalBytes, crlfBytes, nonEmptyLengths };
}

function medianAscending(sortedAsc) {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sortedAsc[mid];
  return (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

/**
 * Mirror of `analyzeScrollbackContent` from
 * `src/main/scrollback/corruption.ts`. Kept in sync by convention; the
 * algorithm is small and stable. If the production detector is ever
 * tuned, mirror the change here AND the test fixture below.
 */
export function isLikelyChoppedScrollback(content) {
  if (!content || content.length < MIN_CONTENT_BYTES_TO_JUDGE) return false;
  const { totalBytes, crlfBytes, nonEmptyLengths } = scanContent(content);
  if (nonEmptyLengths.length < MIN_NONEMPTY_LINES_TO_JUDGE) return false;
  const sorted = [...nonEmptyLengths].sort((a, b) => a - b);
  const median = medianAscending(sorted);
  const ratio = totalBytes > 0 ? crlfBytes / totalBytes : 0;
  if (median > MAX_MEDIAN_NONEMPTY_LEN_FOR_CORRUPT) return false;
  if (ratio < MIN_CRLF_BYTE_RATIO_FOR_CORRUPT) return false;
  return true;
}

/**
 * Reverse-reflow a cols=2 chopped buffer back into readable text.
 *
 * Algorithm
 *   - Split on `\r\n`.
 *   - Whitespace-only or empty rows are paragraph boundaries (carrying
 *     at most one blank line of separation into the output).
 *   - Non-empty rows concatenate with no separator within a paragraph.
 *   - Paragraphs join with `\n`.
 *
 * **Pure transform** — does NOT gate on the corruption detector. Apply
 * `isLikelyChoppedScrollback(raw)` first when the caller needs the
 * abstain behaviour (see `processFile` for the file-level wrapper that
 * does exactly that).
 */
export function reverseReflowFromCols2(raw) {
  const rows = raw.split('\r\n');
  const paragraphs = [];
  let current = '';
  let sawBlank = false;

  for (const row of rows) {
    if (row.length === 0 || /^\s+$/.test(row)) {
      if (current.length > 0) {
        paragraphs.push(current);
        current = '';
      }
      sawBlank = true;
    } else {
      if (sawBlank && paragraphs.length > 0) {
        paragraphs.push(''); // marker for one blank line between paragraphs
      }
      sawBlank = false;
      current += row;
    }
  }
  if (current.length > 0) paragraphs.push(current);
  return paragraphs.join('\n');
}

// ── CLI plumbing ───────────────────────────────────────────────────────────

const HELP = `recover-scrollback — reverse-reflow chopped wmux scrollback dumps

USAGE
    node scripts/recover-scrollback.mjs [options]

OPTIONS
    -i, --input <dir>     Source dir of quarantined files
                          (default: %APPDATA%/<productName>/scrollback/corrupted)
    -o, --output <dir>    Output dir for recovered .txt files
                          (default: ~/<exe>-recovered-YYYY-MM-DD)
    -n, --dry-run         Analyze and report without writing
    -v, --verbose         Print per-file stats + first 80 chars preview
    -h, --help            Show this help
`;

function defaultInputDir() {
  const appData = process.env.APPDATA;
  if (appData) return path.join(appData, PRODUCT_NAME, 'scrollback', 'corrupted');
  // Linux / macOS — wmux is Windows-only today but be future-friendly.
  return path.join(os.homedir(), '.config', PRODUCT_NAME, 'scrollback', 'corrupted');
}

function defaultOutputDir() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(os.homedir(), `${EXECUTABLE_NAME}-recovered-${date}`);
}

function deriveOutputName(quarantineName) {
  // Quarantined names look like:
  //   surface-<uuid>.txt.<ts>.bak
  //   surface-<uuid>.txt.bak.<ts>.bak
  // Strip the trailing `.<ts>.bak` produced by quarantine, then add .recovered.txt.
  return (
    quarantineName.replace(/\.\d+\.bak$/, '') + '.recovered.txt'
  );
}

export function processFile(srcPath, { dryRun = false, verbose = false, outDir } = {}) {
  const raw = fs.readFileSync(srcPath, 'utf-8');
  const stats = scanContent(raw);
  const sorted = [...stats.nonEmptyLengths].sort((a, b) => a - b);
  const median = medianAscending(sorted);
  const ratio = stats.totalBytes > 0 ? stats.crlfBytes / stats.totalBytes : 0;
  const corrupt = isLikelyChoppedScrollback(raw);

  let recovered = null;
  let outPath = null;
  if (corrupt) {
    recovered = reverseReflowFromCols2(raw);
    if (outDir) {
      outPath = path.join(outDir, deriveOutputName(path.basename(srcPath)));
      if (!dryRun) fs.writeFileSync(outPath, recovered, 'utf-8');
    }
  }

  return {
    src: srcPath,
    bytes: stats.totalBytes,
    nonEmptyLines: stats.nonEmptyLengths.length,
    median,
    crlfRatio: ratio,
    corrupt,
    recoveredBytes: recovered ? recovered.length : 0,
    outPath,
    preview: recovered ? recovered.slice(0, 80).replace(/\n/g, ' / ') : null,
  };
}

function formatReport(rows, verbose) {
  const lines = [];
  for (const r of rows) {
    const base = path.basename(r.src);
    if (r.corrupt) {
      lines.push(
        `  CORRUPT  ${base.padEnd(60)} ${String(r.bytes).padStart(6)}B → ${String(r.recoveredBytes).padStart(5)}B${r.outPath ? '  → ' + r.outPath : ''}`,
      );
    } else {
      lines.push(
        `  SKIP     ${base.padEnd(60)} ${String(r.bytes).padStart(6)}B  (median=${r.median}, crlfRatio=${r.crlfRatio.toFixed(3)})`,
      );
    }
    if (verbose && r.corrupt && r.preview) {
      lines.push(`           preview: ${r.preview}`);
    }
  }
  return lines.join('\n');
}

function parseCliArgs(argv) {
  return parseArgs({
    args: argv,
    options: {
      input: { type: 'string', short: 'i' },
      output: { type: 'string', short: 'o' },
      'dry-run': { type: 'boolean', short: 'n' },
      verbose: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
    strict: true,
  });
}

export function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    console.error(`error: ${err.message}\n`);
    console.error(HELP);
    process.exitCode = 2;
    return;
  }

  if (parsed.values.help) {
    console.log(HELP);
    return;
  }

  const inputDir = parsed.values.input ?? defaultInputDir();
  const outputDir = parsed.values.output ?? defaultOutputDir();
  const dryRun = parsed.values['dry-run'] ?? false;
  const verbose = parsed.values.verbose ?? false;

  if (!fs.existsSync(inputDir)) {
    console.error(`error: input dir does not exist: ${inputDir}`);
    process.exitCode = 1;
    return;
  }

  const entries = fs.readdirSync(inputDir).filter((f) => f.endsWith('.bak'));
  if (entries.length === 0) {
    console.log(`No quarantined files found in ${inputDir}`);
    return;
  }

  if (!dryRun) fs.mkdirSync(outputDir, { recursive: true });

  console.log(`Source: ${inputDir}`);
  console.log(`Output: ${dryRun ? '(dry-run, nothing written)' : outputDir}`);
  console.log(`Files:  ${entries.length}\n`);

  const results = [];
  for (const name of entries) {
    const src = path.join(inputDir, name);
    const result = processFile(src, {
      dryRun,
      verbose,
      outDir: dryRun ? null : outputDir,
    });
    results.push(result);
  }

  console.log(formatReport(results, verbose));

  const corruptCount = results.filter((r) => r.corrupt).length;
  const skipCount = results.length - corruptCount;
  console.log('');
  console.log(`Done — ${corruptCount} recovered, ${skipCount} skipped.`);
  if (!dryRun && corruptCount > 0) {
    console.log(`Open ${outputDir} to read the recovered text.`);
  }
}

// Run as CLI only when invoked directly.
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`;
if (invokedDirectly) {
  main();
}
