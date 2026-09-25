import { describe, it, expect } from 'vitest';
import { isBareShellTitle } from '../workspaceAgentRoster';

describe('isBareShellTitle', () => {
  it('recognises a tab still named after its shell', () => {
    for (const t of ['Bash', 'zsh', '-zsh', 'Zsh', 'sh', 'fish', 'pwsh', 'pwsh.exe', 'PowerShell', 'Windows PowerShell', 'cmd.exe', ' bash ']) {
      expect(isBareShellTitle(t)).toBe(true);
    }
  });

  it('keeps real titles, including ones that mention a shell', () => {
    for (const t of ['✳ Fix login flow', 'bash script review', 'zshrc cleanup', 'Claude Code', 'npm test']) {
      expect(isBareShellTitle(t)).toBe(false);
    }
  });
});
