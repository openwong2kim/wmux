// #3514 — a WSL-form repository path given to the GUI fan-out on Windows.
import { describe, expect, it, vi } from 'vitest';
import { guiRepoPath } from '../fanout.handler';

describe('guiRepoPath', () => {
  it('maps /mnt/<drive>/… to the Windows folder on win32 when it exists', () => {
    const isDir = vi.fn((p: string) => p === 'D:\\src\\project');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(guiRepoPath('/mnt/d/src/project/', 'win32', isDir)).toEqual({ repoPath: 'D:\\src\\project' });
    expect(guiRepoPath('/mnt/D', 'win32', () => true)).toEqual({ repoPath: 'D:\\' });
  });

  it('refuses with the reason when the mapped folder does not exist', () => {
    const res = guiRepoPath('/mnt/d/missing', 'win32', () => false);
    expect(res).toEqual({ error: expect.stringContaining('D:\\missing does not exist') });
  });

  it('keeps every other path, and every path off Windows', () => {
    const isDir = vi.fn(() => true);
    expect(guiRepoPath('D:\\src\\project', 'win32', isDir)).toEqual({ repoPath: 'D:\\src\\project' });
    expect(guiRepoPath('/home/me/x', 'win32', isDir)).toEqual({ repoPath: '/home/me/x' });
    expect(guiRepoPath('/mnt/d/src', 'darwin', isDir)).toEqual({ repoPath: '/mnt/d/src' });
    expect(isDir).not.toHaveBeenCalled();
  });
});
