import { describe, expect, it } from 'vitest';
import { dubiousOwnership, dubiousOwnershipMessage } from '../dubiousOwnership';

// What Git for Windows prints for a repository inside WSL (#2231).
const WSL_STDERR = [
  "fatal: detected dubious ownership in repository at '//wsl.localhost/Ubuntu/home/dev/e2e-wsl-repo'",
  "'//wsl.localhost/Ubuntu/home/dev/e2e-wsl-repo' is owned by:",
  '\t(inconvertible) (S-1-5-21-1-2-3-1000)',
  'but the current user is:',
  '\tBOX\\owner (S-1-5-21-4-5-6-1001)',
  'To add an exception for this directory, call:',
  '',
  "\tgit config --global --add safe.directory '%(prefix)///wsl.localhost/Ubuntu/home/dev/e2e-wsl-repo'",
  '',
].join('\n');

describe('dubiousOwnership', () => {
  it('takes the exact command git printed', () => {
    expect(dubiousOwnership(WSL_STDERR, '\\\\wsl.localhost\\Ubuntu\\home\\dev\\e2e-wsl-repo')).toEqual({
      command: "git config --global --add safe.directory '%(prefix)///wsl.localhost/Ubuntu/home/dev/e2e-wsl-repo'",
    });
  });

  it('a localized headline still carries the command', () => {
    const ko = "fatal: 저장소 소유권이 의심스럽습니다\n\n\tgit config --global --add safe.directory /home/dev/r\n";
    expect(dubiousOwnership(ko, '/home/dev/r')).toEqual({ command: 'git config --global --add safe.directory /home/dev/r' });
  });

  it('builds the command from the path when git printed none', () => {
    expect(dubiousOwnership('git config --list failed: fatal: detected dubious ownership in repository at', 'D:\\w\\t-1'))
      .toEqual({ command: "git config --global --add safe.directory 'D:/w/t-1'" });
  });

  it('any other failure is not this', () => {
    expect(dubiousOwnership('fatal: not a git repository (or any of the parent directories): .git', '/x')).toBeNull();
    expect(dubiousOwnership('', '/x')).toBeNull();
  });

  it('the message names the folder and the command, and says wmux does not add it', () => {
    const m = dubiousOwnershipMessage('\\\\wsl.localhost\\Ubuntu\\home\\dev\\r', "git config --global --add safe.directory '/x'");
    expect(m).toContain('\\\\wsl.localhost\\Ubuntu\\home\\dev\\r');
    expect(m).toContain('`git config --global --add safe.directory "/x"`');
    expect(m).toMatch(/wmux does not add this exception itself/);
    expect(m).not.toContain('/*');
    const all = dubiousOwnershipMessage('C:\\Users\\me\\.wmux\\worktrees\\h\\t', "git config --global --add safe.directory 'C:/x'", 'C:\\Users\\me\\.wmux\\worktrees\\');
    expect(all).toContain('`git config --global --add safe.directory "C:/Users/me/.wmux/worktrees/*"`');
    // An apostrophe in the home folder: double quotes.
    expect(dubiousOwnershipMessage('x', 'c', "C:\\Users\\O'Brien\\.wmux\\worktrees")).toContain('`git config --global --add safe.directory "C:/Users/O\'Brien/.wmux/worktrees/*"`');
  });
});

describe('a safe.directory command for any shell', () => {
  it('double quotes a plain path, so Command Prompt stores it right too', async () => {
    const { pasteable } = await import('../dubiousOwnership');
    expect(pasteable("git config --global --add safe.directory 'C:/Users/me/.wmux/worktrees/h/t 1'"))
      .toBe('`git config --global --add safe.directory "C:/Users/me/.wmux/worktrees/h/t 1"`');
    // git's own %(prefix)/ form would be expanded by cmd: shown as git printed it, for PowerShell or Git Bash.
    expect(pasteable("git config --global --add safe.directory '%(prefix)///wsl.localhost/Ubuntu/home/dev/r'"))
      .toBe("`git config --global --add safe.directory '%(prefix)///wsl.localhost/Ubuntu/home/dev/r'` (in PowerShell or Git Bash)");
    // Unquoted (git on Linux or macOS): as printed.
    expect(pasteable('git config --global --add safe.directory /home/dev/r')).toBe('`git config --global --add safe.directory /home/dev/r`');
  });
});
