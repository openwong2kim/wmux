import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPlainCmdLaunchLine, isQuotable } from '../botWorkerGuard';
import { spliceWorkerLaunch } from '../botWorkerMcp';
import { cmdLaunchPathRefusal, cmdPromptFileArgument, dataDirNoShellRefusal, isCmdShellPath, promptFileArgument, promptFileArgumentForShell, stripPromptFileArgument } from '../promptFileArgument';

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

  it('#2256: a path cmd cannot carry is refused by its own cause and remedy, not as a merge-lane guard failure', () => {
    const prompt = (flaw: string) => `Command Prompt cannot pass the prompt file (its path ${flaw}); set Default shell to PowerShell (Settings › Terminal) or move the wmux data folder`;
    const dataDir = (flaw: string) => `Command Prompt cannot pass the wmux data folder (its path ${flaw}); set Default shell to PowerShell (Settings › Terminal) or move the folder`;
    const stuck = (flaw: string) => `Command Prompt cannot pass the wmux data folder (its path ${flaw}), and no other shell can either; move the folder`;
    const line = (p: string) => `claude --model opus ${promptFileArgument(p, 'win32')}`;
    const okDir = 'C:\\Users\\me\\.wmux';
    // No shell passes the guard's files from this folder, so PowerShell is not offered.
    expect(cmdLaunchPathRefusal(line('C:\\Users\\me\\.wmux-wE9!\\worktrees\\.meta\\t-1\\prompt.md'), 'C:\\Users\\me\\.wmux-wE9!', true)).toBe(stuck('contains "!"'));
    // Without the guard's files (not a claude line), PowerShell does pass that prompt file.
    expect(cmdLaunchPathRefusal(line('C:\\Users\\me\\.wmux-wE9!\\worktrees\\.meta\\t-1\\prompt.md'), 'C:\\Users\\me\\.wmux-wE9!', false)).toBe(prompt('contains "!"'));
    expect(cmdLaunchPathRefusal(line('C:\\100%\\prompt.md'), okDir, true)).toBe(prompt('contains "%"'));
    expect(cmdLaunchPathRefusal(line('\\\\server\\share\\prompt.md'), okDir, true)).toBe(prompt('is a UNC path'));
    expect(cmdLaunchPathRefusal(line('C:\\a\nb\\prompt.md'), okDir, true)).toBe(prompt('has a control character'));
    // A clean prompt path (an output folder elsewhere) under a data folder the guard's files cannot ride cmd from.
    expect(cmdLaunchPathRefusal(line('D:\\out\\prompt.md'), 'C:\\Users\\me\\.wmux-wE9!', true)).toBe(stuck('contains "!"'));
    expect(cmdLaunchPathRefusal(line('D:\\out\\prompt.md'), "C:\\it's", true)).toBe(stuck('contains "\'"'));
    expect(cmdLaunchPathRefusal(line('D:\\out\\prompt.md'), 'C:\\Users\\Tom&Jerry', true)).toBe(dataDir('contains "&"'));
    expect(cmdLaunchPathRefusal(line('D:\\out\\prompt.md'), '\\\\server\\share\\.wmux', true)).toBe(stuck('is a UNC path'));
    // PowerShell's typographic quotes are plain characters to cmd.
    expect(cmdLaunchPathRefusal(line('D:\\out\\prompt.md'), 'C:\\Users\\\u201cme\u201d', true)).toBeNull();
    // Only a claude line carries the guard's files.
    expect(cmdLaunchPathRefusal(line('D:\\out\\prompt.md'), 'C:\\Users\\me\\.wmux-wE9!', false)).toBeNull();
    // Clean paths, or no prompt argument at all, pass.
    expect(cmdLaunchPathRefusal(winLine, okDir, true)).toBeNull();
    expect(cmdLaunchPathRefusal('claude --model opus', okDir, true)).toBeNull();
  });

  it('#2256: every data folder the guarded cmd line would refuse is named by its cause first', () => {
    const chars = [...Array.from({ length: 0x80 }, (_, c) => String.fromCharCode(c)), '\u2018', '\u2019', '\u201a', '\u201b', '\u201c', '\u201d', '\u201e', '\u201f'];
    for (const c of chars) {
      const dir = `C:\\Users\\a${c}b`;
      const file = (kind: string) => path.win32.join(dir, 'factory', kind, '0123456789ab.json');
      // As pty:create builds it: the merge-lane guard's splice, then the cmd check.
      const spliced = spliceWorkerLaunch('claude', file('worker-settings'), file('worker-mcp'));
      const refused = spliced === null || !isPlainCmdLaunchLine(spliced);
      const named = cmdLaunchPathRefusal('claude', dir, true) !== null;
      const code = c.charCodeAt(0);
      // A control character is refused either way (no Windows folder name holds one).
      if (code < 0x20 || code === 0x7f) expect(named, `U+${code.toString(16)}`).toBe(true);
      else expect(named, `${c} (U+${code.toString(16)})`).toBe(refused);
    }
  });

  it('#2268: a data folder no shell can pass gets #2256\'s sentence in every shell, on Windows and POSIX paths alike', () => {
    const stuck = (flaw: string) => `Command Prompt cannot pass the wmux data folder (its path ${flaw}), and no other shell can either; move the folder`;
    // The same words a Command Prompt pane gets.
    expect(dataDirNoShellRefusal('C:\\Users\\me\\.wmux-wE9!')).toBe(cmdLaunchPathRefusal('claude', 'C:\\Users\\me\\.wmux-wE9!', true));
    expect(dataDirNoShellRefusal('C:\\Users\\me\\.wmux-wE9!')).toBe(stuck('contains "!"'));
    expect(dataDirNoShellRefusal('\\\\server\\share\\.wmux')).toBe(cmdLaunchPathRefusal('claude', '\\\\server\\share\\.wmux', true));
    expect(dataDirNoShellRefusal('/home/a$b/.wmux')).toBe(stuck('contains "$"'));
    expect(dataDirNoShellRefusal('C:\\a\\\\b')).toBe(stuck('has a run of backslashes'));
    for (const ok of ['C:\\Users\\me\\.wmux', '/home/me/.wmux', 'C:\\Users\\Tom&Jerry', 'C:\\Users\\\u201cme\u201d']) expect(dataDirNoShellRefusal(ok), ok).toBeNull();
    // Exactly what the guard cannot quote: a folder it can quote is never refused for this cause.
    const chars = [...Array.from({ length: 0x80 }, (_, c) => String.fromCharCode(c)), '\u2018', '\u201c'];
    for (const c of chars) {
      for (const dir of [`C:\\Users\\a${c}b`, `/home/a${c}b`]) expect(dataDirNoShellRefusal(dir) === null, JSON.stringify(dir)).toBe(isQuotable(dir));
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
