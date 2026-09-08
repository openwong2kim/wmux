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

function keysInOrder(file) {
  const src = fs.readFileSync(file, 'utf8');
  const keys = [];
  const re = /^ {2}'([a-zA-Z0-9._-]+)':/gm;
  let m;
  while ((m = re.exec(src))) keys.push(m[1]);
  return keys;
}

function lineOfKey(file, key) {
  const src = fs.readFileSync(file, 'utf8');
  const re = new RegExp(`^ {2}'${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':`, 'm');
  const idx = src.search(re);
  if (idx === -1) return -1;
  return src.slice(0, idx).split('\n').length;
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
  const localeKeys = keysInOrder(localeFile);
  const stale = [];
  for (const key of localeKeys) {
    const line = lineOfKey(localeFile, key);
    if (line < 1) continue;
    const enLine = lineOfKey(EN, key);
    if (enLine < 1) continue; // orphan key — the coverage test's territory
    const enAt = enTimes[enLine - 1];
    const locAt = localeTimes[line - 1];
    if (enAt !== undefined && locAt !== undefined && enAt > locAt) stale.push(key);
  }
  return stale;
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const locales = args.filter((a) => !a.startsWith('--'));
const list = locales.length > 0 ? locales : DEFAULT_LOCALES;

let total = 0;
for (const locale of list) {
  const stale = driftFor(locale);
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
}
