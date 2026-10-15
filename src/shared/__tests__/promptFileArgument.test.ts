import { describe, expect, it } from 'vitest';
import { cmdPromptFileArgument, isCmdShellPath, promptFileArgument, promptFileArgumentForShell, stripPromptFileArgument } from '../promptFileArgument';

describe('promptFileArgumentForShell', () => {
  const winPath = 'C:\\Users\\me\\.wmux-e2e\\worktrees\\t-1\\.wmux\\prompt.md';
  const winLine = `claude --model opus ${promptFileArgument(winPath, 'win32')}`;

  it('a WSL pane gets the POSIX argument on the /mnt path of the same file', () => {
    expect(promptFileArgumentForShell(winLine, { wsl: true }))
      .toBe(`claude --model opus "$(cat '/mnt/c/Users/me/.wmux-e2e/worktrees/t-1/.wmux/prompt.md')"`);
  });

  it('a PowerShell or cmd pane keeps the line it was built with', () => {
    expect(promptFileArgumentForShell(winLine, { wsl: false })).toBe(winLine);
  });

  it('keeps a quote in the path quoted for bash', () => {
    const quoted = "D:\\it's here\\prompt.md";
    const out = promptFileArgumentForShell(`claude ${promptFileArgument(quoted, 'win32')}`, { wsl: true });
    expect(out).toBe(`claude ${promptFileArgument("/mnt/d/it's here/prompt.md", 'linux')}`);
    expect(out).toBe(`claude "$(cat '/mnt/d/it'\\''s here/prompt.md')"`);
  });

  it('leaves a path WSL cannot mount (a UNC share) alone', () => {
    const unc = `claude ${promptFileArgument('\\\\server\\share\\prompt.md', 'win32')}`;
    expect(promptFileArgumentForShell(unc, { wsl: true })).toBe(unc);
  });

  it('touches only the exact argument wmux builds', () => {
    const lookalike = `claude "$(Get-Content -Raw -LiteralPath 'C:\\x')"`;
    expect(promptFileArgumentForShell(lookalike, { wsl: true })).toBe(lookalike);
    expect(promptFileArgumentForShell('claude', { wsl: true })).toBe('claude');
  });

  it('the rewritten line is still recognised as wmux\'s own prompt argument', () => {
    expect(stripPromptFileArgument(promptFileArgumentForShell(winLine, { wsl: true })).trim()).toBe('claude --model opus');
  });
});

describe('the cmd.exe prompt argument (#2231)', () => {
  const winPath = 'C:\\Users\\me\\.wmux\\worktrees\\.meta\\t-1\\prompt.md';
  const winLine = `claude --model opus ${promptFileArgument(winPath, 'win32')}`;

  it('a cmd pane names the prompt file instead of a $(…) cmd never runs', () => {
    expect(promptFileArgumentForShell(winLine, { wsl: false, cmd: true }))
      .toBe('claude --model opus "Read your task from this file and follow it: C:/Users/me/.wmux/worktrees/.meta/t-1/prompt.md"');
  });

  it('the special characters stay in the file: a path cmd or another shell could expand keeps the old line', () => {
    for (const bad of ['C:\\a\u201db\\prompt.md', 'C:\\a\nb\\prompt.md', 'C:\\100%\\prompt.md', 'C:\\a"b\\prompt.md', 'C:\\wow!\\prompt.md', 'C:\\$(calc)\\prompt.md', 'C:\\a`b\\prompt.md', '\\\\server\\share\\prompt.md']) {
      expect(cmdPromptFileArgument(bad), bad).toBeNull();
      const line = `claude ${promptFileArgument(bad, 'win32')}`;
      expect(promptFileArgumentForShell(line, { wsl: false, cmd: true })).toBe(line);
    }
  });

  it('the guards read it as wmux\'s own argument, and only that exact shape', () => {
    const cmdLine = promptFileArgumentForShell(winLine, { wsl: false, cmd: true });
    expect(stripPromptFileArgument(cmdLine).trim()).toBe('claude --model opus');
    // Anything a shell could expand is not that shape.
    for (const forged of [
      'claude "Read your task from this file and follow it: C:/$(calc)"',
      'claude "Read your task from this file and follow it: C:/`calc`"',
      'claude "Read your task from this file and follow it: C:/%PATH%"',
      'claude "Read your task from this file and follow it: /etc/x"',
      // PowerShell ends a double-quoted string on a typographic quote too.
      'claude "Read your task from this file and follow it: C:/\u201d; Write-Output PWN; #"',
      'claude "Read your task from this file and follow it: C:/\u201c; calc"',
    ]) expect(stripPromptFileArgument(forged), forged).toBe(forged);
  });

  it('knows a cmd shell by its path', () => {
    for (const s of ['cmd', 'cmd.exe', 'C:\\Windows\\System32\\cmd.exe', 'C:/Windows/System32/CMD.EXE']) expect(isCmdShellPath(s), s).toBe(true);
    for (const s of ['powershell.exe', 'pwsh', 'C:\\tools\\mycmd.exe', 'wsl.exe', undefined]) expect(isCmdShellPath(s), String(s)).toBe(false);
  });
});
