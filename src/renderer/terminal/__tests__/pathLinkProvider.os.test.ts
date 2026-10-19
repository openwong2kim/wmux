/**
 * Tests for `findPathMatches` and `createPathLinkProvider`.
 *
 * The matcher is the source of truth for which characters in a terminal
 * line are "a clickable path". It must:
 *   • detect absolute Windows / UNC / POSIX paths
 *   • strip trailing punctuation + source-location suffixes (`:42`, `:42:10`)
 *   • ignore relative paths, time strings, URL path components
 *   • be stable across repeated calls (no regex state bleed)
 *
 * The thin xterm wrapper (`createPathLinkProvider`) just maps matches into
 * ILink ranges, so we only test the matcher heavily and smoke-test the
 * provider for coordinate translation + range correctness.
 */
import { describe, it, expect, vi } from 'vitest';
import { findPathMatches, createPathLinkProvider } from '../pathLinkProvider';

describe('findPathMatches', () => {
  describe('Windows drive paths', () => {
    it('matches a bare drive path', () => {
      const matches = findPathMatches('C:\\Users\\rizz\\file.txt', 'win32');
      expect(matches).toHaveLength(1);
      expect(matches[0].text).toBe('C:\\Users\\rizz\\file.txt');
    });

    it('matches a forward-slash drive path', () => {
      const matches = findPathMatches('see c:/foo/bar.log for details', 'win32');
      expect(matches).toHaveLength(1);
      expect(matches[0].text).toBe('c:/foo/bar.log');
    });

    it('strips trailing period', () => {
      const matches = findPathMatches('Open C:\\Users\\rizz\\file.txt.', 'win32');
      expect(matches[0].text).toBe('C:\\Users\\rizz\\file.txt');
    });

    it('strips trailing comma + period combo', () => {
      const matches = findPathMatches('open C:\\foo\\bar.ts,.', 'win32');
      expect(matches[0].text).toBe('C:\\foo\\bar.ts');
    });

    it('strips source-location suffix `:42`', () => {
      const matches = findPathMatches('Error at D:\\wmux\\src\\index.ts:42', 'win32');
      expect(matches[0].text).toBe('D:\\wmux\\src\\index.ts');
    });

    it('strips source-location suffix `:42:10`', () => {
      const matches = findPathMatches('Error at D:\\wmux\\src\\index.ts:42:10', 'win32');
      expect(matches[0].text).toBe('D:\\wmux\\src\\index.ts');
    });

    it('handles wrapped (parens) source location', () => {
      const matches = findPathMatches('(see D:\\wmux\\src\\foo.ts:42)', 'win32');
      expect(matches[0].text).toBe('D:\\wmux\\src\\foo.ts');
    });

    it('strips multi-segment numeric trailer (semver-shaped, e.g. :1.2.3)', () => {
      // SOURCE_LOCATION_SUFFIX peels one `:NNN` at a time. The fixed-point
      // loop in trimPunctuation must keep iterating until nothing changes,
      // otherwise a path with a semver-shaped trailer keeps a stray `:N`
      // at the end and openPath rejects it.
      const matches = findPathMatches('release D:\\dist\\app.json:1.2.3', 'win32');
      expect(matches[0].text).toBe('D:\\dist\\app.json');
    });
  });

  describe('Windows UNC paths', () => {
    it('matches a basic UNC share', () => {
      const matches = findPathMatches('check \\\\server\\share\\file.txt', 'win32');
      expect(matches).toHaveLength(1);
      expect(matches[0].text).toBe('\\\\server\\share\\file.txt');
    });

    it('matches a hyphenated server name', () => {
      const matches = findPathMatches('\\\\file-srv-01\\share', 'win32');
      expect(matches).toHaveLength(1);
      expect(matches[0].text).toBe('\\\\file-srv-01\\share');
    });
  });

  describe('POSIX paths', () => {
    it('matches a basic absolute path', () => {
      const matches = findPathMatches('see /etc/hosts for the entry', 'linux');
      expect(matches).toHaveLength(1);
      expect(matches[0].text).toBe('/etc/hosts');
    });

    it('matches a home-dir-style path', () => {
      const matches = findPathMatches('open /home/rizz/.config/wmux/config.json', 'linux');
      expect(matches[0].text).toBe('/home/rizz/.config/wmux/config.json');
    });

    it('strips trailing period in prose', () => {
      const matches = findPathMatches('look at /var/log/syslog.', 'linux');
      expect(matches[0].text).toBe('/var/log/syslog');
    });

    it('does not match the path component of an http URL', () => {
      // POSIX rule requires a word boundary before `/`. http://host/path
      // has no whitespace before the second slash, so we expect zero hits.
      const matches = findPathMatches('see http://example.com/some/path here', 'linux');
      expect(matches).toHaveLength(0);
    });

    it('does not match plain time strings', () => {
      const matches = findPathMatches('meeting at 12:34 today', 'linux');
      expect(matches).toHaveLength(0);
    });

    it('does not match a bare slash', () => {
      const matches = findPathMatches('a / b', 'linux');
      expect(matches).toHaveLength(0);
    });
  });

  describe('multiple matches', () => {
    it('returns matches in order', () => {
      const matches = findPathMatches(
        'cp /etc/hosts /tmp/hosts.bak',
        'linux',
      );
      expect(matches.map((m) => m.text)).toEqual(['/etc/hosts', '/tmp/hosts.bak']);
      expect(matches[0].start).toBeLessThan(matches[1].start);
    });

    it('mixes Windows + POSIX paths on win32 host', () => {
      const matches = findPathMatches(
        'src D:\\foo\\a.ts dst /tmp/x',
        'win32',
      );
      expect(matches.map((m) => m.text)).toEqual(['D:\\foo\\a.ts', '/tmp/x']);
    });

    it('handles two UNC paths on the same line (dedupe stays ordered)', () => {
      const matches = findPathMatches(
        '\\\\srv-a\\share\\one \\\\srv-b\\share\\two',
        'win32',
      );
      expect(matches.map((m) => m.text)).toEqual([
        '\\\\srv-a\\share\\one',
        '\\\\srv-b\\share\\two',
      ]);
    });

    it('does not match the path component of a file:// URI', () => {
      // POSIX matcher's lookbehind requires whitespace / quote / paren /
      // angle before the `/`. The `:` in `file:` falls outside that set,
      // so we expect zero hits — the URI is left for WebLinksAddon to
      // handle if it recognises file://.
      const matches = findPathMatches('see file:///etc/hosts please', 'linux');
      expect(matches).toHaveLength(0);
    });
  });

  describe('regex state stability', () => {
    // Module-scoped regex instances retain `lastIndex`. The implementation
    // must reset it; otherwise the second call could miss matches near
    // the start of the line.
    it('returns identical results on repeated calls with the same input', () => {
      const input = 'cp /etc/hosts /tmp/x';
      const first = findPathMatches(input, 'linux');
      const second = findPathMatches(input, 'linux');
      expect(second).toEqual(first);
    });

    it('finds match at offset 0 after a prior longer call', () => {
      findPathMatches('xxxxxxxxxxxxxxxxxxxx /etc/hosts xxxxxxxxxxxx', 'linux');
      const matches = findPathMatches('/etc/hosts', 'linux');
      expect(matches).toHaveLength(1);
      expect(matches[0].start).toBe(0);
    });
  });

  describe('range correctness', () => {
    it('reports start/end aligned with the cleaned path', () => {
      const input = 'open /etc/hosts.';
      const matches = findPathMatches(input, 'linux');
      expect(matches[0].start).toBe(5);
      expect(matches[0].end).toBe(15); // /etc/hosts (10 chars), 5..15
      expect(input.slice(matches[0].start, matches[0].end)).toBe('/etc/hosts');
    });
  });

  describe('edge cases', () => {
    it('returns empty for empty input', () => {
      expect(findPathMatches('', 'linux')).toEqual([]);
    });

    it('returns empty for a single drive letter (no slash)', () => {
      expect(findPathMatches('C:', 'win32')).toEqual([]);
    });

    it('does not match a relative path', () => {
      expect(findPathMatches('foo/bar.txt', 'linux')).toEqual([]);
      expect(findPathMatches('./foo/bar.txt', 'linux')).toEqual([]);
    });
  });
});

