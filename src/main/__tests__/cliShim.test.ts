import { describe, it, expect } from 'vitest';
import {
  buildShimCmd,
  buildPathEditScript,
  deriveShimPaths,
  explainPathEditExit,
  PATH_EDIT_EXIT,
} from '../cliShim';

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
describe.skipIf(process.platform !== 'win32')('PATH edit (live registry, sandbox key)', { timeout: 15_000 }, () => {
  const SUB = 'Software\\wmux-cliShim-test';
  const BAK = 'Software\\wmux-cliShim-test-bak';
  const BIN = 'C:\\Users\\u\\AppData\\Local\\wmux\\bin';
  // A %VAR% entry is included on purpose: it must survive unexpanded.
  const SEED = '%USERPROFILE%\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs';
  const PS = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

  const ps = (script: string) => {
    try {
      return { code: 0, out: execFileSync(PS, ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', windowsHide: true, timeout: 20000,
      }) };
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      return { code: err.status ?? -1, out: err.stdout ?? '' };
    }
  };

  const seed = () => ps(
    `if (Test-Path 'HKCU:\\${SUB}') { Remove-Item 'HKCU:\\${SUB}' -Recurse -Force }\n` +
    `New-Item -Path 'HKCU:\\${SUB}' -Force | Out-Null\n` +
    `Set-ItemProperty -Path 'HKCU:\\${SUB}' -Name 'Path' -Value '${SEED}' -Type ExpandString`,
  );

  /** Raw (unexpanded) current value of the sandbox Path, via reg.exe. */
  const readRaw = () => {
    const out = ps(`& "$env:SystemRoot\\System32\\reg.exe" query 'HKCU\\${SUB}' /v Path`).out;
    const m = out.match(/^\s+Path\s+REG_\S+\s{4}(.*)$/m);
    return m ? m[1].trim() : null;
  };

  const run = (op: 'add' | 'remove', constrained: boolean) => {
    const prefix = constrained ? `$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\n` : '';
    return ps(prefix + buildPathEditScript(BIN, op, SUB, BAK));
  };

  afterEach(() => {
    ps(`Remove-Item 'HKCU:\\${SUB}' -Recurse -Force -ErrorAction SilentlyContinue\n` +
       `Remove-Item 'HKCU:\\${BAK}' -Recurse -Force -ErrorAction SilentlyContinue`);
  });

  for (const constrained of [false, true]) {
    const mode = constrained ? 'ConstrainedLanguage' : 'FullLanguage';

    it(`${mode}: add appends without destroying existing entries`, () => {
      seed();
      const r = run('add', constrained);
      const after = readRaw();
      expect(r.code).toBe(0);
      // Every seeded entry survives, unexpanded, in order — and bin is appended.
      expect(after).toBe(`${SEED};${BIN}`);
      expect(after).toContain('%USERPROFILE%');
    });

    it(`${mode}: add is idempotent`, () => {
      seed();
      expect(run('add', constrained).code).toBe(0);
      expect(run('add', constrained).code).toBe(0);
      expect(readRaw()).toBe(`${SEED};${BIN}`);
    });

    it(`${mode}: remove strips only the bin entry`, () => {
      seed();
      run('add', constrained);
      expect(run('remove', constrained).code).toBe(0);
      expect(readRaw()).toBe(SEED);
    });

    it(`${mode}: an unreadable key fails closed — exits READ_FAILED and writes nothing`, () => {
      // No sandbox key at all — both readers must fail rather than invent an empty PATH.
      ps(`Remove-Item 'HKCU:\\${SUB}' -Recurse -Force -ErrorAction SilentlyContinue`);
      const r = run('add', constrained);
      expect(r.code).toBe(PATH_EDIT_EXIT.READ_FAILED);
      expect(explainPathEditExit(r.code, BIN)).toContain('ConstrainedLanguage');
      // Crucially: the key was NOT created as a side effect of the failed edit.
      expect(readRaw()).toBeNull();
    });

    it(`${mode}: backs the previous value up before writing`, () => {
      seed();
      expect(run('add', constrained).code).toBe(0);
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
