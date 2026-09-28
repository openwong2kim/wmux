import { describe, it, expect } from 'vitest';
import { buildExecArgs, PWSH_EXIT_TAIL } from '../execWrapper';

// X8 exec-style panes: argv synthesis per wrapper-shell family. The exit-code
// propagation contract here is what makes `restart: on-failure` meaningful —
// the wrapper's exit code must BE the command's exit code. The pwsh tail was
// validated against live pwsh (2026-06-13): native exit N → N, missing
// binary → 1 (a bare `exit $LASTEXITCODE` exits 0 there), pure-PS success → 0.
describe('buildExecArgs', () => {
  const CMD = 'claude /loop --until done';

  it('pwsh family gets the snapshot-first exit propagation tail', () => {
    for (const shell of [
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'pwsh.exe',
      'pwsh',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ]) {
      expect(buildExecArgs(shell, CMD)).toEqual([
        '-NoLogo',
        '-NoProfile',
        '-Command',
        `${CMD}${PWSH_EXIT_TAIL}`,
      ]);
    }
    // The tail must snapshot $? / $LASTEXITCODE before any expression can
    // reset them, and must classify all three outcome families.
    expect(PWSH_EXIT_TAIL).toMatch(/^; \$__wmuxOk = \$\?; \$__wmuxLec = \$LASTEXITCODE;/);
    expect(PWSH_EXIT_TAIL).toContain('exit $__wmuxLec');
    expect(PWSH_EXIT_TAIL).toContain('exit 1');
  });

  // #1620: on a factory-default Windows client powershell.exe resolves an npm
  // agent (`codex`) to its .ps1 shim, which the Restricted policy blocks. The
  // caller decides the policy args; the builder only has to place them.
  it('places pwsh policy args before -Command, so they are argv and not command text', () => {
    const policy = ['-ExecutionPolicy', 'RemoteSigned'];
    expect(buildExecArgs('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', CMD, policy)).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'RemoteSigned',
      '-Command',
      `${CMD}${PWSH_EXIT_TAIL}`,
    ]);
  });

  it('ignores pwsh policy args for non-PowerShell families', () => {
    const policy = ['-ExecutionPolicy', 'RemoteSigned'];
    expect(buildExecArgs('C:\\Windows\\System32\\cmd.exe', CMD, policy)).toEqual(['/d', '/s', '/c', CMD]);
    expect(buildExecArgs('/bin/bash', CMD, policy)).toEqual(['-lc', CMD]);
  });

  it('cmd.exe gets /d /s /c (native child exit-code propagation, AutoRun skipped)', () => {
    expect(buildExecArgs('C:\\Windows\\System32\\cmd.exe', CMD)).toEqual(['/d', '/s', '/c', CMD]);
  });

  it('POSIX families get -lc (login PATH + native exit-status propagation)', () => {
    for (const shell of ['/bin/bash', '/usr/bin/zsh', '/bin/sh', '/bin/dash', '/usr/bin/ksh', '/usr/local/bin/fish']) {
      expect(buildExecArgs(shell, CMD)).toEqual(['-lc', CMD]);
    }
  });

  it('strips the login-shell dash prefix before classifying', () => {
    expect(buildExecArgs('-zsh', CMD)).toEqual(['-lc', CMD]);
  });

  it('returns null for unknown families instead of guessing argv', () => {
    expect(buildExecArgs('C:\\tools\\nu.exe', CMD)).toBeNull();
    expect(buildExecArgs('/usr/bin/nu', CMD)).toBeNull();
    expect(buildExecArgs('', CMD)).toBeNull();
  });
});
