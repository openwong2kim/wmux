import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { terminalLaunchCommand } from '../terminalLaunch';

describe('native launch instruction', () => {
  it('preserves shell metacharacters as one literal argument', () => {
    const prompt = "It's $HOME; $(echo injected) `echo nope` --help";
    const command = terminalLaunchCommand('codex', prompt);
    if (process.platform !== 'win32') {
      const output = execFileSync('/bin/sh', ['-c', 'codex() { printf "%s" "$2"; }; ' + command], { encoding: 'utf8' });
      expect(output).toBe(prompt);
    }
  });
  it('rejects arbitrary launchers, terminal controls and empty instructions', () => {
    for (const prompt of ['', '  ', 'x\ny', '\x1b[31m', 'x'.repeat(2001)]) expect(() => terminalLaunchCommand('claude', prompt)).toThrow();
    expect(() => terminalLaunchCommand('sh', 'hello')).toThrow();
  });
});
