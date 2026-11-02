import { describe, expect, it } from 'vitest';
import { claudeProjectFolder } from '../claudeProjectFolder';

describe('claudeProjectFolder', () => {
  it('names a folder the way Claude Code does on macOS (pairs seen on disk, user name replaced)', () => {
    expect(claudeProjectFolder('/Users/someone/coding/31.wmux')).toBe('-Users-someone-coding-31-wmux');
    expect(claudeProjectFolder('/Users/someone/coding/31.wmux-worktrees/review-pr-2578')).toBe('-Users-someone-coding-31-wmux-worktrees-review-pr-2578');
    expect(claudeProjectFolder('/private/tmp/claude-502/-Users-someone')).toBe('-private-tmp-claude-502--Users-someone');
  });

  it('keeps a Windows drive letter as written, and turns each non-ASCII code unit into one dash', () => {
    expect(claudeProjectFolder('C:\\Users\\me\\repo')).toBe('C--Users-me-repo');
    expect(claudeProjectFolder('c:\\Users\\me\\repo')).toBe('c--Users-me-repo');
    expect(claudeProjectFolder('/Users/김/repo')).toBe('-Users---repo');
    // An emoji is two UTF-16 code units.
    expect(claudeProjectFolder('/tmp/a😀b')).toBe('-tmp-a--b');
  });

  it('cuts a name over 200 characters and adds the hash of the whole path (vectors from 2.1.312\'s own function)', () => {
    const long = `/Users/me/${'deeply-nested-folder/'.repeat(12)}repo`;
    expect(claudeProjectFolder(long)).toBe(
      '-Users-me-deeply-nested-folder-deeply-nested-folder-deeply-nested-folder-deeply-nested-folder-deeply-nested-folder'
      + '-deeply-nested-folder-deeply-nested-folder-deeply-nested-folder-deeply-nested-folder-d-ly9okt',
    );
    const win = `C:\\Users\\me\\${'segment_'.repeat(30)}repo`;
    expect(claudeProjectFolder(win)).toBe(`C--Users-me-${'segment-'.repeat(23)}segm-uu9a1n`);
  });
});
