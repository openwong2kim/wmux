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

describe('launch-line validation parses quotes', () => {
  const S = '/d/factory/worker-settings/aaaaaaaaaaaa.json';
  const M = '/d/factory/worker-mcp/bbbbbbbbbbbb.json';
  const cmdArg = '"Read your task from this file and follow it: C:/w/prompt.md"';
  const posixArg = `"$(cat '/w/.wtask/prompt.md')"`;
  const winArg = promptFileArgument('C:\\w\\prompt.md', 'win32');

  it('only a whole standalone word in exactly the generated form is wmux\'s own', () => {
    expect(stripPromptFileArgument(`claude ${cmdArg}`)).toBe('claude ');
    expect(stripPromptFileArgument(`claude ${posixArg} --x`)).toBe('claude  --x');
    expect(stripPromptFileArgument(`claude ${winArg}`)).toBe('claude ');
    // Inside another word (a quoted string that merely contains the form), nothing goes.
    for (const inside of [
      `claude ' "Read your task from this file and follow it: C:/'; printf PWN; echo ' " '`,
      `claude ' ${posixArg} '`,
      `claude "x ${cmdArg.slice(1, -1)}"`,
      `claude a${cmdArg}`,
      `claude ${cmdArg}b`,
      `claude \\${cmdArg}`,
    ]) expect(stripPromptFileArgument(inside), inside).toBe(inside);
  });

  it('the guards refuse a line that hides commands around or inside the argument', async () => {
    const { spliceWorkerLaunch } = await import('../botWorkerMcp');
    const { spliceSettingsFlag } = await import('../botWorkerGuard');
    for (const line of [
      `claude ' "Read your task from this file and follow it: C:/'; printf PWN; echo ' " '`,
      `claude '${cmdArg}'; printf PWN`,
      `claude "'"${cmdArg}"'"; printf PWN`,
      `claude ' "$(cat '"'"'/x'"'"')" '; printf PWN`,
      `claude ${cmdArg}; printf PWN`,
      `claude ${cmdArg} && printf PWN`,
      `claude ${cmdArg} | printf PWN`,
      `claude ${cmdArg} $(printf PWN)`,
      `claude ${posixArg}; printf PWN`,
      `claude ${posixArg} && printf PWN`,
      `claude ${posixArg} | tee x`,
      `claude ${winArg}; calc`,
    ]) {
      expect(spliceWorkerLaunch(line, S, M), line).toBeNull();
      expect(spliceSettingsFlag(line, S), line).toBeNull();
    }
    // The generated forms alone still pass.
    for (const ok of [`claude ${cmdArg}`, `claude ${posixArg}`, `claude --dangerously-skip-permissions ${winArg}`]) {
      expect(spliceWorkerLaunch(ok, S, M), ok).not.toBeNull();
    }
  });
});

describe('launchLineForShell', () => {
  const winLine = `claude ${promptFileArgument('C:\\w\\prompt.md', 'win32')}`;
  it('a WSL or cmd pane on Windows gets its own form; PowerShell and other platforms keep the line', async () => {
    const { launchLineForShell } = await import('../promptFileArgument');
    expect(launchLineForShell(winLine, 'C:\\Windows\\System32\\wsl.exe', 'win32')).toBe(`claude "$(cat '/mnt/c/w/prompt.md')"`);
    expect(launchLineForShell(winLine, 'cmd.exe', 'win32')).toBe('claude "Read your task from this file and follow it: C:/w/prompt.md"');
    expect(launchLineForShell(winLine, 'powershell.exe', 'win32')).toBe(winLine);
    expect(launchLineForShell(winLine, undefined, 'win32')).toBe(winLine);
    expect(launchLineForShell(winLine, 'wsl.exe', 'darwin')).toBe(winLine);
  });
});

describe('a Command Prompt launch line', () => {
  const arg = '"Read your task from this file and follow it: C:/p/prompt.md"';
  it('passes as wmux builds it, and with any cmd metacharacter outside the argument is refused', async () => {
    const { isPlainCmdLaunchLine } = await import('../botWorkerGuard');
    expect(isPlainCmdLaunchLine(`claude --settings="C:\\Users\\me\\.wmux\\factory\\worker-settings\\a.json" --mcp-config="C:\\x\\b.json" --strict-mcp-config ${arg}`)).toBe(true);
    expect(isPlainCmdLaunchLine(`claude --allowedTools "mcp__wmux__ledger_update,mcp__wmux__task_push" ${arg}`)).toBe(true);
    for (const line of [
      `claude 'x & calc & rem ' ${arg}`,
      `claude ${arg} & calc`,
      `claude ${arg} && calc`,
      `claude ${arg} | calc`,
      `claude ^& calc ${arg}`,
      `claude "%COMSPEC%" ${arg}`,
      `claude "!X!" ${arg}`,
      `claude ${arg} > out.txt`,
      `claude ${arg}\r\ncalc`,
      `claude "x & calc" ${arg}`,
      // A prompt path cmd cannot be handed (UNC, `%`, `!`) keeps the PowerShell shape.
      `claude ${promptFileArgument('\\\\srv\\share\\prompt.md', 'win32')}`,
      `claude ${promptFileArgument('/mnt/c/p/prompt.md', 'linux')}`,
    ]) expect(isPlainCmdLaunchLine(line), line).toBe(false);
  });
});
