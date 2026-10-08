/**
 * Folding changelog.d/<pr>.md fragments into CHANGELOG.md.
 *
 * Fragments exist so that two PRs never insert at the same line of one file —
 * see changelog.d/README.md. These functions are the other half: at release
 * time the fragments are merged back into the one file readers actually read.
 *
 * Ordering is by PR number, so the result is stable no matter what order the
 * files landed in — the same inputs always produce the same CHANGELOG.
 *
 * The CLI lives in scripts/collect-changelog.mjs. It carries the shebang; this
 * file does not, so tests can import it (the same split the license scripts
 * use — a shebang is not valid JS to every parser that reads a module).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `..` twice: this file sits in scripts/lib, the repo root is two levels up.
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FRAGMENT_DIR = path.join(ROOT, 'changelog.d');
export const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

// Keep a Changelog's section order. A fragment may use any subset; anything
// else is a typo we refuse rather than silently drop.
const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

/** Fragment files, oldest PR first. README.md is documentation, not an entry. */
export function fragmentFiles(dir = FRAGMENT_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort((a, b) => {
      const na = Number.parseInt(a, 10);
      const nb = Number.parseInt(b, 10);
      // Non-numeric names sort last, by name — they are still valid entries.
      if (Number.isNaN(na) && Number.isNaN(nb)) return a.localeCompare(b);
      if (Number.isNaN(na)) return 1;
      if (Number.isNaN(nb)) return -1;
      return na - nb;
    })
    .map((f) => path.join(dir, f));
}

/**
 * Split one fragment into `{ Added: [entry, …], … }`.
 *
 * An entry is everything between one `- ` bullet and the next, so a multi-line
 * paragraph survives intact. Text before any `###` heading is an error: it
 * would otherwise vanish into no section at all.
 */
export function parseFragment(text, name = '<fragment>') {
  const out = {};
  let section = null;
  let buffer = [];

  const flush = () => {
    if (!section || buffer.length === 0) return;
    const entry = buffer.join('\n').replace(/\s+$/, '');
    if (entry) (out[section] ??= []).push(entry);
    buffer = [];
  };

  // A fragment checked out with CRLF must not carry \r into its entries.
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      const title = heading[1];
      if (!SECTIONS.includes(title)) {
        throw new Error(
          `${name}: unknown section "${title}" — expected one of ${SECTIONS.join(', ')}`,
        );
      }
      section = title;
      continue;
    }
    if (/^-\s/.test(line)) {
      flush();
      buffer.push(line);
      continue;
    }
    if (buffer.length > 0) {
      buffer.push(line);
      continue;
    }
    if (line.trim() && !section) {
      throw new Error(`${name}: text outside any "### Section" heading: ${line.trim().slice(0, 60)}`);
    }
  }
  flush();
  return out;
}

/** Merge every fragment into one `{ section: [entry, …] }`, in file order. */
export function collect(files) {
  const merged = {};
  for (const file of files) {
    const parsed = parseFragment(fs.readFileSync(file, 'utf8'), path.basename(file));
    for (const [section, entries] of Object.entries(parsed)) {
      (merged[section] ??= []).push(...entries);
    }
  }
  return merged;
}

/**
 * Insert the collected entries into CHANGELOG.md under `## [Unreleased]`.
 *
 * Entries already written directly under `[Unreleased]` are kept and the new
 * ones are appended after them — the fragment flow can be adopted without
 * having to move what is already there.
 *
 * A release renames `[Unreleased]` to the version, so the heading can be
 * missing on the next fold. It is then created above the first `## ` heading
 * (below any title) instead of failing the release.
 *
 * Line endings follow the input: a CRLF checkout comes back CRLF throughout.
 */
export function applyToChangelog(input, merged) {
  const crlf = input.includes('\r\n');
  const folded = foldUnreleased(ensureUnreleased(input.replace(/\r\n/g, '\n')), merged);
  return crlf ? folded.replace(/\n/g, '\r\n') : folded;
}

/** Add an empty `## [Unreleased]` above the first `## ` heading when absent (LF input). */
export function ensureUnreleased(changelog) {
  if (changelog.includes('## [Unreleased]')) return changelog;
  const first = /^## /m.exec(changelog);
  if (first) {
    return `${changelog.slice(0, first.index)}## [Unreleased]\n\n${changelog.slice(first.index)}`;
  }
  const head = changelog.replace(/\n+$/, '');
  return head ? `${head}\n\n## [Unreleased]\n` : '## [Unreleased]\n';
}

function foldUnreleased(changelog, merged) {
  const start = changelog.indexOf('## [Unreleased]');
  const after = changelog.indexOf('\n## ', start + 1);
  const end = after === -1 ? changelog.length : after + 1;

  const body = changelog.slice(start, end);
  // Anything above [Unreleased] (a title, an intro) stays where it was.
  const preamble = changelog.slice(0, start);
  const rest = changelog.slice(end);

  // Existing entries per section inside [Unreleased], so nothing is lost.
  const existing = {};
  let current = null;
  for (const line of body.split('\n')) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1];
      existing[current] ??= [];
      continue;
    }
    if (current) (existing[current] ??= []).push(line);
  }

  const sections = SECTIONS.filter((s) => existing[s]?.some((l) => l.trim()) || merged[s]?.length);
  const parts = [`## [Unreleased]`, ''];
  for (const section of sections) {
    parts.push(`### ${section}`, '');
    const kept = (existing[section] ?? []).join('\n').trim();
    if (kept) parts.push(kept, '');
    for (const entry of merged[section] ?? []) parts.push(entry, '');
  }
  return `${preamble}${parts.join('\n').replace(/\n+$/, '')}\n\n${rest.replace(/^\n+/, '')}`;
}
