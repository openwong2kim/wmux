import { describe, expect, it } from 'vitest';
import { promptFileArgument, promptFileArgumentForShell, stripPromptFileArgument } from '../promptFileArgument';

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
