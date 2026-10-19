// The changelog.d fragment checker (scripts/check-changelog-fragments.mjs).
//
// Each fixture folder under fixtures/changelog-check holds one kind of
// mistake that reached, or could reach, the release notes. The checker runs as
// a real process so the exit code and the printed format are what is pinned.
// Every run passes --no-history: whether a fixture's PR number appears in git
// history depends on the clone (full, shallow, or none), so that check is off
// and assertions go by problem codes, never by which line prints first.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanFragment } from '../lib/changelog-fragments.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-changelog-fragments.mjs');
const fixture = (name) => path.join('scripts', '__tests__', 'fixtures', 'changelog-check', name);

function run(...args) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [SCRIPT, '--no-history', ...args], { cwd: ROOT, encoding: 'utf8' });
  return { status, stdout, stderr };
}

function check(name) {
  const result = run('--dir', fixture(name), '--json');
  const report = JSON.parse(result.stdout);
  const codes = (severity) => report.problems.filter((p) => p.severity === severity).map((p) => p.code);
  const lines = (code) => report.problems.filter((p) => p.code === code).map((p) => p.line);
  return { ...result, report, lines, errors: codes('error'), warnings: codes('warning') };
}

describe('scanFragment', () => {
  it('keeps the line each entry starts on and does not throw', () => {
    const scan = scanFragment('### Fixed\n\n- one\n  more\n- two\n\n### Nope\n\n- three\n');
    expect(scan.entries).toEqual({ Fixed: [{ line: 3, text: '- one\n  more' }, { line: 5, text: '- two' }] });
    expect(scan.headings).toEqual([{ line: 1, title: 'Fixed' }, { line: 7, title: 'Nope' }]);
    expect(scan.problems).toEqual([{ line: 7, message: expect.stringContaining('unknown section "Nope"') }]);
  });
});

describe('check-changelog-fragments', () => {
  it('passes a well-formed fragment', () => {
    const { status, errors, warnings } = check('good');
    expect(status).toBe(0);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('skips the git-history check with --no-history, so no clone depth can add a warning', () => {
    const { report } = check('duplicate');
    expect(report.problems.map((p) => p.code)).not.toContain('pr-unknown');
  });

  it('warns about a name that is not a PR number, without failing', () => {
    const { status, errors, warnings } = check('bad-filename');
    expect(status).toBe(0);
    expect(errors).toEqual([]);
    expect(warnings).toContain('filename');
  });

  it('fails an empty fragment', () => {
    const { status, errors } = check('empty');
    expect(status).toBe(1);
    expect(errors).toEqual(['empty-file']);
  });

  it('fails a duplicated entry within a fragment and across fragments, however it is wrapped', () => {
    const { status, report } = check('duplicate');
    expect(status).toBe(1);
    const dups = report.problems.filter((p) => p.code === 'duplicate-entry');
    expect(dups.map((p) => `${path.basename(p.file)}:${p.line}`)).toEqual(['2329.md:5', '2336.md:3']);
    expect(dups[0].message).toContain('line 3');
    expect(dups[1].message).toContain('2329.md:3');
  });

  it('fails "see below" with nothing below it, and accepts "see above" with an entry above or a quoted phrase', () => {
    expect(check('see-below')).toMatchObject({ status: 1, errors: ['see-direction'] });
    expect(check('good').errors).toEqual([]);
  });

  it('judges "see above" in fold order, where Changed prints before Fixed', () => {
    const { status, errors, lines } = check('see-fold-order');
    expect(status).toBe(1);
    expect(errors).toEqual(['see-direction']);
    expect(lines('see-direction')).toEqual([8]);
  });

  it('compares entries case-insensitively except inside code spans', () => {
    const { errors, lines } = check('code-case');
    expect(errors).toEqual(['duplicate-entry']);
    expect(lines('duplicate-entry')).toEqual([6]);
  });

  it('keys bold claims on their real text, code spans included', () => {
    const { lines } = check('claims');
    expect(lines('duplicate-claim')).toEqual([5]);
  });

  it('warns about CJK only in prose, not in quotes or code', () => {
    const { lines } = check('cjk');
    expect(lines('not-english')).toEqual([5]);
  });

  it('fails a section heading the fold would glue to the entry above', () => {
    const { status, errors, lines } = check('heading-format');
    expect(status).toBe(1);
    expect(errors).toEqual(['heading-format', 'heading-format']);
    expect(lines('heading-format')).toEqual([5, 7]);
  });

  it('exits 2 for a folder that does not exist', () => {
    const missing = fixture('no-such-folder');
    const { status, stdout, stderr } = run('--dir', missing);
    expect(status).toBe(2);
    expect(stdout).toBe('');
    expect(stderr.trim()).toBe(`check-changelog-fragments: no such folder: ${missing}`);
  });

  it('fails a section Keep a Changelog does not have', () => {
    const { status, errors } = check('wrong-section');
    expect(status).toBe(1);
    expect(errors).toEqual(['unknown-section']);
  });

  it('fails what the fold would drop or misplace', () => {
    const { report } = check('structure');
    const errors = report.problems.filter((p) => p.severity === 'error').map((p) => [p.line, p.code]);
    expect(errors).toEqual([
      [1, 'text-outside'],
      [5, 'stray-text'],
      [9, 'heading-level'],
      [11, 'empty-section'],
      [13, 'heading-level'],
    ]);
  });

  it('prints file:line: severity: message and a summary without --json', () => {
    const { status, stdout } = run('--dir', fixture('see-below'));
    expect(status).toBe(1);
    const lines = stdout.trim().split('\n');
    expect(lines.filter((l) => l.includes(': error: '))).toEqual([
      `${fixture('see-below/2329.md')}:3: error: "see below" but no entry of this fragment is below it once folded (sections print in Keep a Changelog order, and other fragments interleave), so name what it refers to`,
    ]);
    expect(lines.at(-1)).toBe('check-changelog-fragments: 1 fragment(s), 1 error(s), 0 warning(s)');
  });

  it('reports counts and problems as JSON', () => {
    const { report } = check('duplicate');
    expect(report).toMatchObject({ files: 2, errors: 2 });
    expect(report.problems.find((p) => p.code === 'duplicate-entry')).toEqual({
      file: fixture('duplicate/2329.md'),
      line: 5,
      severity: 'error',
      code: 'duplicate-entry',
      message: 'duplicates the entry at line 3',
    });
  });
});
