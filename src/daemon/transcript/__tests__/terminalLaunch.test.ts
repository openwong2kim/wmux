import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { terminalLaunchCommand } from '../terminalLaunch';

describe('native launch instruction', () => {
  it('preserves shell metacharacters as one literal argument', () => {
    const prompt = "It's $HOME; $(echo injected) `echo nope` --help\nsecond line";
    const command = terminalLaunchCommand('codex', prompt);
    if (process.platform !== 'win32') {
      const output = execFileSync('/bin/sh', ['-c', 'codex() { printf "%s" "$2"; }; ' + command], { encoding: 'utf8' });
      expect(output).toBe(prompt);
    }
  });
  it('enables only the explicit provider-specific mode and rejects arbitrary flags', () => {
    expect(terminalLaunchCommand('claude', 'hello')).toBe("claude -- 'hello'");
    expect(terminalLaunchCommand('codex', 'hello', 'default')).toBe("codex -- 'hello'");
    expect(terminalLaunchCommand('claude', 'hello', 'bypass')).toBe("claude --dangerously-skip-permissions -- 'hello'");
    expect(terminalLaunchCommand('codex', 'hello', 'yolo')).toBe("codex --dangerously-bypass-approvals-and-sandbox -- 'hello'");
    for (const [agent, mode] of [['claude', 'yolo'], ['codex', 'bypass'], ['codex', '--arbitrary'], ['claude', true]]) {
      expect(() => terminalLaunchCommand(agent, 'hello', mode)).toThrow();
    }
  });
  it('rejects arbitrary launchers, terminal controls and empty instructions', () => {
    for (const prompt of ['', '  ', 'x\ry', '\x1b[31m', 'x'.repeat(2001)]) expect(() => terminalLaunchCommand('claude', prompt)).toThrow();
    expect(() => terminalLaunchCommand('sh', 'hello')).toThrow();
  });
});
