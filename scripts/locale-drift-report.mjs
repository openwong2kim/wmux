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
// It has false negatives too: a translated line touched later for any reason
// (reflow, re-wording) masks earlier English drift on that key, so an empty
// report is not proof that nothing drifted.
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
const IN_ACTIONS = process.env.GITHUB_ACTIONS === 'true';
// GitHub shows at most 10 warning annotations per step. Candidates get 8 so a
// parser/shallow warning still fits; the overflow is summarized as a notice.
const ANNOTATION_CAP = 8;

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

// A looser, independent count of key-like lines (any indent, either quote
// style, bare identifiers). When the strict parser above sees far fewer
// entries, the file format changed under it and "no drift" would be a false
// all-clear — so the report is declared invalid instead.
function looseKeyCount(file) {
  const src = fs.readFileSync(file, 'utf8');
  const re = /^[ \t]+(?:'[A-Za-z0-9._-]+'|"[A-Za-z0-9._-]+"|[A-Za-z_$][\w$]*)[ \t]*:/gm;
  return (src.match(re) ?? []).length;
}

function formatDrifted(file, spans) {
  const loose = looseKeyCount(file);
  if (spans.size > 0 && spans.size >= loose * 0.9) return false;
  const msg = `PARSER/FORMAT DRIFT — report invalid for ${repoPath(file)}: parsed ${spans.size} entries but the file has ${loose} key-like lines. Fix entrySpans() before trusting this report.`;
  console.log(`locale-drift: ${msg}`);
  annotate('warning', msg, { file: repoPath(file) });
  process.exitCode = 1;
  return true;
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

function repoPath(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

// GitHub Actions workflow-command escaping: the message needs %, CR and LF
// encoded; property values additionally ':' and ','.
function escapeData(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProperty(s) {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

// Annotations surface on the PR checks page; a green advisory step's log alone
// is never read. Local runs keep the plain-text report only.
function annotate(level, message, { file, line } = {}) {
  if (!IN_ACTIONS) return;
  const props = [];
  if (file) props.push(`file=${escapeProperty(file)}`);
  if (line) props.push(`line=${line}`);
  props.push('title=locale-drift');
  console.log(`::${level} ${props.join(',')}::${escapeData(message)}`);
}

function errorLine(err) {
  return String(err?.message ?? err).split('\n')[0];
}

// Returns null when the locale is skipped (the reason is already printed).
function driftFor(locale, enSpans, enTimes) {
  const localeFile = path.join(ROOT, 'src/renderer/i18n/locales', `${locale}.ts`);
  if (!fs.existsSync(localeFile)) {
    console.error(`locale ${locale}: file not found`);
    process.exitCode = 2;
    return null;
  }
  const spans = entrySpans(localeFile);
  if (formatDrifted(localeFile, spans)) return null;
  const localeTimes = blameTimestamps(localeFile);
  const stale = [];
  for (const [key, span] of spans) {
    const enSpan = enSpans.get(key);
    if (!enSpan) continue; // orphan key — the coverage test's territory
    const enAt = newestIn(enTimes, enSpan);
    const locAt = newestIn(localeTimes, span);
    if (enAt !== undefined && locAt !== undefined && enAt > locAt) stale.push({ key, line: span[0] + 1 });
  }
  return { file: repoPath(localeFile), stale };
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const locales = args.filter((a) => !a.startsWith('--'));
const list = locales.length > 0 ? locales : DEFAULT_LOCALES;

let shallow = false;
try {
  shallow = isShallowCheckout();
} catch {
  // Not decisive on its own; a real git failure resurfaces below.
}
if (shallow) {
  // Every line blames to the single boundary commit, so "no drift" would be
  // a false all-clear. Say so instead of printing one.
  const msg = 'skipped — shallow checkout, blame history unavailable (fetch full history to run it).';
  console.log(`locale-drift: ${msg}`);
  annotate('warning', msg);
  process.exit(0);
}

let enSpans;
let enTimes;
try {
  enSpans = entrySpans(EN);
  if (formatDrifted(EN, enSpans)) process.exit(check ? 0 : 1);
  enTimes = blameTimestamps(EN);
} catch (err) {
  console.error(`locale-drift: skipped — ${errorLine(err)}`);
  process.exit(check ? 0 : 1);
}

let total = 0;
let annotated = 0;
for (const locale of list) {
  let result;
  try {
    result = driftFor(locale, enSpans, enTimes);
  } catch (err) {
    console.error(`locale-drift[${locale}]: skipped — ${errorLine(err)}`);
    if (!check) process.exitCode = 1;
    continue;
  }
  if (!result) continue;
  const { file, stale } = result;
  total += stale.length;
  if (stale.length === 0) {
    console.log(`locale-drift[${locale}]: no keys with English newer than the translation`);
    continue;
  }
  console.log(`locale-drift[${locale}]: ${stale.length} key(s) whose English changed after the translation (ADVISORY — verify meaning by hand, blame dates alone prove nothing):`);
  for (const { key, line } of stale) {
    console.log(`  - ${key}`);
    if (annotated < ANNOTATION_CAP) {
      annotated++;
      annotate('warning', `${locale} ${key}: English changed after this translation — verify the meaning by hand`, { file, line });
    }
  }
}

if (total > annotated) {
  annotate('notice', `${total - annotated} more drift candidate(s) not annotated — see the "Locale drift advisory" step log for the full list.`);
}

if (check) {
  console.log(`locale-drift: advisory complete — ${total} candidate(s). This never fails CI (#1037: the method false-positives on reformats; a human judges).`);
  // --check is advisory by contract: a missing locale file or a git error
  // above is reported, never turned into a failing exit code.
  process.exitCode = 0;
}
