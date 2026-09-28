import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// #1619: on Windows an npm-installed Codex CLI is `codex.cmd`, which the daemon
// used to spawn with execFile. Node never tries PATHEXT, so the probe hit
// ENOENT, the phone agent list silently dropped codex, and the Codex runtime
// start always failed. These drive the real modules against a real .cmd shim.
describe.runIf(process.platform === 'win32')('npm .cmd shims on Windows (#1619)', () => {
  let dir: string;
  let codexHome: string;
  const savedPath = process.env.PATH;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-shim-'));
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-codexhome-'));
    // Stand-in for %APPDATA%\npm\codex.cmd: the real CLI is node behind a shim.
    const script = path.join(dir, 'fake-codex.js');
    fs.writeFileSync(script, [
      "const a = process.argv.slice(2).join(' ');",
      "if (a === '--help') console.log('Codex CLI\\n  -m, --model <MODEL>\\n  -c, --config <key=value>');",
      "else if (a.startsWith('app-server daemon ')) console.log('daemon ' + a.split(' ')[2] + ' ok');",
      'else process.exit(2);',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    // Only the shim dir and System32: no real claude or codex can answer.
    const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    process.env.PATH = `${dir};${system32}`;
  });
  afterAll(() => {
    process.env.PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  it('the phone agent list reports codex installed through an npm .cmd shim', async () => {
    vi.resetModules(); // the help probe is cached for five minutes per module
    const { installedAgentLaunchOptions } = await import('../agentLaunch');
    const agents = (await installedAgentLaunchOptions({ ...process.env, CODEX_HOME: codexHome })).map((o) => o.agent);
    expect(agents).toContain('codex');
    expect(agents).not.toContain('claude'); // not on this PATH: the probe is not a rubber stamp
  });

  it('`codex app-server daemon <sub>` runs through the shim', async () => {
    const { runCodexDaemon } = await import('../../transcript/codexSharedRuntime');
    await expect(runCodexDaemon('version', { ...process.env, CODEX_HOME: codexHome })).resolves.toContain('daemon version ok');
  });

  it('the native Codex runtime start succeeds through the shim', async () => {
    const { startNativeCodexRuntime } = await import('../../transcript/terminalLaunch');
    await expect(startNativeCodexRuntime({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CODEX_HOME: codexHome }))
      .resolves.toBeUndefined();
  });
});
