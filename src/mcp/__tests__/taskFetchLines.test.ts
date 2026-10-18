// task_fetch's text: which fetch line a worker runs in which shell.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../wmux-client', () => ({ sendRpc: vi.fn() }));

import { taskFetchLines } from '../taskPush';

const WIN = 'git fetch --no-tags --no-write-fetch-head "C:\\relay\\t" "+refs/heads/main:refs/remotes/origin/main"';
const WSL = "git.exe fetch --no-tags --no-write-fetch-head 'C:\\relay\\t' '+refs/heads/main:refs/remotes/origin/main'";
const LINUX = "git fetch --no-tags --no-write-fetch-head '/mnt/c/relay/t' '+refs/heads/main:refs/remotes/origin/main'";

describe('taskFetchLines', () => {
  it('a Windows-host repository: both lines, labelled per shell', () => {
    const text = taskFetchLines({ fetchCommand: WIN, fetchCommandWsl: WSL, fetchCommandShell: 'win32' });
    expect(text).toContain(`Windows shell:\n${WIN}\nWSL shell:\n${WSL}\n`);
  });

  it('a Windows-host repository with no WSL line: the line is labelled for the Windows shell, never offered to WSL', () => {
    const text = taskFetchLines({ fetchCommand: WIN, fetchCommandShell: 'win32' });
    expect(text).toContain(`Windows shell:\n${WIN}\nno WSL line could be built; run it from a Windows shell\n`);
    expect(text).not.toContain('WSL shell:');
  });

  it('a repository inside a WSL distro, or a non-Windows host: one unlabelled line', () => {
    for (const r of [
      { fetchCommand: LINUX, fetchCommandWsl: LINUX, fetchCommandShell: 'linux' },
      { fetchCommand: LINUX, fetchCommandShell: 'darwin' },
    ]) {
      const text = taskFetchLines(r);
      expect(text).toBe(`Run this in your shell, then \`git merge origin/<default>\`:\n${LINUX}\n\n`);
    }
  });

  it('a failed fetch: no line', () => {
    expect(taskFetchLines({})).toBe('');
    expect(taskFetchLines(undefined)).toBe('');
  });
});
