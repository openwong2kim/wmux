import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import {
  buildShimCmd,
  buildPathEditScript,
  buildSettingChangeScript,
  deriveShimPaths,
  explainPathEditExit,
  PATH_EDIT_EXIT,
  shimIsCurrent,
} from '../cliShim';
import { buildSync } from 'esbuild';
import * as pty from 'node-pty';
import { codexHandoffLines } from '../../cli/commands/codex';
import { REMOVE_TEMP_DIR_HOOK_TIMEOUT_MS, removeTempDir } from '../../test-utils/removeTempDir';

describe('buildShimCmd', () => {
  it('discovers app-* dynamically, scopes ELECTRON_RUN_AS_NODE, and forwards args + exit code', () => {
    const cmd = buildShimCmd();
    expect(cmd).toContain('setlocal DisableDelayedExpansion');
    expect(cmd).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    // Dynamic discovery: uses %~dp0 relative resolution, not hardcoded version
    expect(cmd).toContain('dir /b /ad /o-d');
    expect(cmd).toContain('%~dp0');
    expect(cmd).toContain('app-*');
    // Forwards args and exit code
    expect(cmd).toContain('%*');
    expect(cmd).toContain('endlocal & exit /b %ERRORLEVEL%');
    // CRLF line endings — cmd.exe is picky about bare LF in some contexts
    expect(cmd.includes('\r\n')).toBe(true);
    // No delayed expansion — a literal `!` in a path must survive
    expect(cmd).not.toContain('enabledelayedexpansion');
    // Full invocation: direct exec (no `call` — it re-expands %/^ in args),
    // exact quoting, and %* forwarding
    expect(cmd).toContain(
      '  "%~dp0..\\%%i\\wmux.exe" "%~dp0..\\%%i\\resources\\cli-bundle\\index.js" %*',
    );
    expect(cmd).not.toContain('call "');
    // No hardcoded version path
    expect(cmd).not.toMatch(/app-\d+(?:\.\d+)+[\\/]/);
  });

  // #2612: wmux.exe has no console to hand a TUI, so the script starts Codex.
  it('starts Codex from its own console with the user\'s %* and releases the lease after', () => {
    const lines = buildShimCmd().split('\r\n');
    const at = (line: string) => lines.indexOf(line);
    expect(at('if /i "%~1"=="codex" goto :wmux_codex')).toBeGreaterThan(-1);
    const handoff = at('for /f "delims=" %%l in (\'^""%WMUX_APP%\\wmux.exe" "%WMUX_APP%\\resources\\cli-bundle\\index.js" codex --wmux-handoff^"\') do set "%%l"');
    const launch = at('set "WMUX_CODEX_EXE=" & set "WMUX_CODEX_LAUNCH=" & set "WMUX_CODEX_CD=" & set "WMUX_CODEX_CDARG=" & set "WMUX_CODEX_LEASE=" & set "WMUX_APP=" & "%CODEX_HOME%\\%WMUX_CODEX_EXE%" %WMUX_CODEX_LAUNCH% %WMUX_CODEX_CDARG% --remote-auth-token-env %*');
    const release = at('"%WMUX_APP%\\wmux.exe" "%WMUX_APP%\\resources\\cli-bundle\\index.js" codex --wmux-release %WMUX_CODEX_LEASE%');
    expect(handoff).toBeGreaterThan(-1);
    expect(launch).toBeGreaterThan(handoff);
    expect(release).toBeGreaterThan(launch);
    // No launch without a lease; Codex never sees ELECTRON_RUN_AS_NODE, and
    // nothing after Codex sees the bearer.
    expect(at('if not defined WMUX_CODEX_LEASE exit /b 1')).toBeGreaterThan(handoff);
    expect(at('if not defined WMUX_CODEX_LEASE exit /b 1')).toBeLessThan(launch);
    // CODEX_HOME is settled before the handoff reads it, and no path comes back through its pipe.
    expect(at('if defined CODEX_HOME for %%h in ("%CODEX_HOME%") do set "CODEX_HOME=%%~fh"')).toBeLessThan(handoff);
    expect(at('set "CODEX_HOME=%WMUX_CODEX_HOME%"')).toBe(-1);
    expect(at('set "ELECTRON_RUN_AS_NODE="')).toBeLessThan(launch);
    // The launch details live in a nested setlocal that ends only after Codex.
    expect(at('setlocal')).toBeLessThan(launch);
    expect(at('endlocal & set "WMUX_CODEX_EXIT=%WMUX_CODEX_EXIT%"')).toBeGreaterThan(launch);
    expect(at('set "codex="')).toBeGreaterThan(launch);
    expect(at('set "codex="')).toBeLessThan(release);
    expect(lines[lines.length - 2]).toBe('endlocal & exit /b %WMUX_CODEX_EXIT%');
  });
});

// The live blocks below run stand-in executables (copies or hard links of
// node.exe) from their temp root, and remove it through removeTempDir: on the
// GitHub Windows runner provjobd.exe, outside the test's own process tree,
// keeps a just-run image open for 1-14 s, and the helper waits that out.

