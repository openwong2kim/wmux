// @wmux-lane unit
// Pure path arithmetic: the Windows cases pass path.win32 explicitly, so the
// result is the same on every host.
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { homeRelative } from '../homeRelative';

describe('homeRelative', () => {
  it('spells a path under home as ~/…', () => {
    expect(homeRelative('/home/alice/.wmux/mcp/shim.js', '/home/alice', path.posix)).toBe('~/.wmux/mcp/shim.js');
    expect(homeRelative('/home/alice', '/home/alice', path.posix)).toBe('~');
  });

  it('leaves a path outside home, or a sibling sharing the prefix, as it is', () => {
    expect(homeRelative('/opt/x.js', '/home/alice', path.posix)).toBe('/opt/x.js');
    expect(homeRelative('/home/alice2/x.js', '/home/alice', path.posix)).toBe('/home/alice2/x.js');
  });

  it('matches a Windows home whatever the letter case', () => {
    expect(homeRelative('C:\\users\\Alice\\.wmux\\mcp\\wmux-native.exe', 'c:\\Users\\alice', path.win32))
      .toBe('~/.wmux/mcp/wmux-native.exe');
  });

  it('never turns a root home into ~', () => {
    expect(homeRelative('/opt/x.js', '/', path.posix)).toBe('/opt/x.js');
    expect(homeRelative('C:\\tools\\x.js', 'C:\\', path.win32)).toBe('C:\\tools\\x.js');
    expect(homeRelative('/x.js', '', path.posix)).toBe('/x.js');
  });
});