describe('createPathLinkProvider', () => {
  /**
   * Minimal xterm Terminal stub. The provider only touches
   * `buffer.active.getLine(n).translateToString(true)` and
   * `getLine(n).isWrapped`, so a stub is faster + clearer than mocking
   * the full xterm interface.
   */
  function makeTerminal(lines: { text: string; wrapped?: boolean }[]) {
    return {
      buffer: {
        active: {
          getLine: (i: number) => {
            const l = lines[i];
            if (!l) return undefined;
            return {
              translateToString: () => l.text,
              isWrapped: !!l.wrapped,
            };
          },
        },
      },
    } as unknown as import('@xterm/xterm').Terminal;
  }

  it('emits one link per match with 1-based xterm coordinates', () => {
    const terminal = makeTerminal([{ text: 'open /etc/hosts here' }]);
    const openPath = vi.fn();
    const provider = createPathLinkProvider(terminal, openPath, 'linux');
    const cb = vi.fn();
    provider.provideLinks(1, cb);

    expect(cb).toHaveBeenCalledTimes(1);
    const links = cb.mock.calls[0][0];
    expect(links).toHaveLength(1);
    // /etc/hosts starts at offset 5 (0-based) → xterm x=6 (1-based).
    expect(links[0].range.start).toEqual({ x: 6, y: 1 });
    // end is inclusive; /etc/hosts is 10 chars long ending at offset 15
    // (exclusive) → inclusive last cell = 15.
    expect(links[0].range.end).toEqual({ x: 15, y: 1 });
    expect(links[0].text).toBe('/etc/hosts');
  });

  it('skips wrapped continuation lines so paths do not double-match', () => {
    const terminal = makeTerminal([
      { text: '/etc/hosts continuation row body', wrapped: true },
    ]);
    const provider = createPathLinkProvider(terminal, vi.fn(), 'linux');
    const cb = vi.fn();
    provider.provideLinks(1, cb);
    expect(cb).toHaveBeenCalledWith(undefined);
  });

  it('passes undefined when the line is empty', () => {
    const terminal = makeTerminal([{ text: '' }]);
    const provider = createPathLinkProvider(terminal, vi.fn(), 'linux');
    const cb = vi.fn();
    provider.provideLinks(1, cb);
    expect(cb).toHaveBeenCalledWith(undefined);
  });

  it('passes undefined when getLine returns nothing (line past the buffer)', () => {
    const terminal = makeTerminal([]);
    const provider = createPathLinkProvider(terminal, vi.fn(), 'linux');
    const cb = vi.fn();
    provider.provideLinks(999, cb);
    expect(cb).toHaveBeenCalledWith(undefined);
  });

  it('activate() forwards the cleaned path to openPath', () => {
    const terminal = makeTerminal([{ text: 'see /var/log/syslog.' }]);
    const openPath = vi.fn();
    const provider = createPathLinkProvider(terminal, openPath, 'linux');
    const cb = vi.fn();
    provider.provideLinks(1, cb);
    const link = cb.mock.calls[0][0][0];
    // MouseEvent is a DOM type; vitest's default node env doesn't provide
    // it. The provider's `activate` ignores the event arg, so an empty
    // object is fine for the test.
    link.activate({} as unknown as MouseEvent, link.text);
    expect(openPath).toHaveBeenCalledWith('/var/log/syslog');
  });
});