// Runs the generated script under a root whose path holds a space, `&` and
// parentheses, with Node standing in for wmux.exe and Codex. The handoff's
// lines are the real CLI's (codexHandoffLines); the stand-in only puts the
// script for Node in front of Codex's arguments. CODEX_HOME and the working
// directory hold Korean names, the case a Korean user name produces.
describe.skipIf(process.platform !== 'win32')('wmux.cmd codex launch (live cmd.exe)', () => {
  let root = '';
  let log = '';
  let home = '';
  let exe = '';
  let work = '';
  const lease = '11111111-2222-3333-4444-555555555555';
  type Run = { status: number | null; events: Record<string, unknown>[] };
  /** One `wmux ...` in a cmd of its own (windowsHide: its own hidden console, so chcp changes nothing else). */
  const run = (tail: string, opts: { cwd?: string; chcp?: number; env?: Record<string, string | undefined>; cd?: boolean } = {}): Run => {
    nodeFs.writeFileSync(log, '');
    const cwd = opts.cwd ?? root;
    nodeFs.writeFileSync(nodePath.join(root, 'handoff.txt'), `${codexHandoffLines({
      executable: exe, codeHome: home, url: 'ws://127.0.0.1:1', authToken: 'b'.repeat(64), leaseId: lease,
      ...(opts.cd === false ? {} : { cd: cwd }),
    }).join('\n')}\n`);
    const shim = nodePath.join(root, 'bin', 'wmux.cmd');
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of Object.keys(env)) if (/^(codex_home|userprofile)$/i.test(key)) delete env[key];
    Object.assign(env, { codex: 'outer', WMUX_LOG: log, CODEX_HOME: home, USERPROFILE: nodePath.dirname(home) }, opts.env);
    const chcp = opts.chcp === undefined ? '' : `chcp ${opts.chcp} >nul & `;
    const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${chcp}"${shim}" ${tail}"`], {
      windowsVerbatimArguments: true, windowsHide: true, encoding: 'utf8', cwd, env,
    });
    const events = nodeFs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    return { status: r.status, events };
  };
  beforeAll(() => {
    root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'wmux shim (a&b) '));
    log = nodePath.join(root, 'log.jsonl');
    home = nodePath.join(root, '홍길동', '.codex');
    work = nodePath.join(root, '작업 폴더');
    nodeFs.mkdirSync(work);
    const app = nodePath.join(root, 'app-1.0.0');
    nodeFs.mkdirSync(nodePath.join(app, 'resources', 'cli-bundle'), { recursive: true });
    nodeFs.mkdirSync(nodePath.join(root, 'bin'));
    nodeFs.writeFileSync(nodePath.join(root, 'bin', 'wmux.cmd'), buildShimCmd());
    const node = (to: string) => {
      try { nodeFs.linkSync(process.execPath, to); } catch { nodeFs.copyFileSync(process.execPath, to); }
    };
    node(nodePath.join(app, 'wmux.exe'));
    // Codex's managed binary, where the real handoff names it.
    exe = nodePath.join(home, 'packages', 'app-server-daemon', 'releases', '0.0.0-test', 'bin', 'codex.exe');
    nodeFs.mkdirSync(nodePath.dirname(exe), { recursive: true });
    node(exe);
    const codex = nodePath.join(root, 'codex.js');
    nodeFs.writeFileSync(codex, [
      "const fs=require('fs');",
      "fs.appendFileSync(process.env.WMUX_LOG,JSON.stringify({codex:process.argv.slice(2),exe:process.execPath,cwd:process.cwd(),bearer:process.env.codex,home:process.env.CODEX_HOME,node:process.env.ELECTRON_RUN_AS_NODE??null,launch:Object.keys(process.env).filter((k)=>/^WMUX_(CODEX_|APP$)/i.test(k))})+'\\n');",
      'process.exitCode=7;',
    ].join('\n'));
    nodeFs.writeFileSync(nodePath.join(app, 'resources', 'cli-bundle', 'index.js'), [
      "const fs=require('fs'),path=require('path');",
      "fs.appendFileSync(process.env.WMUX_LOG,JSON.stringify({cli:process.argv.slice(2),args:process.env.WMUX_CODEX_ARGS??null,bearer:process.env.codex??null,home:process.env.CODEX_HOME??null})+'\\n');",
      "if(process.argv[3]==='--wmux-handoff'&&process.env.WMUX_TEST_HANDOFF_FAIL){process.stderr.write('no lease');process.exit(1);}",
      "if(process.argv[3]==='--wmux-handoff')process.stdout.write(fs.readFileSync(path.join(__dirname,'..','..','..','handoff.txt'),'utf8')",
      `  .replace('WMUX_CODEX_LAUNCH=','WMUX_CODEX_LAUNCH='+${JSON.stringify(JSON.stringify(codex))}+' '));`,
    ].join('\n'));
    // The control: the same `for /f` reading a UTF-8 path, as the handoff used to hand one over.
    nodeFs.writeFileSync(nodePath.join(root, 'probe.js'), 'process.stdout.write("WMUX_PROBE="+process.env.WMUX_PROBE_IN+"\\n");');
    nodeFs.writeFileSync(nodePath.join(root, 'probe.cmd'), [
      '@echo off',
      'set "ELECTRON_RUN_AS_NODE=1"',
      'set "WMUX_PROBE="',
      'for /f "delims=" %%l in (\'^""%~dp0app-1.0.0\\wmux.exe" "%~dp0probe.js"^"\') do set "%%l"',
      '"%~dp0app-1.0.0\\wmux.exe" -e "require(\'fs\').appendFileSync(process.env.WMUX_LOG,JSON.stringify({probe:process.env.WMUX_PROBE})+\'\\n\')"',
      '',
    ].join('\r\n'));
  });

  afterAll(async () => { if (root) await removeTempDir(root); }, REMOVE_TEMP_DIR_HOOK_TIMEOUT_MS);

  const codexEvent = (argv: string[], cwd: string) => ({
    codex: ['--remote', 'ws://127.0.0.1:1', ...argv],
    exe, cwd, home,
    // Nothing that could close or reuse the lease reaches Codex or the tools it runs.
    bearer: 'b'.repeat(64), node: null, launch: [],
  });

  it('gives Codex exactly the arguments the plain path forwards, and the exit code back', () => {
    const tail = '"a b" "q&r" 50% "x^y" !z!';
    const plain = run(`status ${tail}`);
    expect(plain.events).toEqual([{ cli: ['status', 'a b', 'q&r', '50%', 'x^y', '!z!'], args: null, bearer: 'outer', home }]);
    const codex = run(`codex ${tail}`);
    expect(codex.status).toBe(7);
    expect(codex.events).toEqual([
      { cli: ['codex', '--wmux-handoff'], args: `codex ${tail}`, bearer: null, home },
      codexEvent(['--cd', root, '--remote-auth-token-env', 'codex', 'a b', 'q&r', '50%', 'x^y', '!z!'], root),
      { cli: ['codex', '--wmux-release', lease], args: null, bearer: null, home },
    ]);
  });

  it('gives Codex its non-ASCII CODEX_HOME, binary and directory exactly under code page 949', () => {
    // The hazard is live in this console: a path read back through `for /f` is mangled.
    nodeFs.writeFileSync(log, '');
    spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"chcp 949 >nul & "${nodePath.join(root, 'probe.cmd')}""`], {
      windowsVerbatimArguments: true, windowsHide: true, encoding: 'utf8', cwd: root, env: { ...process.env, WMUX_LOG: log, WMUX_PROBE_IN: home },
    });
    const [probe] = nodeFs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { probe?: string });
    expect(typeof probe.probe).toBe('string');
    expect(probe.probe).not.toBe(home);
    // CODEX_HOME given, and CODEX_HOME derived from the user profile.
    for (const env of [{}, { CODEX_HOME: undefined }]) {
      const r = run('codex resume', { cwd: work, chcp: 949, env });
      expect(r.status).toBe(7);
      expect(r.events).toEqual([
        { cli: ['codex', '--wmux-handoff'], args: 'codex resume', bearer: null, home },
        codexEvent(['--cd', work, '--remote-auth-token-env', 'codex', 'resume'], work),
        { cli: ['codex', '--wmux-release', lease], args: null, bearer: null, home },
      ]);
    }
  });

  it('passes a drive root as --cd intact, and no --cd once the user chose a directory', () => {
    const drive = nodePath.parse(root).root;
    const atRoot = run('codex', { cwd: drive });
    expect(atRoot.events[1]).toEqual(codexEvent(['--cd', drive, '--remote-auth-token-env', 'codex'], drive));
    const own = run('codex -C x', { cwd: work, cd: false });
    expect(own.events[1]).toEqual(codexEvent(['--remote-auth-token-env', 'codex', '-C', 'x'], work));
  });

  it('starts no Codex and releases nothing when the handoff fails', () => {
    const failed = run('codex resume', { env: { WMUX_TEST_HANDOFF_FAIL: '1' } });
    expect(failed.status).toBe(1);
    expect(failed.events).toEqual([{ cli: ['codex', '--wmux-handoff'], args: 'codex resume', bearer: null, home }]);
  });

  it('rewrites a shim an older build left behind', () => {
    const bin = nodePath.join(root, 'stale-bin');
    nodeFs.mkdirSync(bin, { recursive: true });
    expect(shimIsCurrent(bin)).toBe(false);
    nodeFs.writeFileSync(nodePath.join(bin, 'wmux.cmd'), buildShimCmd().replace('if /i "%~1"=="codex" goto :wmux_codex\r\n', ''));
    expect(shimIsCurrent(bin)).toBe(false);
    nodeFs.writeFileSync(nodePath.join(bin, 'wmux.cmd'), buildShimCmd());
    expect(shimIsCurrent(bin)).toBe(true);
  });
});

// A failed handoff's message on a real console (a ConPTY, as in a wmux pane).
// wmux.exe is a GUI-subsystem program, and with its stdout on the `for /f`
// pipe its stderr reaches no console. The Node stand-in above is a console
// program, which shows its stderr anyway, so here wmux.exe is a copy of Node
// with its PE subsystem set to GUI, what Electron's is.
describe.skipIf(process.platform !== 'win32')('wmux.cmd codex handoff errors (live console)', () => {
  let root = '';
  let temp = '';
  let isolated: Record<string, string> = {};
  /** `wmux <tail>` in a console of its own: what reached the screen, and the exit code. */
  const run = (tail: string, opts: { chcp?: number; env?: Record<string, string> } = {}) =>
    new Promise<{ exitCode: number; screen: string }>((resolve) => {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !/^(wmux_|codex_home$|electron_run_as_node$)/i.test(key)) env[key] = value;
      }
      const chcp = opts.chcp === undefined ? '' : `chcp ${opts.chcp} >nul & `;
      const term = pty.spawn(process.env.ComSpec || 'cmd.exe', `/d /s /c "${chcp}"${nodePath.join(root, 'bin', 'wmux.cmd')}" ${tail}"`, {
        cols: 400, rows: 30, cwd: root, env: { ...env, ...isolated, ...opts.env }, useConpty: true,
      });
      let out = '';
      term.onData((data) => { out += data; });
      // node-pty emits exit once the output pipe has closed: every byte is in.
      // eslint-disable-next-line no-control-regex -- stripping the console's escape sequences is the point
      term.onExit(({ exitCode }) => resolve({ exitCode, screen: out.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '') }));
    });

  beforeAll(() => {
    root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'wmux shim gui (a&b) '));
    // %TEMP% holds the error file; a Korean user name puts Korean in it.
    temp = nodePath.join(root, '홍길동', 'Temp');
    nodeFs.mkdirSync(temp, { recursive: true });
    // No daemon to reach: another data suffix, and a profile with no token or port file.
    isolated = {
      WMUX_DATA_SUFFIX: `-shim-test-${process.pid}`, USERPROFILE: root, HOME: root,
      CODEX_HOME: nodePath.join(root, '.codex'), TEMP: temp, TMP: temp,
    };
    const app = nodePath.join(root, 'app-1.0.0');
    const bundle = nodePath.join(app, 'resources', 'cli-bundle');
    nodeFs.mkdirSync(bundle, { recursive: true });
    nodeFs.mkdirSync(nodePath.join(root, 'bin'));
    nodeFs.writeFileSync(nodePath.join(root, 'bin', 'wmux.cmd'), buildShimCmd());
    const exe = nodeFs.readFileSync(process.execPath);
    // IMAGE_NT_HEADERS: 'PE\0\0', the 20-byte file header, then Subsystem 68 bytes into the optional header.
    const subsystem = exe.readUInt32LE(0x3c) + 24 + 68;
    expect(exe.readUInt16LE(subsystem)).toBe(3);
    exe.writeUInt16LE(2, subsystem);
    nodeFs.writeFileSync(nodePath.join(app, 'wmux.exe'), exe);
    // koffi stays external, as in build:cli; without it beside the bundle the CLI keeps its streams.
    for (const [entry, out] of [['../../cli/index.ts', 'cli.cjs'], ['../../cli/commands/codex.ts', 'codex.cjs']]) {
      buildSync({ entryPoints: [nodePath.join(__dirname, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: nodePath.join(bundle, out), external: ['koffi'], logLevel: 'silent' });
    }
    // The real CLI, or the real report of a message the test picks.
    nodeFs.writeFileSync(nodePath.join(bundle, 'index.js'), [
      'if (process.env.WMUX_TEST_MESSAGE) require("./codex.cjs").reportHandoffError(process.env.WMUX_TEST_MESSAGE)',
      '  .then((shown) => { if (!shown) process.stderr.write("not reported"); process.exitCode = 1; });',
      'else require("./cli.cjs");',
    ].join('\n'));
  }, 60_000);

  afterAll(async () => { if (root) await removeTempDir(root); }, REMOVE_TEMP_DIR_HOOK_TIMEOUT_MS);

  it('shows the real handoff\'s error and exits 1, leaving no file behind', async () => {
    const r = await run('codex resume');
    expect(r.exitCode).toBe(1);
    expect(r.screen).toContain('Run wmux codex directly in a wmux terminal pane.');
    expect(nodeFs.readdirSync(temp)).toEqual([]);
  }, 60_000);

  it('shows a non-ASCII message intact under code page 949', async () => {
    const message = 'This terminal\'s Codex account is C:\\Users\\홍길동\\.codex & 50% "q" ^x !y!';
    const r = await run('codex', { chcp: 949, env: { WMUX_TEST_MESSAGE: message } });
    expect(r.exitCode).toBe(1);
    expect(r.screen).toContain(message);
    expect(nodeFs.readdirSync(temp)).toEqual([]);
  }, 60_000);
});

describe('buildPathEditScript', () => {
  it('add: reads raw (unexpanded) registry value and writes back as ExpandString', () => {
    const script = buildPathEditScript('C:\\Users\\u\\AppData\\Local\\wmux\\bin', 'add');
    // %VAR% entries must NOT be expanded-and-baked-in on rewrite
    expect(script).toContain('DoNotExpandEnvironmentNames');
    // REG_EXPAND_SZ must be preserved (SetEnvironmentVariable demotes to REG_SZ)
    expect(script).toContain('-Type ExpandString');
    // New shells must learn about the change without relogin
    expect(script).toContain('SendMessageTimeout');
    expect(script).toContain("'Environment'");
    // Idempotency: only writes when membership actually changes
    expect(script).toContain('if (-not $hit) { $parts += $bin; $changed = $true }');
    expect(script).toContain('if (-not $changed) { exit 0 }');
  });

  it('broadcast off: writes PATH and leaves out the WM_SETTINGCHANGE broadcast', () => {
    const script = buildPathEditScript('C:\\wmux\\bin', 'remove', undefined, undefined, false);
    expect(script).toContain('-Type ExpandString');
    expect(script).not.toContain('SendMessageTimeout');
    expect(script).not.toContain('Add-Type');
  });

  it('the broadcast-only script sends WM_SETTINGCHANGE and never touches the registry', () => {
    const script = buildSettingChangeScript();
    expect(script).toContain("SendMessageTimeout([System.IntPtr]0xffff, 0x1A");
    expect(script).not.toContain('Set-ItemProperty');
    expect(script).not.toContain('Registry');
  });

  it('remove: filters only the exact bin entry', () => {
    const script = buildPathEditScript('C:\\wmux\\bin', 'remove');
    expect(script).toContain('if ($hit) {');
    expect(script).toContain('Where-Object');
    expect(script).toContain('-ne $bin');
  });

  it('escapes single quotes in the bin dir for the PowerShell literal', () => {
    const script = buildPathEditScript("C:\\odd'name\\bin", 'add');
    expect(script).toContain("$bin = 'C:\\odd''name\\bin'");
  });

  it('never uses setx or [Environment]::SetEnvironmentVariable', () => {
    for (const op of ['add', 'remove'] as const) {
      const script = buildPathEditScript('C:\\wmux\\bin', op);
      expect(script).not.toContain('setx');
      expect(script).not.toContain('SetEnvironmentVariable');
    }
  });

  // Regression: the original script read the registry with a .NET method call
  // and wrote it back with a cmdlet. Under ConstrainedLanguage the read throws
  // but the write succeeds, so the user's entire PATH was replaced by binDir.
  describe('fail-closed guarantees', () => {
    for (const op of ['add', 'remove'] as const) {
      it(`${op}: refuses to write on an untrusted read`, () => {
        const script = buildPathEditScript('C:\\wmux\\bin', op);
        // Errors must not be swallowed into a subsequent write.
        expect(script.split('\n')[0]).toBe(`$ErrorActionPreference = 'Stop'`);
        // The .NET read is wrapped, and a failure leaves $cur null...
        expect(script).toContain('} catch { $cur = $null }');
        // ...which bails out before any Set-ItemProperty.
        expect(script).toContain('if ($null -eq $cur) { exit 10 }');
        expect(script.indexOf('if ($null -eq $cur) { exit 10 }')).toBeLessThan(
          script.indexOf('Set-ItemProperty'),
        );
      });

      it(`${op}: asserts no unrelated entry is dropped before writing`, () => {
        const script = buildPathEditScript('C:\\wmux\\bin', op);
        expect(script).toContain('$orig = @($parts)');
        expect(script).toContain('if ($lost.Count -gt 0) { exit 11 }');
        expect(script.indexOf('exit 11')).toBeLessThan(script.indexOf('Set-ItemProperty'));
      });
    }

    it('falls back to reg.exe, which survives ConstrainedLanguage and stays unexpanded', () => {
      const script = buildPathEditScript('C:\\wmux\\bin', 'add');
      expect(script).toContain('reg.exe');
      // Get-ItemProperty would EXPAND %VAR% and bake it in — must not be the reader.
      expect(script).not.toContain('Get-ItemProperty');
      // Whole-key query, so "no Path value" is distinguishable from "unreadable".
      expect(script).toContain(`query 'HKCU\\Environment'`);
      expect(script).not.toContain('/v Path');
    });

    it('backs up the previous value outside HKCU:\\Environment', () => {
      const script = buildPathEditScript('C:\\wmux\\bin', 'add');
      expect(script).toContain(`Set-ItemProperty -Path 'HKCU:\\Software\\wmux' -Name 'UserPathBackup'`);
      // A stray value under Environment would become a real env var.
      expect(script).not.toContain(`-Path 'HKCU:\\Environment' -Name 'UserPathBackup'`);
    });

    it('isolates the WM_SETTINGCHANGE broadcast so it cannot mask a good write', () => {
      const script = buildPathEditScript('C:\\wmux\\bin', 'add');
      const write = script.indexOf(`-Name 'Path'`);
      const broadcast = script.indexOf('Add-Type');
      expect(write).toBeLessThan(broadcast);
      expect(script.slice(broadcast)).toContain('} catch { }');
      expect(script.trimEnd().endsWith('exit 0')).toBe(true);
    });

    it('subKey redirects every registry site together', () => {
      const script = buildPathEditScript('C:\\wmux\\bin', 'add', 'Software\\wmux-test');
      expect(script).toContain(`OpenSubKey('Software\\wmux-test'`);
      expect(script).toContain(`query 'HKCU\\Software\\wmux-test'`);
      expect(script).toContain(`Set-ItemProperty -Path 'HKCU:\\Software\\wmux-test' -Name 'Path'`);
      // No registry site may still point at the real Environment key. (The bare
      // literal 'Environment' legitimately remains as the WM_SETTINGCHANGE lParam.)
      expect(script).not.toContain(`OpenSubKey('Environment'`);
      expect(script).not.toContain(`query 'HKCU\\Environment'`);
      expect(script).not.toContain(`-Path 'HKCU:\\Environment'`);
    });
  });
});

describe('explainPathEditExit', () => {
  it('explains the deliberate bail-outs and nothing else', () => {
    expect(explainPathEditExit(10, 'C:\\wmux\\bin')).toContain('ConstrainedLanguage');
    expect(explainPathEditExit(10, 'C:\\wmux\\bin')).toContain('C:\\wmux\\bin');
    expect(explainPathEditExit(11, 'C:\\wmux\\bin')).toContain('aborted');
    expect(explainPathEditExit(0, 'C:\\wmux\\bin')).toBeNull();
    expect(explainPathEditExit(1, 'C:\\wmux\\bin')).toBeNull();
  });
});

describe('deriveShimPaths', () => {
  it('derives version-independent bin dir + versioned cli-bundle path', () => {
    const { binDir, cliJsPath } = deriveShimPaths(
      'C:\\Users\\u\\AppData\\Local\\wmux\\app-3.2.0\\wmux.exe',
    );
    expect(binDir).toBe('C:\\Users\\u\\AppData\\Local\\wmux\\bin');
    expect(cliJsPath).toBe(
      'C:\\Users\\u\\AppData\\Local\\wmux\\app-3.2.0\\resources\\cli-bundle\\index.js',
    );
  });
});

// ─── live PATH edit against a throwaway registry key (Windows only) ──────────
// The string assertions above can only prove the guards are *present*. This
// runs the real generated script through the real spawn path and asserts the
// property that actually matters: a pre-existing PATH is never destroyed —
// including under ConstrainedLanguage, the exact mode that caused the wipe.
import { execFileSync } from 'child_process';

// Each case spawns real powershell.exe + reg.exe. On a busy Windows CI runner
// the FIRST case pays the one-time PowerShell cold-start and lands just over
// vitest's 5s default (observed 5.6s in CI while its siblings ran 1–2s), so it
// flakes intermittently. Raise the per-test budget for the whole suite — these
// are the slowest tests here anyway, and a genuinely hung reg.exe still fails.

// A spawn budget, not a performance target: warm spawns measure ~1s, and this
// only has to be wide enough that anything hitting it is genuinely stuck. #860
// saw one exceed 10s on a loaded runner with nothing wrong with the shim.
const SPAWN_TIMEOUT_MS = 20_000;
// The most spawn-heavy case ("add is idempotent") runs seed + add + add +
// readRaw. The per-test budget has to clear all of them at their own ceiling,
// or vitest kills the case first and the failure arrives as a bare "timed out
// in Nms" — naming neither the spawn nor the reason, which is precisely what
// SPAWN_TIMEOUT_MS exists to report. Derived rather than hand-tuned because
// the previous pairing (10s spawn, 15s case) claimed that guarantee in a
// comment while the arithmetic only delivered it when exactly ONE spawn was
// slow. General runner slowness — the actual failure mode — broke it.
const MAX_SPAWNS_PER_CASE = 4;
const CASE_TIMEOUT_MS = SPAWN_TIMEOUT_MS * MAX_SPAWNS_PER_CASE + 10_000;

describe.skipIf(process.platform !== 'win32')('PATH edit (live registry, sandbox key)', { timeout: CASE_TIMEOUT_MS }, () => {
  const SUB = 'Software\\wmux-cliShim-test';
  const BAK = 'Software\\wmux-cliShim-test-bak';
  const BIN = 'C:\\Users\\u\\AppData\\Local\\wmux\\bin';
  // A %VAR% entry is included on purpose: it must survive unexpanded.
  const SEED = '%USERPROFILE%\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs';
  const PS = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

  // The first powershell.exe in a process pays a one-time cold start — its own
  // binaries and the .NET images are not in the OS file cache yet. #576
  // measured 5.6s for it; a run on this branch exceeded 10s. It is absorbed
  // once in a hook with a budget of its own rather than billed to whichever
  // case happens to run first, which is how #576 flaked and what its 5s → 15s
  // widening left unaddressed — a wider budget moves that threshold, it does
  // not stop a one-time cost from landing inside a per-test one.
  const WARMUP_TIMEOUT_MS = 60_000;

  const ps = (script: string, timeoutMs: number = SPAWN_TIMEOUT_MS) => {
    try {
      return { code: 0, out: execFileSync(PS, ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', windowsHide: true, timeout: timeoutMs,
      }), err: '' };
    } catch (e) {
      const err = e as { status?: number | null; stdout?: string; stderr?: string; signal?: string };
      // A timeout kills the child with a signal and leaves status null. Say so —
      // "hung" and "exited non-zero" need different fixes.
      const killed = err.signal ? `killed by ${err.signal} after ${timeoutMs} ms` : '';
      return {
        code: err.status ?? -1,
        out: err.stdout ?? '',
        err: [killed, err.stderr].filter(Boolean).join('\n').trim(),
      };
    }
  };

  /**
   * Spawn for fixture work, where a non-zero exit is a broken *harness* and
   * never a finding about the code under test. It has to say that itself: the
   * cases below assert exit codes from the real shim, so a silently failed
   * setup does not vanish — it comes back wearing the shim's own failure. That
   * is #690, where a seed that never created the key surfaced as READ_FAILED
   * and read as a genuine regression.
   */
  const psOk = (label: string, script: string, timeoutMs?: number) => {
    const r = ps(script, timeoutMs);
    if (r.code !== 0) {
      throw new Error(`fixture "${label}" failed with exit ${r.code}\n${r.err || r.out}`.trim());
    }
    return r;
  };

  /**
   * Remove sandbox keys, loudly if it cannot. Deliberately *not*
   * `-ErrorAction SilentlyContinue`: that suppresses the message but still
   * leaves `$?` false, so `powershell.exe -Command` exits 1 and "there was
   * nothing to delete" is indistinguishable from "the delete failed" — the
   * same conflation this file is fixing. Test-Path answers the first question
   * up front, so a non-zero exit can only mean the second.
   */
  const dropKeys = (label: string, ...subs: string[]) => psOk(label,
    `$ErrorActionPreference = 'Stop'\n` +
    subs.map((s) => `if (Test-Path 'HKCU:\\${s}') { Remove-Item 'HKCU:\\${s}' -Recurse -Force }`).join('\n'),
  );

  const seed = () => psOk('seed sandbox key',
    `$ErrorActionPreference = 'Stop'\n` +
    `if (Test-Path 'HKCU:\\${SUB}') { Remove-Item 'HKCU:\\${SUB}' -Recurse -Force }\n` +
    `New-Item -Path 'HKCU:\\${SUB}' -Force | Out-Null\n` +
    `Set-ItemProperty -Path 'HKCU:\\${SUB}' -Name 'Path' -Value '${SEED}' -Type ExpandString\n` +
    // Post-condition, in the same spawn rather than a second one: prove the key
    // holds what every case below depends on, not merely that no step threw.
    // DoNotExpandEnvironmentNames because the %VAR% entry must still be raw —
    // that is the property these cases exist to protect.
    `$raw = (Get-Item 'HKCU:\\${SUB}').GetValue('Path', $null, 'DoNotExpandEnvironmentNames')\n` +
    `if ($raw -ne '${SEED}') { throw "seed left Path as '$raw'" }`,
  );

  /** Raw (unexpanded) current value of the sandbox Path, via reg.exe. */
  const readRaw = () => {
    const out = ps(`& "$env:SystemRoot\\System32\\reg.exe" query 'HKCU\\${SUB}' /v Path`).out;
    const m = out.match(/^\s+Path\s+REG_\S+\s{4}(.*)$/m);
    return m ? m[1].trim() : null;
  };

  /**
   * Assert an exit code, carrying the spawn's own diagnosis into the failure
   * message. Bare `expect(r.code).toBe(0)` renders "expected -1 to be +0" and
   * drops `r.err` — which is where `ps` put "killed by SIGTERM after N ms", the
   * one fact separating a hung spawn from a shim that genuinely failed. #860
   * lost exactly that: a timeout on a loaded runner was read as a product
   * regression, and the message that said otherwise had already been built.
   */
  const expectExit = (r: { code: number; err: string; out: string }, code: number) => {
    expect(r.code, r.err || r.out || undefined).toBe(code);
  };

  const run = (op: 'add' | 'remove', constrained: boolean) => {
    const prefix = constrained ? `$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\n` : '';
    return ps(prefix + buildPathEditScript(BIN, op, SUB, BAK));
  };

  // Pay the cold start here, where it has its own budget and its own name. If
  // PowerShell is genuinely unusable this reports that once, up front, instead
  // of disguising it as the first case's failure.
  beforeAll(() => {
    psOk('warm up powershell', 'exit 0', WARMUP_TIMEOUT_MS);
  }, WARMUP_TIMEOUT_MS + 5_000);

  afterEach(() => {
    // Also checked: teardown that could not run leaves keys behind, and the
    // damage lands on the *next* case — the failure would be attributed to
    // whichever test ran after the one that actually broke.
    dropKeys('teardown sandbox keys', SUB, BAK);
    // Its own budget, for the same reason the cases have one: this hook spawns,
    // and vitest's default 10s hookTimeout would fire before the spawn's, again
    // trading a named failure for a bare timeout.
  }, SPAWN_TIMEOUT_MS + 10_000);

  it('a failed fixture spawn reports itself instead of running the case', () => {
    // Guards the #690 fix itself: if psOk ever goes back to swallowing an exit
    // code, a broken fixture returns to impersonating the shim and this fails.
    // Asserted on the label, not on the exit value: the property is that a
    // fixture failure carries its own name. Pinning the code made this fail on
    // a slow runner for a spawn that had been killed rather than exiting —
    // which is psOk working, reported as psOk broken.
    expect(() => psOk('deliberate failure', 'exit 3')).toThrow(/fixture "deliberate failure" failed with exit/);
  });

  for (const constrained of [false, true]) {
    const mode = constrained ? 'ConstrainedLanguage' : 'FullLanguage';

    it(`${mode}: add appends without destroying existing entries`, () => {
      seed();
      const r = run('add', constrained);
      const after = readRaw();
      expectExit(r, 0);
      // Every seeded entry survives, unexpanded, in order — and bin is appended.
      expect(after).toBe(`${SEED};${BIN}`);
      expect(after).toContain('%USERPROFILE%');
    });

    it(`${mode}: add is idempotent`, () => {
      seed();
      expectExit(run('add', constrained), 0);
      expectExit(run('add', constrained), 0);
      expect(readRaw()).toBe(`${SEED};${BIN}`);
    });

    it(`${mode}: remove strips only the bin entry`, () => {
      seed();
      run('add', constrained);
      expectExit(run('remove', constrained), 0);
      expect(readRaw()).toBe(SEED);
    });

    it(`${mode}: an unreadable key fails closed — exits READ_FAILED and writes nothing`, () => {
      // No sandbox key at all — both readers must fail rather than invent an empty PATH.
      // This removal is the precondition, so it is checked like any other fixture:
      // if it silently failed, the case would assert READ_FAILED against a key
      // that still exists and pass for the wrong reason.
      dropKeys('drop sandbox key', SUB);
      const r = run('add', constrained);
      expectExit(r, PATH_EDIT_EXIT.READ_FAILED);
      expect(explainPathEditExit(r.code, BIN)).toContain('ConstrainedLanguage');
      // Crucially: the key was NOT created as a side effect of the failed edit.
      expect(readRaw()).toBeNull();
    });

    it(`${mode}: backs the previous value up before writing`, () => {
      seed();
      expectExit(run('add', constrained), 0);
      // Read back from the harness (always FullLanguage) — this asserts what the
      // script wrote, not how it read.
      const bak = ps(`(Get-ItemProperty -Path 'HKCU:\\${BAK}' -Name 'UserPathBackup').UserPathBackup`).out.trim();
      expect(bak).toBe(SEED);
    });
  }
});

// ─── darwin CLI shim (P3) ────────────────────────────────────────────────────
// 실제 tmpdir에 가짜 앱 번들 구조를 만들어 심링크 설치·소유권 규칙을 검증한다.
// Windows에서는 스킵: 이 함수는 프로덕션에서 darwin에서만 호출되며(main/index.ts
// 게이트), Windows는 심링크 생성에 권한이 필요하고 경로 구분자도 달라 검증 대상이
// 아니다. macOS·Linux(둘 다 POSIX 심링크)에서만 돌린다.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach } from 'vitest';
import { installCliShimDarwin, deriveDarwinCliTarget, darwinShimNeedsRepair } from '../cliShim';

describe.skipIf(process.platform === 'win32')('installCliShimDarwin', () => {
  let tmp: string;
  let execPath: string;
  let target: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-shim-'));
    // 가짜 앱 번들: <tmp>/wmux.app/Contents/{MacOS/wmux, Resources/cli-bundle/index.js}
    const contents = path.join(tmp, 'wmux.app', 'Contents');
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(contents, 'Resources', 'cli-bundle'), { recursive: true });
    execPath = path.join(contents, 'MacOS', 'wmux');
    target = path.join(contents, 'Resources', 'cli-bundle', 'index.js');
    fs.writeFileSync(target, '#!/usr/bin/env node\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('deriveDarwinCliTarget: MacOS 실행 파일 → Resources/cli-bundle/index.js', () => {
    expect(deriveDarwinCliTarget(execPath)).toBe(target);
  });

  it('첫 후보 실패(권한) 시 폴백 후보에 설치하고 PATH 미포함이면 안내를 돌려준다', () => {
    const fallback = path.join(tmp, 'home', '.local', 'bin', 'wmux');
    // 첫 후보를 읽기 전용 디렉토리 밑으로 둬서 실패시킨다
    const roDir = path.join(tmp, 'ro');
    fs.mkdirSync(roDir, { recursive: true });
    fs.chmodSync(roDir, 0o500);
    const first = path.join(roDir, 'bin', 'wmux');
    const result = installCliShimDarwin(execPath, {
      homeDir: path.join(tmp, 'home'),
      envPath: '/usr/bin:/bin',
      candidates: [first, fallback],
    });
    fs.chmodSync(roDir, 0o700); // cleanup 가능하게 복구
    expect(result.status).toBe('installed');
    expect(result.linkPath).toBe(fallback);
    expect(fs.readlinkSync(fallback)).toBe(target);
    expect(result.guidance).toContain(path.dirname(fallback));
  });

  it('우리 것 아닌 기존 파일(Homebrew 등)은 절대 건드리지 않는다', () => {
    const link = path.join(tmp, 'bin', 'wmux');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.writeFileSync(link, '#!/bin/sh\necho brew\n', 'utf8'); // 심링크 아닌 실파일
    const result = installCliShimDarwin(execPath, {
      homeDir: tmp,
      envPath: '/usr/bin',
      candidates: [link],
    });
    expect(result.status).toBe('foreign');
    expect(fs.readFileSync(link, 'utf8')).toContain('echo brew'); // 무변경
  });

  it('이미 올바른 심링크면 skip, 우리 것의 옛 타깃이면 갱신한다', () => {
    const link = path.join(tmp, 'bin', 'wmux');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    // 옛 번들을 가리키는 "우리 것" 심링크
    const oldTarget = path.join(tmp, 'old.app', 'Contents', 'Resources', 'cli-bundle', 'index.js');
    fs.symlinkSync(oldTarget, link);
    const opts = { homeDir: tmp, envPath: path.dirname(link), candidates: [link] };
    const updated = installCliShimDarwin(execPath, opts);
    expect(updated.status).toBe('installed');
    expect(fs.readlinkSync(link)).toBe(target);
    // 재실행 → 이미 올바름 → skip
    const again = installCliShimDarwin(execPath, opts);
    expect(again.status).toBe('already');
  });

  // issue #505 — the marker must not gate out repair of a stale owned link.
  describe('darwinShimNeedsRepair', () => {
    it('owned link that targets a moved/old bundle needs repair', () => {
      const link = path.join(tmp, 'bin', 'wmux');
      fs.mkdirSync(path.dirname(link), { recursive: true });
      const oldTarget = path.join(tmp, 'old.app', 'Contents', 'Resources', 'cli-bundle', 'index.js');
      fs.symlinkSync(oldTarget, link); // owned shape, but not the current bundle
      expect(darwinShimNeedsRepair(execPath, { homeDir: tmp, candidates: [link] })).toBe(true);
    });

    it('owned link whose target no longer exists (DMG ejected) needs repair', () => {
      const link = path.join(tmp, 'bin', 'wmux');
      fs.mkdirSync(path.dirname(link), { recursive: true });
      // Points at the current-shaped target path, but the file is gone.
      fs.symlinkSync(target, link);
      fs.rmSync(target);
      expect(darwinShimNeedsRepair(execPath, { homeDir: tmp, candidates: [link] })).toBe(true);
    });

    it('correct link needs no repair', () => {
      const link = path.join(tmp, 'bin', 'wmux');
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(target, link);
      expect(darwinShimNeedsRepair(execPath, { homeDir: tmp, candidates: [link] })).toBe(false);
    });

    it('foreign symlink and absent link never need repair', () => {
      const foreign = path.join(tmp, 'bin', 'wmux');
      fs.mkdirSync(path.dirname(foreign), { recursive: true });
      fs.symlinkSync('/opt/homebrew/Cellar/wmux/bin/wmux', foreign); // not owned shape
      const absent = path.join(tmp, 'nope', 'wmux');
      expect(darwinShimNeedsRepair(execPath, { homeDir: tmp, candidates: [foreign, absent] })).toBe(false);
    });
  });
});
