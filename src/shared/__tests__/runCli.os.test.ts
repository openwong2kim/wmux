import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../runCli';

const isWin = process.platform === 'win32';

// #1619. An npm-installed CLI on Windows is a .cmd shim. Node's execFile cannot
// find it (no PATHEXT walk) and would refuse to spawn it without a shell anyway,
// so the daemon reported codex as not installed. These run real shims.
describe.runIf(isWin)('runCli on Windows — real .cmd shims', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  const shim = (name: string, body: string) =>
    fs.writeFileSync(path.join(dir, `${name}.cmd`), `@echo off\r\n${body}\r\n`);

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-runcli-'));
    // Like an npm shim: the real CLI is node, and what matters is the argv it
    // receives, so print that exactly (cmd's own echo would show the quoting).
    // `--` stops node from reading flags like `-c` as its own options; a real
    // npm shim runs `node <script> %*`, where that cannot happen.
    shim('wmuxfake', `"${process.execPath}" -e "console.log('FAKE '+JSON.stringify(process.argv.slice(1)))" -- %*`);
    shim('wmuxfail', 'exit /b 3');
    shim('wmuxloud', 'for /l %%i in (1,1,400) do @echo 0123456789012345678901234567890123456789');
    // The real CLI behind an npm shim is node.exe running a script, a
    // grandchild of the cmd.exe that cross-spawn starts.
    shim('wmuxhang', `"${process.execPath}" -e "setTimeout(()=>{},60000)" wmux-runcli-hang-marker`);
    env = { ...process.env, PATH: `${dir};${process.env.PATH ?? ''}` };
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('control: execFile, the old path, cannot find a .cmd shim by bare name', async () => {
    const error = await new Promise<{ code?: unknown } | null>((resolve) =>
      execFile('wmuxfake', ['--help'], { env, windowsHide: true }, (e) => resolve(e)));
    expect(error?.code).toBe('ENOENT');
  });

  it('finds the .cmd shim through PATH and PATHEXT and returns its stdout', async () => {
    await expect(runCli('wmuxfake', ['app-server', 'daemon', 'start'], { env, timeoutMs: 10_000, maxBuffer: 64_000 }))
      .resolves.toContain('FAKE ["app-server","daemon","start"]');
  });

  it('delivers flag-style tokens to the CLI verbatim', async () => {
    const args = ['--model', 'claude-sonnet-5', '-c', 'model_reasoning_effort=high', 'a/b@c+d:e'];
    const out = await runCli('wmuxfake', args, { env, timeoutMs: 10_000, maxBuffer: 64_000 });
    expect(out.trim()).toBe(`FAKE ${JSON.stringify(args)}`);
  });

  it('accepts an absolute command path, including a directory with a space', async () => {
    const spaced = path.join(dir, 'with space');
    fs.mkdirSync(spaced, { recursive: true });
    fs.copyFileSync(path.join(dir, 'wmuxfake.cmd'), path.join(spaced, 'wmuxfake.cmd'));
    const out = await runCli(path.join(spaced, 'wmuxfake.cmd'), ['--help'], { env, timeoutMs: 10_000, maxBuffer: 64_000 });
    expect(out.trim()).toBe('FAKE ["--help"]');
  });

  it.each(['C:\\a&b\\codex.cmd', 'C:\\100%PATH%\\codex.cmd', '..\\codex.cmd', '\\\\server\\share\\codex.cmd'])(
    'refuses the command %j',
    async (command) => {
      await expect(runCli(command, ['--help'], { env, timeoutMs: 10_000, maxBuffer: 64_000 }))
        .rejects.toThrow('not safe through a Windows .cmd shim');
    },
  );

  // Why the helper refuses these instead of escaping them: through a global npm
  // shim, cross-spawn's escaping is single, the shim's `%*` parses a second
  // time, and `car^et` arrives as `caret` (observed while writing this test).
  it.each(['a&echo INJECTED', '100%PATH%', 'x|y', '(z)', 'q"uote', 'car^et', 'two words', '', 'line\nbreak'])(
    'refuses %j without spawning anything',
    async (token) => {
      await expect(runCli('wmuxfake', ['--help', token], { env, timeoutMs: 10_000, maxBuffer: 64_000 }))
        .rejects.toThrow('not safe through a Windows .cmd shim');
    },
  );

  it('rejects on a non-zero exit, carrying the exit code', async () => {
    await expect(runCli('wmuxfail', [], { env, timeoutMs: 10_000, maxBuffer: 64_000 }))
      .rejects.toMatchObject({ code: 3 });
  });

  it('rejects when the CLI is not installed', async () => {
    await expect(runCli('wmux-definitely-not-installed', [], { env, timeoutMs: 10_000, maxBuffer: 64_000 }))
      .rejects.toBeTruthy();
  });

  it('rejects output past maxBuffer', async () => {
    await expect(runCli('wmuxloud', [], { env, timeoutMs: 10_000, maxBuffer: 1024 }))
      .rejects.toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
  });

  it('on timeout kills the whole tree, including the node process behind the shim', async () => {
    await expect(runCli('wmuxhang', [], { env, timeoutMs: 1500, maxBuffer: 64_000 }))
      .rejects.toMatchObject({ code: 'ETIMEDOUT' });
    const survivors = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "@(Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*wmux-runcli-hang-marker*' -and $_.Name -eq 'node.exe' }).Count"],
    { encoding: 'utf8', windowsHide: true }).trim();
    expect(survivors).toBe('0');
  }, 20_000);
});

// POSIX must be untouched by #1619: same execFile call, same options.
describe('runCli on POSIX — unchanged execFile path', () => {
  const realPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });

  it('calls execFile with the bare name, args, env, timeout, maxBuffer and windowsHide', async () => {
    const execFileMock = vi.fn((...args: unknown[]) => {
      (args.at(-1) as (e: Error | null, out: string) => void)(null, 'ok');
    });
    vi.doMock('node:child_process', () => ({ execFile: execFileMock }));
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const { runCli: fresh } = await import('../runCli');
    const env = { PATH: '/usr/bin' };
    await expect(fresh('codex', ['--help'], { env, timeoutMs: 3000, maxBuffer: 128 })).resolves.toBe('ok');
    expect(execFileMock).toHaveBeenCalledWith('codex', ['--help'],
      { env, timeout: 3000, maxBuffer: 128, windowsHide: true }, expect.any(Function));
  });
});
