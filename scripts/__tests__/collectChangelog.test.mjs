// Fragment folding (scripts/lib/changelog-fragments.mjs).
//
// The point of fragments is that a release loses nothing: whatever a PR wrote
// in changelog.d/ has to come out the other side of the fold, in a stable
// order, next to entries already sitting under [Unreleased]. These pin that —
// a fold that silently drops a section would be discovered at release time,
// with the fragments already deleted.
import { describe, expect, it } from 'vitest';
import { parseFragment, collect, applyToChangelog, fragmentFiles } from '../lib/changelog-fragments.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('parseFragment', () => {
  it('keeps a multi-line entry as one entry', () => {
    const parsed = parseFragment(`### Added

- **A thing.** First line of the paragraph,
  and its continuation, indented.

- **Another.** Short.
`);
    expect(parsed.Added).toHaveLength(2);
    expect(parsed.Added[0]).toContain('and its continuation');
    expect(parsed.Added[1]).toBe('- **Another.** Short.');
  });

  it('splits by section and accepts them in any order', () => {
    const parsed = parseFragment('### Fixed\n\n- one\n\n### Added\n\n- two\n');
    expect(parsed).toEqual({ Fixed: ['- one'], Added: ['- two'] });
  });

  it('refuses an unknown section rather than dropping it', () => {
    expect(() => parseFragment('### Improvements\n\n- one\n', 'f.md')).toThrow(/unknown section/);
  });

  it('refuses prose that belongs to no section', () => {
    expect(() => parseFragment('just a note\n\n### Added\n\n- one\n', 'f.md')).toThrow(/outside any/);
  });
});

describe('collect', () => {
  it('orders fragments by PR number, not by string', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frag-'));
    fs.writeFileSync(path.join(dir, '9.md'), '### Added\n\n- nine\n');
    fs.writeFileSync(path.join(dir, '100.md'), '### Added\n\n- hundred\n');
    fs.writeFileSync(path.join(dir, 'README.md'), '# not an entry\n');
    // "100" sorts before "9" as a string — the numeric sort is the point.
    expect(collect(fragmentFiles(dir)).Added).toEqual(['- nine', '- hundred']);
  });
});

describe('applyToChangelog', () => {
  const base = `# Changelog

## [Unreleased]

### Changed

- an entry written straight into the file

## [3.37.2] — 2026-07-28

### Fixed

- something old
`;

  it('appends fragment entries after the ones already there', () => {
    const out = applyToChangelog(base, { Changed: ['- from a fragment'] });
    const unreleased = out.slice(out.indexOf('## [Unreleased]'), out.indexOf('## [3.37.2]'));
    expect(unreleased).toContain('- an entry written straight into the file');
    expect(unreleased.indexOf('straight into the file')).toBeLessThan(
      unreleased.indexOf('from a fragment'),
    );
  });

  it('creates a section that did not exist yet, in Keep a Changelog order', () => {
    const out = applyToChangelog(base, { Added: ['- new'], Fixed: ['- repaired'] });
    const unreleased = out.slice(out.indexOf('## [Unreleased]'), out.indexOf('## [3.37.2]'));
    expect(unreleased.indexOf('### Added')).toBeLessThan(unreleased.indexOf('### Changed'));
    expect(unreleased.indexOf('### Changed')).toBeLessThan(unreleased.indexOf('### Fixed'));
  });

  it('leaves every released section untouched', () => {
    const out = applyToChangelog(base, { Added: ['- new'] });
    expect(out.startsWith('# Changelog\n\n## [Unreleased]\n')).toBe(true);
    expect(out).toContain('## [3.37.2] — 2026-07-28');
    expect(out).toContain('- something old');
  });

  // A release renames [Unreleased] to the version; the next fold must not fail.
  it('creates [Unreleased] below the title when a release removed it', () => {
    const out = applyToChangelog('# Changelog\n\n## [1.0.0]\n\n- old\n', { Added: ['- new'] });
    expect(out).toBe('# Changelog\n\n## [Unreleased]\n\n### Added\n\n- new\n\n## [1.0.0]\n\n- old\n');
  });

  it('creates [Unreleased] at the very top when there is no title', () => {
    const out = applyToChangelog('## [4.1.0] — 2026-10-08\n\n### Added\n\n- shipped\n', {});
    expect(out.startsWith('## [Unreleased]\n\n## [4.1.0] — 2026-10-08\n')).toBe(true);
    expect(out.match(/## \[Unreleased\]/g)).toHaveLength(1);
  });

  it('creates [Unreleased] in a changelog with no release yet', () => {
    expect(applyToChangelog('', { Fixed: ['- one'] })).toBe('## [Unreleased]\n\n### Fixed\n\n- one\n\n');
  });

  it('keeps a CRLF changelog CRLF, including fragment entries', () => {
    const crlf = base.replace(/\n/g, '\r\n');
    const fragment = parseFragment('### Added\r\n\r\n- **New.** First line,\r\n  second line.\r\n');
    const out = applyToChangelog(crlf, fragment);
    expect(out).not.toMatch(/[^\r]\n/);
    expect(out).not.toMatch(/\r\r/);
    expect(out).toContain('## [Unreleased]\r\n\r\n### Added\r\n\r\n- **New.** First line,\r\n  second line.');
    expect(out).toContain('- an entry written straight into the file');
  });

  it('restores [Unreleased] in a CRLF changelog that lost it', () => {
    const out = applyToChangelog('## [4.1.0] — 2026-10-08\r\n\r\n- shipped\r\n', {});
    expect(out.startsWith('## [Unreleased]\r\n\r\n## [4.1.0]')).toBe(true);
    expect(out).not.toMatch(/[^\r]\n/);
  });
});
