import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('PowerShell terminal hook', () => {
  it('does not write OSC sequences out-of-band while rendering prompt', () => {
    const hookPath = path.resolve(process.cwd(), 'src/main/pty/shell-hooks/pwsh.ps1');
    const hook = fs.readFileSync(hookPath, 'utf8');

    expect(hook).not.toMatch(/^\s*\[Console\]::Write\(/m);
    expect(hook).toContain('return $oscPrefix + [string]$body');
  });

  // Issue #1267. This hook wraps the user's prompt too, and the Test-Path
  // guard sitting in front of the delegation reset $? to true — so an
  // exit-code segment (oh-my-posh `status`, Starship) stayed green after a
  // failed command. Same defect as the daemon-mode wrapper in
  // src/daemon/shell-integration.ts; this is the local-mode fallback path
  // wmux uses when the daemon is gone.
  it('hands the real $? to the wrapped prompt', () => {
    const hookPath = path.resolve(process.cwd(), 'src/main/pty/shell-hooks/pwsh.ps1');
    const hook = fs.readFileSync(hookPath, 'utf8');

    // The snapshot must be the first statement of the prompt function —
    // comments are fine, any statement before it is not.
    expect(hook).toMatch(/function prompt \{(?:\s*#[^\n]*\n)*\s*\$__wmux_ok = \$\?/);

    // ...and the restore must be the last thing before the delegation, with
    // the Test-Path guard (which resets $?) already behind it.
    expect(hook).toMatch(
      /if \(-not \$__wmux_ok\) \{ Write-Error [^\n]*-ErrorAction Ignore \}\s*\r?\n\s*__wmux_original_prompt/,
    );

    // Ignore records nothing in $Error. SilentlyContinue would push a
    // synthetic record that oh-my-posh reads as exit code 1, masking the real
    // one — the swap looks harmless and is not.
    expect(hook).not.toMatch(/Write-Error [^\n]*-ErrorAction SilentlyContinue/);
  });
});
