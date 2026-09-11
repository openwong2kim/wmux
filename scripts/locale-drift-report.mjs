#!/usr/bin/env node
// #1037 — locale drift advisory.
//
// The class this catches is invisible to the coverage test by construction:
// the key EXISTS and the {placeholders} match — only the MEANING went stale
// because the English source changed after the translation was written.
// Structure can't see that; history can. This script compares per-key
// `git blame` timestamps between en.ts and a locale file and lists every key
// whose English line is newer than its translated line.
//
// ADVISORY, never a gate: the method has a real false-positive rate (a
// reformatted or moved English line trips it with no meaning change — 7 of
// 13 candidates in the original audit). A human judges; the tool just stops
// the class from being invisible. CI runs it with --check, which prints the
// report and exits 0 regardless (a findings-annotated log line, not a red X).
//
// Usage:
//   node scripts/locale-drift-report.mjs            # all maintained locales
//   node scripts/locale-drift-report.mjs pl ko zh   # explicit set
//   node scripts/locale-drift-report.mjs --check    # CI mode (also exit 0)
//
// "Maintained" = full-coverage locales (pl via its lock test; ko/zh per
// #997). The 20 stalled locales are an accepted gap — auditing them would be
// pure noise until someone owns them.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EN = path.join(ROOT, 'src/renderer/i18n/locales/en.ts');
const DEFAULT_LOCALES = ['pl', 'ko', 'zh'];

function blameTimestamps(file) {
  // -C -C: follow renames/copies so a key translated in an older file layout
  // still resolves to its true authorship date. --date=unix: comparable ints.
  const out = execFileSync(
    'git', ['-C', ROOT, 'blame', '--line-porcelain', '-C', '-C', '--date=unix', '--', file],
    { maxBuffer: 64 * 1024 * 1024 },
  ).toString('utf8');
  const times = [];
  let time = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('author-time ')) time = Number(line.slice('author-time '.length));
    else if (line.startsWith('\t')) {
      times.push(time);
      time = null;
    }
  }
  return times;
}

// key -> [firstLine, lastLine] (0-based, inclusive), in file order. A long
// value is wrapped onto a deeper-indented continuation line under its key, so
// the entry spans that line too — blaming the key line alone never sees an
// edit to a wrapped value.
function entrySpans(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const spans = new Map();
  const re = /^ {2}'([a-zA-Z0-9._-]+)':/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    let end = i;
    while (end + 1 < lines.length && /^ {4}/.test(lines[end + 1])) end++;
    if (!spans.has(m[1])) spans.set(m[1], [i, end]);
  }
  return spans;
}

function newestIn(times, [start, end]) {
  let newest;
  for (let i = start; i <= end; i++) {
    const t = times[i];
    if (t !== undefined && (newest === undefined || t > newest)) newest = t;
  }
  return newest;
}

function isShallowCheckout() {
  return execFileSync('git', ['-C', ROOT, 'rev-parse', '--is-shallow-repository'])
    .toString('utf8').trim() === 'true';
}

function driftFor(locale) {
  const localeFile = path.join(ROOT, 'src/renderer/i18n/locales', `${locale}.ts`);
  if (!fs.existsSync(localeFile)) {
    console.error(`locale ${locale}: file not found`);
    process.exitCode = 2;
    return [];
  }
  const enTimes = blameTimestamps(EN);
  const localeTimes = blameTimestamps(localeFile);
  const enSpans = entrySpans(EN);
  const stale = [];
  for (const [key, span] of entrySpans(localeFile)) {
    const enSpan = enSpans.get(key);
    if (!enSpan) continue; // orphan key — the coverage test's territory
    const enAt = newestIn(enTimes, enSpan);
    const locAt = newestIn(localeTimes, span);
    if (enAt !== undefined && locAt !== undefined && enAt > locAt) stale.push(key);
  }
  return stale;
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const locales = args.filter((a) => !a.startsWith('--'));
const list = locales.length > 0 ? locales : DEFAULT_LOCALES;

let shallow = false;
try {
  shallow = isShallowCheckout();
} catch {
  // Not decisive on its own; a real git failure resurfaces per locale below.
}
if (shallow) {
  // Every line blames to the single boundary commit, so "no drift" would be
  // a false all-clear. Say so instead of printing one.
  console.log('locale-drift: skipped — shallow checkout, blame history unavailable (fetch full history to run it).');
  process.exit(0);
}

let total = 0;
for (const locale of list) {
  let stale;
  try {
    stale = driftFor(locale);
  } catch (err) {
    console.error(`locale-drift[${locale}]: skipped — ${String(err?.message ?? err).split('\n')[0]}`);
    if (!check) process.exitCode = 1;
    continue;
  }
  total += stale.length;
  if (stale.length === 0) {
    console.log(`locale-drift[${locale}]: no keys with English newer than the translation`);
    continue;
  }
  console.log(`locale-drift[${locale}]: ${stale.length} key(s) whose English changed after the translation (ADVISORY — verify meaning by hand, blame dates alone prove nothing):`);
  for (const key of stale) console.log(`  - ${key}`);
}

if (check) {
  console.log(`locale-drift: advisory complete — ${total} candidate(s). This never fails CI (#1037: the method false-positives on reformats; a human judges).`);
  // --check is advisory by contract: a missing locale file or a git error
  // above is reported, never turned into a failing exit code.
  process.exitCode = 0;
}
