#!/usr/bin/env node
// Check changelog.d/<pr>.md fragments before they reach a release.
//
//   node scripts/check-changelog-fragments.mjs              check changelog.d/
//   node scripts/check-changelog-fragments.mjs --json       machine-readable output
//   node scripts/check-changelog-fragments.mjs --dir <path> check another folder
//   node scripts/check-changelog-fragments.mjs --no-history skip the git-history PR-number check
//
// Prints `file:line: error|warning: message` and exits 1 when any error is
// found, 2 when the folder does not exist, 0 otherwise. Errors are what the fold would get wrong (lost text,
// unknown sections, duplicated notes); warnings are the style rules of
// changelog.d/README.md and what cannot be confirmed offline.
//
// Parsing is scripts/lib/changelog-fragments.mjs, the same code the release
// fold runs, so the checker and the fold never disagree about an entry.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, FRAGMENT_DIR, SECTIONS, fragmentFiles, scanFragment } from './lib/changelog-fragments.mjs';

/** Every `#<n>` mentioned in this checkout's history, or null when git cannot say. */
function referencedNumbers() {
  try {
    const log = execFileSync('git', ['log', '--format=%s%n%b'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return new Set([...log.matchAll(/#(\d+)(?!\d)/g)].map((m) => Number(m[1])));
  } catch {
    return null;
  }
}

/** One entry as a single line: wrapped text and indentation do not matter. */
const flatten = (text) => text.replace(/\s+/g, ' ').trim();

// The `(#684)` / `(#2248, refs #1950)` citation that closes an entry.
const CITATION = /\(([^()]*#\d+[^()]*)\)\.?$/;

// A Markdown code span: a run of backticks closed by a run of the same length,
// so ``a `b` c`` is one span.
const CODE_SPAN = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;

/** Lowercase everything but code spans: `PATH` and `path` are different code. */
function foldCase(text) {
  let out = '';
  let at = 0;
  for (const m of text.matchAll(CODE_SPAN)) {
    out += text.slice(at, m.index).toLowerCase() + m[0];
    at = m.index + m[0].length;
  }
  return out + text.slice(at).toLowerCase();
}

/** What two entries must share to count as the same note, PR citation aside. */
const entryKey = (flat) => foldCase(flat.replace(/^-\s*/, '').replace(CITATION, '').trim());

// A section name behind a malformed heading: `###Fixed`, ` ### Fixed`. A
// wrapped line that starts with `#1029` names no section and is not one.
const LOOSE_HEADING = new RegExp(`^\\s*#+\\s*(${SECTIONS.join('|')})\\b`, 'i');

/**
 * Check fragment files and return their problems, files in the given order and
 * top to bottom within each. `history: false` skips the git-history PR-number
 * check; a Set of numbers stands in for `git log`.
 */
export function checkFragments(files, { history = referencedNumbers() } = {}) {
  const problems = [];
  const seenEntries = new Map();
  const seenClaims = new Map();
  const report = (file, line, severity, code, message) =>
    problems.push({ file: path.relative(process.cwd(), file) || file, line, severity, code, message });

  for (const file of files) {
    const name = path.basename(file);
    const text = fs.readFileSync(file, 'utf8');
    const numbered = /^(\d+)\.md$/.exec(name);
    const pr = numbered ? Number(numbered[1]) : null;

    if (!numbered) {
      report(file, 1, 'warning', 'filename', `fragment should be named <pr-number>.md, not ${name}`);
    }
    if (!text.trim()) {
      report(file, 1, 'error', 'empty-file', 'fragment is empty');
      continue;
    }

    const { entries, headings, problems: parseProblems, stray } = scanFragment(text);

    // `##` and `####` headings: the fold has no place for them and folds them
    // into the entry above, or drops them.
    const flagged = new Set();
    for (const [i, line] of text.replace(/\r\n/g, '\n').split('\n').entries()) {
      const depth = /^(#+)\s/.exec(line)?.[1].length;
      const loose = !depth && LOOSE_HEADING.exec(line);
      if (depth && depth !== 3) {
        report(file, i + 1, 'error', 'heading-level', `only "### Section" headings are allowed, not ${'#'.repeat(depth)}`);
        flagged.add(i + 1);
      } else if (loose) {
        const name = SECTIONS.find((s) => s.toLowerCase() === loose[1].toLowerCase());
        report(file, i + 1, 'error', 'heading-format', `"${line.trim()}" is not a heading; the fold glues it to the text above. Write "### ${name}" at the start of the line`);
        flagged.add(i + 1);
      }
    }
    for (const p of parseProblems) {
      if (flagged.has(p.line)) continue;
      const code = p.message.startsWith('unknown section') ? 'unknown-section' : 'text-outside';
      const message = code === 'unknown-section' ? `${p.message} (exact case)` : p.message;
      report(file, p.line, 'error', code, message);
    }
    for (const s of stray) {
      if (flagged.has(s.line)) continue;
      report(file, s.line, 'error', 'stray-text', `text before the section's first "- " entry is dropped by the fold: ${s.text.trim().slice(0, 60)}`);
    }
    for (const [i, h] of headings.entries()) {
      if (!SECTIONS.includes(h.title)) continue;
      const end = headings[i + 1]?.line ?? Infinity;
      if (!(entries[h.title] ?? []).some((e) => e.line > h.line && e.line < end)) {
        report(file, h.line, 'error', 'empty-section', `"### ${h.title}" has no entries`);
      }
    }

    // Fold order: sections in Keep a Changelog order, file order within each,
    // so "below" and "above" mean what the release notes will show.
    const ordered = SECTIONS.flatMap((s) => entries[s] ?? []);
    const local = new Map();
    for (const [i, entry] of ordered.entries()) {
      const flat = flatten(entry.text);
      if (flat === '-') {
        report(file, entry.line, 'error', 'empty-entry', 'entry has no text');
        continue;
      }

      // A quoted "see below" is a mention of the phrase, not a reference.
      const prose = flat.replace(new RegExp(`${CODE_SPAN.source}|"[^"]*"|“[^”]*”`, 'g'), '');
      for (const m of prose.matchAll(/\bsee (below|above)\b/gi)) {
        const below = m[1].toLowerCase() === 'below';
        if (below ? i === ordered.length - 1 : i === 0) {
          report(file, entry.line, 'error', 'see-direction', `"${m[0]}" but no entry of this fragment is ${m[1].toLowerCase()} it once folded (sections print in Keep a Changelog order, and other fragments interleave), so name what it refers to`);
        }
      }

      const key = entryKey(flat);
      const where = `${path.relative(process.cwd(), file) || file}:${entry.line}`;
      const earlier = local.has(key) ? `line ${local.get(key)}` : seenEntries.get(key);
      if (earlier) {
        report(file, entry.line, 'error', 'duplicate-entry', `duplicates the entry at ${earlier}`);
      } else {
        local.set(key, entry.line);
        seenEntries.set(key, where);
      }

      // `2**31` inside a code span is not the end of the bold claim. The mask
      // keeps every offset, so the claim itself is cut from the real text.
      const bold = /^- \*\*(.+?)\*\*/.exec(flat.replace(CODE_SPAN, (code) => 'x'.repeat(code.length)));
      if (!bold) {
        report(file, entry.line, 'warning', 'bold-claim', 'entry should open with a "**Short bold claim.**"');
      } else {
        const claim = flat.slice(4, 4 + bold[1].length);
        const rest = flat.slice(bold[0].length);
        if (!/[.!?]$/.test(claim)) {
          report(file, entry.line, 'warning', 'bold-claim', 'the bold claim should end with a full stop inside the bold');
        }
        if (!rest.replace(CITATION, '').trim()) {
          report(file, entry.line, 'warning', 'no-paragraph', 'the bold claim should be followed by a paragraph saying what changed');
        }
        // A duplicated entry is already an error; its claim would only repeat it.
        const claimKey = foldCase(claim);
        if (!earlier && seenClaims.has(claimKey)) {
          report(file, entry.line, 'warning', 'duplicate-claim', `same bold claim as ${seenClaims.get(claimKey)}`);
        } else if (!earlier) {
          seenClaims.set(claimKey, where);
        }
      }

      const cited = CITATION.exec(flat);
      if (!cited) {
        report(file, entry.line, 'warning', 'pr-citation', 'entry should end with its PR number, like (#684)');
      } else if (pr !== null && ![...cited[1].matchAll(/#(\d+)(?!\d)/g)].some((m) => Number(m[1]) === pr)) {
        report(file, entry.line, 'warning', 'pr-citation', `entry cites (${cited[1]}) but the fragment is for #${pr}`);
      }

      // Quoted UI text and code may be another language; the prose may not.
      if (/[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(prose)) {
        report(file, entry.line, 'warning', 'not-english', 'repo artifacts are English; this entry has CJK text');
      }
    }

    if (pr !== null && history !== false) {
      if (history === null) {
        report(file, 1, 'warning', 'pr-unknown', `cannot confirm #${pr} offline: git log is unavailable`);
      } else if (!history.has(pr)) {
        report(file, 1, 'warning', 'pr-unknown', `#${pr} is not mentioned in local git history; an open PR's own fragment is expected here, any other number may be wrong`);
      }
    }
  }
  // Files stay in PR order; within a file, top to bottom.
  const rank = new Map(files.map((f, i) => [path.relative(process.cwd(), f) || f, i]));
  return problems.sort((a, b) => rank.get(a.file) - rank.get(b.file) || a.line - b.line);
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const dirAt = args.indexOf('--dir');
  const dir = dirAt === -1 ? FRAGMENT_DIR : path.resolve(args[dirAt + 1] ?? '');
  if (dirAt !== -1 && !args[dirAt + 1]) {
    console.error('check-changelog-fragments: --dir needs a path');
    process.exit(2);
  }

  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`check-changelog-fragments: no such folder: ${dirAt === -1 ? dir : args[dirAt + 1]}`);
    process.exit(2);
  }

  const files = fragmentFiles(dir);
  const problems = checkFragments(files, args.includes('--no-history') ? { history: false } : {});
  const errors = problems.filter((p) => p.severity === 'error').length;
  const warnings = problems.length - errors;

  if (json) {
    console.log(JSON.stringify({ files: files.length, errors, warnings, problems }, null, 2));
  } else {
    for (const p of problems) console.log(`${p.file}:${p.line}: ${p.severity}: ${p.message}`);
    console.log(`check-changelog-fragments: ${files.length} fragment(s), ${errors} error(s), ${warnings} warning(s)`);
  }
  process.exitCode = errors > 0 ? 1 : 0;
}

// Run only as a command: scripts/collect-changelog.mjs imports checkFragments.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) main();
