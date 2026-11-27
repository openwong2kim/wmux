// #3514 — a WSL-form repository path given to the GUI fan-out on Windows.
import { describe, expect, it, vi } from 'vitest';
import { guiRepoPath } from '../fanout.handler';

describe('guiRepoPath', () => {
  it('maps /mnt/<drive>/… to the Windows folder on win32 when it exists', () => {
    const isDir = vi.fn((p: string) => (p === 'D:\\src\\project' ? 'directory' : 'missing'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(guiRepoPath('/mnt/d/src/project/', 'win32', isDir)).toEqual({ repoPath: 'D:\\src\\project' });
    expect(guiRepoPath('/mnt/D', 'win32', () => 'directory')).toEqual({ repoPath: 'D:\\' });
  });

  it('refuses with the reason when the mapped folder does not exist', () => {
    expect(guiRepoPath('/mnt/d/missing', 'win32', () => 'missing')).toEqual({ error: expect.stringContaining('D:\\missing does not exist') });
    expect(guiRepoPath('/mnt/d/file', 'win32', () => 'not-directory')).toEqual({ error: expect.stringContaining('D:\\file is not a folder') });
    // A folder that cannot be read is not called missing.
    expect(guiRepoPath('/mnt/d/locked', 'win32', () => 'EACCES')).toEqual({ error: expect.stringContaining('D:\\locked could not be read (EACCES)') });
  });

  it('keeps every other path, and every path off Windows', () => {
    const isDir = vi.fn(() => 'directory');
    expect(guiRepoPath('D:\\src\\project', 'win32', isDir)).toEqual({ repoPath: 'D:\\src\\project' });
    expect(guiRepoPath('/home/me/x', 'win32', isDir)).toEqual({ repoPath: '/home/me/x' });
    expect(guiRepoPath('/mnt/d/src', 'darwin', isDir)).toEqual({ repoPath: '/mnt/d/src' });
    expect(isDir).not.toHaveBeenCalled();
  });
});
