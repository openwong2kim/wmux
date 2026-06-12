import { describe, it, expect } from 'vitest';
import { buildShimCmd, buildPathEditScript, deriveShimPaths } from '../cliShim';

describe('buildShimCmd', () => {
  it('quotes paths, scopes ELECTRON_RUN_AS_NODE, and forwards args + exit code', () => {
    const cmd = buildShimCmd(
      'C:\\Users\\u\\AppData\\Local\\wmux\\app-3.2.0\\wmux.exe',
      'C:\\Users\\u\\AppData\\Local\\wmux\\app-3.2.0\\resources\\cli-bundle\\index.js',
    );
    expect(cmd).toContain('setlocal');
    expect(cmd).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(cmd).toContain(
      'call "C:\\Users\\u\\AppData\\Local\\wmux\\app-3.2.0\\wmux.exe" "C:\\Users\\u\\AppData\\Local\\wmux\\app-3.2.0\\resources\\cli-bundle\\index.js" %*',
    );
    expect(cmd).toContain('endlocal & exit /b %ERRORLEVEL%');
    // CRLF line endings — cmd.exe is picky about bare LF in some contexts
    expect(cmd.includes('\r\n')).toBe(true);
    // No delayed expansion — a literal `!` in a path must survive
    expect(cmd).not.toContain('enabledelayedexpansion');
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
    expect(script).toContain('if ($changed) {');
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
