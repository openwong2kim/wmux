import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Screen-reader mode wiring, locked at the source level like the other
// useTerminal wiring tests: the hook is an xterm-bound effect that unit tests
// cannot mount. The rules are tested in terminal/__tests__/screenReaderMode.test.ts.
describe('useTerminal — screen-reader mode wiring (source-level)', () => {
  // LF only: with core.autocrlf (the Windows default) the checkout is CRLF.
  const src = fs.readFileSync(path.join(__dirname, '..', 'useTerminal.ts'), 'utf-8').replace(/\r\n/g, '\n');

  it('builds a fresh terminal in the current state', () => {
    expect(src).toContain('screenReaderMode: screenReaderOn(),');
  });

  it('syncs an adopted terminal before the IME residue guard reads the option', () => {
    const sync = src.indexOf('syncScreenReaderMode(terminal, screenReaderOn());');
    const guard = src.indexOf('let imeResidueGuard = (terminal.options.screenReaderMode');
    expect(sync).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(sync);
  });

  it('follows the state while mounted and stops in the cleanup', () => {
    const follow = src.indexOf('const unfollowScreenReader = followScreenReader(terminal, {');
    expect(follow).toBeGreaterThan(src.indexOf('let imeResidueGuard = '));
    expect(src.indexOf('unfollowScreenReader();', follow)).toBeGreaterThan(follow);
  });
});
