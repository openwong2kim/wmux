import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Codex TUI render regression lock.
//
// WebGL can leave upper rows unpainted while lower status rows still update,
// which makes tool output look missing even though the daemon buffer contains
// the bytes. Keep the default renderer on xterm's DOM path until WebGL is
// proven safe for full-screen TUI redraws.
describe('useTerminal WebGL fallback', () => {
  const hookPath = path.join(__dirname, '..', 'useTerminal.ts');
  const src = fs.readFileSync(hookPath, 'utf-8');

  it('keeps the WebGL renderer disabled by default', () => {
    expect(src).toMatch(/const\s+XTERM_WEBGL_ENABLED\s*=\s*false/);
  });

  it('does not acquire a WebGL context when the fallback is disabled', () => {
    expect(src).toMatch(/if\s*\(\s*!XTERM_WEBGL_ENABLED\s*\)\s*return;/);
    expect(src).toMatch(/if\s*\(\s*!XTERM_WEBGL_ENABLED\s*\)\s*{[\s\S]*?requestAnimationFrame/);
  });
});
