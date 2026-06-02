import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Codex TUI wheel-scroll regression lock.
//
// The terminal hook must route wheel input into xterm scrollback explicitly
// instead of relying on the default wheel path. Otherwise hosted terminals
// can feel stuck even though the buffer contains scrollback.
describe('useTerminal wheel scroll handling (source-level)', () => {
  const hookPath = path.join(__dirname, '..', 'useTerminal.ts');
  const src = fs.readFileSync(hookPath, 'utf-8');

  it('attaches a custom wheel handler on the terminal', () => {
    expect(src).toMatch(/attachCustomWheelEventHandler\(/);
  });

  it('routes wheel input into terminal scrollback when available', () => {
    expect(src).toMatch(/if\s*\(\s*terminal\.buffer\.active\.type\s*!==\s*['"]normal['"]\s*\)\s*return true;/);
    expect(src).toMatch(/terminal\.scrollLines\(/);
    expect(src).toMatch(/ev\.preventDefault\(\);/);
  });
});
